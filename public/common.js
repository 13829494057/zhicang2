/** 公共工具：顶栏渲染、登录态、请求封装 */

export async function getMe() {
  try {
    const res = await fetch('/auth/me', { credentials: 'same-origin' });
    return await res.json();
  } catch {
    return { loggedIn: false };
  }
}

export async function apiGet(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const err = new Error(json.message || '请求失败');
    err.code = json.error;
    err.status = res.status;
    throw err;
  }
  return json;
}

export async function logout() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/';
}

/** 渲染右上角用户区：未登录显示登录按钮，已登录显示头像 + 昵称 */
export function renderUserArea(el, me) {
  if (!me.loggedIn) {
    // 首页 hero 已有主 CTA，顶栏不再重复放登录按钮；其他页保留次要入口
    const isHome = location.pathname === '/' || location.pathname === '/index.html';
    el.innerHTML = isHome
      ? `<a class="btn ghost sm" href="/privacy.html">隐私说明</a>`
      : `<a class="btn ghost sm" href="/auth/zhihu/start?return_to=${encodeURIComponent(
          location.pathname
        )}">登录</a>`;
    return;
  }

  const p = me.profile;
  const avatar = p.avatarPath || fallbackAvatar(p.fullname);

  el.innerHTML = `
    <button class="avatar-btn" id="avatarBtn" title="进入个人主页">
      <img class="avatar" src="${escapeAttr(avatar)}" alt="${escapeAttr(p.fullname)}"
           onerror="this.src='${fallbackAvatar(p.fullname)}'">
      <span class="avatar-name">${escapeHtml(p.fullname || '知乎用户')}</span>
    </button>
    <button class="btn ghost sm" id="logoutBtn">退出</button>
  `;

  el.querySelector('#avatarBtn').addEventListener('click', () => {
    location.href = '/profile';
  });
  el.querySelector('#logoutBtn').addEventListener('click', logout);
}

/** 无头像时用首字母生成一个 SVG 占位图 */
export function fallbackAvatar(name = '') {
  const ch = (name || '知').trim().charAt(0) || '知';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">
    <rect width="80" height="80" fill="#e9edf2"/>
    <text x="50%" y="54%" font-size="34" fill="#8590a6"
          text-anchor="middle" dominant-baseline="middle"
          font-family="sans-serif">${ch}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function escapeAttr(s = '') {
  return escapeHtml(s);
}

/** 秒级时间戳 → YYYY-MM-DD */
export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 距今多久 */
export function fmtAgo(ts) {
  if (!ts) return '';
  const months = Math.floor((Date.now() / 1000 - ts) / (30 * 86400));
  if (months < 1) return '近一个月内';
  if (months < 12) return `${months} 个月前`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return m ? `${y} 年 ${m} 个月前` : `${y} 年前`;
}

const TYPE_LABEL = {
  answer: '回答', article: '文章', zvideo: '视频',
  pin: '想法', question: '问题',
};
export function typeLabel(t) {
  return TYPE_LABEL[t] || t || '内容';
}

/** 统一的错误态渲染，区分「需要重新登录」和其他失败 */
export function renderError(el, err) {
  if (err.code === 'not_logged_in' || err.code === 'token_expired' || err.code === 'auth_failed') {
    el.innerHTML = `<div class="state">
      <strong>登录已失效</strong>
      请重新授权后查看
      <div style="margin-top:14px">
        <a class="btn" href="/auth/zhihu/start?return_to=${encodeURIComponent(location.pathname)}">重新登录</a>
      </div>
    </div>`;
    return;
  }
  el.innerHTML = `<div class="state"><strong>${escapeHtml(
    err.message || '加载失败'
  )}</strong>稍后重试，或返回首页</div>`;
}

export function skeleton(n = 3) {
  return Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
}
