/**
 * 仅用于本地 UI 验证：注入一个使用真实 Access Secret 本人身份的会话，
 * 以便在没有完成 OAuth 授权的情况下预览登录态页面。
 *
 * 注意：此脚本只在 NODE_ENV !== 'production' 且显式设置 ALLOW_DEV_LOGIN=1 时可用。
 * 生产部署请勿开启。
 */
import 'dotenv/config';

const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
const res = await fetch(`${base}/__dev/login`, { method: 'POST' });
const text = await res.text();
console.log(res.status, text);
const cookie = res.headers.get('set-cookie');
console.log('cookie:', cookie ? cookie.split(';')[0] : '(none)');
