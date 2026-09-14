/**
 * OAuth 登录路由
 *
 * 三处最容易写错的地方，逐条钉死：
 *  1. 回调回传的字段名是 authorization_code，不是标准 OAuth 的 code
 *  2. token 交换接口的表单字段却叫 code，值取自第 1 步的 authorization_code
 *  3. 官方实测回调不返 state —— 因此关联性校验靠服务端 Cookie 兜底，
 *     不能仅依赖回调里的 state（拿不到）
 */

import express from 'express';
import {
  buildAuthorizeUrl,
  exchangeToken,
  fetchUserProfile,
  ZhihuApiError,
} from '../lib/zhihu.js';
import {
  createSessionId,
  createState,
  rememberState,
  consumeState,
  saveSession,
  getSession,
  destroySession,
} from '../lib/session.js';

const router = express.Router();

const STATE_COOKIE = 'zh_oauth_state';
const SID_COOKIE = 'zh_sid';

function cookieOpts(req, extra = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    path: '/',
    ...extra,
  };
}

/** 发起授权 */
router.get('/zhihu/start', (req, res) => {
  const { ZHIHU_APP_ID, ZHIHU_REDIRECT_URI } = process.env;

  if (!ZHIHU_APP_ID || !ZHIHU_REDIRECT_URI) {
    return res
      .status(503)
      .send(renderError('登录暂不可用', '服务端未配置 App ID 或回调地址。'));
  }

  const state = createState();
  const returnTo = typeof req.query.return_to === 'string' ? req.query.return_to : '/';
  rememberState(state, { returnTo });

  // 回调不返 state，用 HttpOnly Cookie 承载关联性
  res.cookie(STATE_COOKIE, state, cookieOpts(req, { maxAge: 10 * 60 * 1000 }));

  const url = buildAuthorizeUrl({
    appId: ZHIHU_APP_ID,
    redirectUri: ZHIHU_REDIRECT_URI,
    state,
  });
  res.redirect(url);
});

/** 授权回调 */
async function oauthCallbackHandler(req, res) {
  const { ZHIHU_APP_ID, ZHIHU_APP_KEY, ZHIHU_REDIRECT_URI } = process.env;

  // 兼容两种字段名，以 authorization_code 为实测主路径
  const code =
    (typeof req.query.authorization_code === 'string' && req.query.authorization_code) ||
    (typeof req.query.code === 'string' && req.query.code) ||
    null;

  if (!code) {
    // 用户取消授权时也会落到这里
    return res
      .status(400)
      .send(renderError('已取消授权', '没有收到授权码，你可以返回首页重新尝试。'));
  }

  // 关联性校验：优先用回调 state，拿不到就用 Cookie 里的
  const stateFromQuery = typeof req.query.state === 'string' ? req.query.state : null;
  const stateFromCookie = req.cookies?.[STATE_COOKIE] || null;
  const state = stateFromQuery || stateFromCookie;

  if (stateFromQuery && stateFromCookie && stateFromQuery !== stateFromCookie) {
    return res
      .status(400)
      .send(renderError('登录请求校验失败', '授权状态不匹配，请重新发起登录。'));
  }

  const pending = consumeState(state);
  res.clearCookie(STATE_COOKIE, cookieOpts(req));

  if (!pending) {
    return res
      .status(400)
      .send(
        renderError(
          '登录请求已失效',
          '授权状态缺失、过期或已被使用过，请返回首页重新登录。'
        )
      );
  }

  try {
    const token = await exchangeToken({
      appId: ZHIHU_APP_ID,
      appKey: ZHIHU_APP_KEY,
      redirectUri: ZHIHU_REDIRECT_URI,
      code,
    });

    const profile = await fetchUserProfile(token.accessToken);

    const sid = createSessionId();
    saveSession(sid, {
      accessToken: token.accessToken,
      tokenExpiresAt: Date.now() + token.expiresIn * 1000,
      profile,
    });

    res.cookie(SID_COOKIE, sid, cookieOpts(req, { maxAge: 60 * 60 * 1000 }));
    res.redirect(pending.returnTo || '/');
  } catch (err) {
    console.error('[oauth] 登录失败:', err.message);

    // 不回显任何错误细节，改为给出用户可自查的三条
    return res.status(502).send(
      renderError(
        '登录失败',
        `
        <p>请按以下三点自查后重试：</p>
        <ol>
          <li>知乎账号需<strong>绑定手机号并完成实名认证</strong>，这是 OAuth 校验的前提</li>
          <li>需要在知乎页面内<strong>完成授权确认</strong>，中途关闭会导致失败</li>
          <li>网络超时可稍后<strong>重试一次</strong></li>
        </ol>`
      )
    );
  }
}

router.get('/zhihu/callback', oauthCallbackHandler);

/** 当前登录态 */
router.get('/me', (req, res) => {
  const s = getSession(req.cookies?.[SID_COOKIE]);
  if (!s) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, profile: s.profile });
});

/** 退出并清除 */
router.post('/logout', (req, res) => {
  destroySession(req.cookies?.[SID_COOKIE]);
  res.clearCookie(SID_COOKIE, cookieOpts(req));
  res.json({ ok: true });
});

function renderError(title, bodyHtml) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f6f7f9;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1a1a1a}
  .box{max-width:520px;background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:32px 36px}
  h1{margin:0 0 14px;font-size:20px}
  ol{margin:10px 0 0;padding-left:20px} li{margin:6px 0}
  a{display:inline-block;margin-top:22px;color:#0066ff;text-decoration:none}
</style></head>
<body><div class="box"><h1>${title}</h1>${bodyHtml}<a href="/">← 返回首页</a></div></body></html>`;
}

export default router;
export { SID_COOKIE, oauthCallbackHandler };
