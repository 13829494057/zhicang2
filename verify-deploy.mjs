/**
 * 上线自检脚本
 *
 * 用法：node scripts/verify-deploy.mjs https://你的域名
 *
 * 逐项验证公网部署是否真的可用。每项都是"可能失败"的真实请求，
 * 不是本地假设。任一项 FAIL 都不要去赛事页面填回调地址。
 */

const base = (process.argv[2] || '').replace(/\/+$/, '');

if (!base) {
  console.error('用法: node scripts/verify-deploy.mjs https://你的域名');
  process.exit(1);
}

if (!base.startsWith('https://')) {
  console.error('✗ 必须是 https:// 开头。知乎 OAuth 回调要求 HTTPS，http 走不通。');
  process.exit(1);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? `\n         ${detail}` : ''}`);
}

async function get(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000); // 冷启动可能要 60s+
  try {
    return await fetch(base + path, { redirect: 'manual', signal: ctrl.signal, ...opts });
  } finally {
    clearTimeout(timer);
  }
}

console.log(`\n目标: ${base}\n${'─'.repeat(60)}`);

// 1. 健康检查 + 环境变量是否真的注入
try {
  const t0 = Date.now();
  const res = await get('/api/health');
  const ms = Date.now() - t0;
  const json = await res.json();
  const c = json.config || {};

  record('服务可达 /api/health', res.status === 200, `HTTP ${res.status}，耗时 ${ms}ms${ms > 15000 ? '（首次访问含冷启动，属正常）' : ''}`);
  record('ZHIHU_APP_ID 已注入', c.appIdConfigured === true, c.appIdConfigured ? '' : '平台环境变量里没配 ZHIHU_APP_ID');
  record('ZHIHU_APP_KEY 已注入', c.appKeyConfigured === true, c.appKeyConfigured ? '' : '平台环境变量里没配 ZHIHU_APP_KEY');
  record('ZHIHU_ACCESS_SECRET 已注入', c.accessSecretConfigured === true, c.accessSecretConfigured ? '' : '没配 Secret，收藏夹接口会全部返回空');

  // 回调地址必须与当前域名一致，这是最容易错的一项
  const expected = `${base}/auth/zhihu/callback`;
  const actual = c.redirectUri || '';
  record(
    'ZHIHU_REDIRECT_URI 与当前域名匹配',
    actual === expected,
    actual === expected ? actual : `期望 ${expected}\n         实际 ${actual || '(未配置)'}  ← 不一致，OAuth 必定失败`
  );
} catch (e) {
  record('服务可达 /api/health', false, `请求失败: ${e.message}`);
}

// 2. 三个页面
for (const [path, label] of [['/', '首页'], ['/app', '应用页 /app'], ['/profile', '用户页 /profile']]) {
  try {
    const res = await get(path);
    const body = res.status === 200 ? await res.text() : '';
    const isHtml = body.includes('<html') || body.includes('<!DOCTYPE') || body.includes('<div');
    record(`${label} 返回 HTML`, res.status === 200 && isHtml, `HTTP ${res.status}${res.status === 200 && !isHtml ? '，但返回内容不是 HTML' : ''}`);
  } catch (e) {
    record(`${label} 返回 HTML`, false, e.message);
  }
}

// 3. 静态资源（CSS 挂了页面会裸奔）
try {
  const res = await get('/style.css');
  record('静态资源 /style.css', res.status === 200, `HTTP ${res.status}`);
} catch (e) {
  record('静态资源 /style.css', false, e.message);
}

// 4. OAuth 起跳：必须 302 到 openapi.zhihu.com，且 redirect_uri 编码正确
try {
  const res = await get('/auth/zhihu/start');
  const loc = res.headers.get('location') || '';
  const is302 = res.status === 302 || res.status === 301;
  const toZhihu = loc.startsWith('https://openapi.zhihu.com/authorize');
  record('OAuth 起跳 302 到知乎', is302 && toZhihu, is302 ? loc.slice(0, 120) : `HTTP ${res.status}（503 通常表示 APP_ID 或回调地址没配）`);

  if (toZhihu) {
    const u = new URL(loc);
    const ru = u.searchParams.get('redirect_uri') || '';
    const expected = `${base}/auth/zhihu/callback`;
    record('授权链接里的 redirect_uri 正确', ru === expected, ru === expected ? ru : `期望 ${expected}\n         实际 ${ru}`);
    record('授权链接携带 app_id', Boolean(u.searchParams.get('app_id')), `app_id=${u.searchParams.get('app_id') || '(缺失)'}`);
  }

  // state Cookie 必须下发，否则回调阶段会判定"登录请求已失效"
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const stateCookie = sc.find((s) => s.includes('zh_oauth_state'));
  const hasSecure = stateCookie ? /secure/i.test(stateCookie) : false;
  record('下发 zh_oauth_state Cookie', Boolean(stateCookie), stateCookie ? stateCookie.split(';')[0] : '未下发，回调会报「登录请求已失效」');
  record('Cookie 带 Secure 标记（trust proxy 生效）', hasSecure, hasSecure ? '' : '未带 Secure：说明 req.protocol 不是 https，检查平台是否为 HTTPS 入口');
} catch (e) {
  record('OAuth 起跳 302 到知乎', false, e.message);
}

// 5. 未登录时业务接口必须拒绝，不能泄露开发者本人数据
try {
  const res = await get('/api/favlists');
  const ok = res.status === 401 || res.status === 403;
  record('未登录访问 /api/favlists 被拒绝', ok, `HTTP ${res.status}${ok ? '' : ' ← 未登录竟能拿到数据，存在越权风险'}`);
} catch (e) {
  record('未登录访问 /api/favlists 被拒绝', false, e.message);
}

// 6. 开发后门必须关闭
try {
  const res = await get('/__dev/login');
  const closed = res.status === 404;
  record('开发后门 /__dev/login 已关闭', closed, closed ? '' : `HTTP ${res.status} ← 必须删掉平台上的 ALLOW_DEV_LOGIN 变量！否则访客会看到你本人的收藏夹`);
} catch (e) {
  record('开发后门 /__dev/login 已关闭', false, e.message);
}

// 汇总
const failed = results.filter((r) => !r.ok);
console.log('─'.repeat(60));
console.log(`结果: ${results.length - failed.length}/${results.length} 项通过`);

if (failed.length === 0) {
  console.log('\n全部通过。现在可以去赛事页面填回调地址：');
  console.log(`  ${base}/auth/zhihu/callback`);
  console.log('\n填完后务必用无痕窗口 + 别人的账号真实走一遍登录。');
} else {
  console.log(`\n以下 ${failed.length} 项未通过，修好再去填回调地址：`);
  failed.forEach((r) => console.log(`  ✗ ${r.name}`));
  process.exitCode = 1;
}
console.log('');
