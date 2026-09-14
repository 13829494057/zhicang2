import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import authRouter, { oauthCallbackHandler } from './routes/auth.js';
import apiRouter from './routes/api.js';
import { createSessionId, saveSession } from './lib/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable('x-powered-by');

// 部署在 Render/Railway/Zeabur 等平台时，外层是反向代理：
// 不开启该项，req.protocol 永远是 http，Secure Cookie 不会下发，OAuth 登录态会丢。
app.set('trust proxy', 1);

app.use(cookieParser());
app.use(express.json());

/**
 * 根路径兜底接住 OAuth 回调。必须排在静态中间件之前，
 * 否则 express.static 会直接把 index.html 返回，回调参数被吞掉。
 *
 * 知乎开放平台登记的回调地址允许是裸域名（例如 http://127.0.0.1），
 * 此时授权码会带在根路径的 query 上而不是 /auth/zhihu/callback。
 * 只有识别到授权码参数时才交给回调处理器，否则照常走首页，
 * 这样两种登记方式都能跑通，不必强制改平台配置。
 */
app.get('/', (req, res, next) => {
  if (req.query.authorization_code || req.query.code) {
    return oauthCallbackHandler(req, res);
  }
  next();
});

// 静态资源
app.use(express.static(path.join(__dirname, '..', 'public')));

// 路由
app.use('/auth', authRouter);
app.use('/api', apiRouter);

// 配置健康检查：只回布尔值，绝不回显任何凭证内容
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    config: {
      appIdConfigured: Boolean(process.env.ZHIHU_APP_ID),
      appKeyConfigured: Boolean(process.env.ZHIHU_APP_KEY),
      accessSecretConfigured: Boolean(
        process.env.ZHIHU_ACCESS_SECRET &&
          !process.env.ZHIHU_ACCESS_SECRET.startsWith('请填入')
      ),
      redirectUri: process.env.ZHIHU_REDIRECT_URI || null,
    },
  });
});

// 三屏应用页
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

// 用户页
app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'profile.html'));
});

/**
 * 开发预览专用：注入一个以 Access Secret 本人身份读取数据的会话。
 * 仅当显式设置 ALLOW_DEV_LOGIN=1 时启用，用于本地 UI 走查。
 * 该会话不含 OAuth token，业务接口将以 Secret 本人身份返回数据。
 * 生产部署不要设置该变量。
 */
if (process.env.ALLOW_DEV_LOGIN === '1') {
  const devLogin = (req, res) => {
    const sid = createSessionId();
    saveSession(sid, {
      accessToken: null, // 无 OAuth token → 读 Secret 本人数据
      tokenExpiresAt: Date.now() + 3600 * 1000,
      profile: {
        uid: '0',
        hashId: 'dev-preview',
        fullname: '本机预览账号',
        gender: 'unknown',
        headline: '使用 Access Secret 本人身份的本地预览会话',
        description: '此会话仅用于本地 UI 走查，未经过 OAuth 授权流程。',
        avatarPath: '',
        url: '',
      },
    });
    res.cookie('zh_sid', sid, { httpOnly: true, sameSite: 'lax', path: '/' });
    if (req.method === 'GET') return res.redirect('/app');
    res.json({ ok: true, mode: 'dev-preview' });
  };
  app.post('/__dev/login', devLogin);
  app.get('/__dev/login', devLogin);
  console.log('[dev] /__dev/login 已启用（仅本地 UI 预览）');
}

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

const PORT = Number(process.env.PORT) || 3000;

// 云平台要求监听 0.0.0.0，只绑 127.0.0.1 会被判定为「端口未就绪」而部署失败。
// 本机调试仍可通过 HOST=127.0.0.1 保持原行为。
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`收藏夹考古 已启动: http://${HOST}:${PORT}`);
  if (!process.env.ZHIHU_ACCESS_SECRET || process.env.ZHIHU_ACCESS_SECRET.startsWith('请填入')) {
    console.warn('[warn] ZHIHU_ACCESS_SECRET 尚未配置，收藏夹/关注/创作接口将不可用');
  }
  if (process.env.ALLOW_DEV_LOGIN === '1') {
    console.warn('[warn] ALLOW_DEV_LOGIN 已开启，请勿在公网部署环境中使用');
  }
});

/**
 * 本机调试补充监听：当回调地址登记为不带端口的 http://127.0.0.1 时，
 * 浏览器会访问 80 端口。这里额外挂一个监听把授权码接回来。
 * 80 被占用或无权限时只告警，不影响主端口服务。
 */
const CALLBACK_PORT = 80;
if (PORT !== CALLBACK_PORT && /127\.0\.0\.1|localhost/.test(process.env.ZHIHU_REDIRECT_URI || '')) {
  const redirect = process.env.ZHIHU_REDIRECT_URI || '';
  const needsPort80 = !/127\.0\.0\.1:\d+|localhost:\d+/.test(redirect);
  if (needsPort80) {
    const aux = app.listen(CALLBACK_PORT, HOST, () => {
      console.log(`[oauth] 已补充监听 http://127.0.0.1:${CALLBACK_PORT}，用于接住授权回调`);
    });
    aux.on('error', (err) => {
      console.warn(
        `[warn] 80 端口监听失败（${err.code}）。` +
          `若登录回调打不开，请把回调地址改为 http://127.0.0.1:${PORT}/auth/zhihu/callback 并同步平台配置`
      );
    });
  }
}
