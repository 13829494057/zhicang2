/**
 * 会话存储
 *
 * 硬性要求：OAuth token 只留在服务端，浏览器仅持有随机 sid（HttpOnly + Secure Cookie）。
 * 常驻单进程 Demo 用进程内 Map 即可；多实例或 Serverless 部署需换共享存储。
 */

import crypto from 'node:crypto';

const TTL_MS = 60 * 60 * 1000; // 与 OAuth token 的 3600 秒对齐
const MAX_SESSIONS = 200; // LRU 上限，防止访客一多就 OOM

const sessions = new Map();

export function createSessionId() {
  return crypto.randomBytes(24).toString('hex');
}

export function createState() {
  return crypto.randomBytes(16).toString('hex');
}

function evictIfNeeded() {
  // 先清过期
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(sid);
  }
  // 再按插入顺序淘汰最旧的（Map 保持插入序）
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export function saveSession(sid, data) {
  evictIfNeeded();
  sessions.set(sid, {
    ...data,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function getSession(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(sid);
    return null;
  }
  // 触碰即刷新 LRU 位置
  sessions.delete(sid);
  sessions.set(sid, s);
  return s;
}

export function updateSession(sid, patch) {
  const s = getSession(sid);
  if (!s) return null;
  const next = { ...s, ...patch };
  sessions.set(sid, next);
  return next;
}

export function destroySession(sid) {
  if (sid) sessions.delete(sid);
}

export function sessionCount() {
  return sessions.size;
}

/** 待完成授权的 state，短时有效 */
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

export function rememberState(state, payload = {}) {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (v.expiresAt <= now) pendingStates.delete(k);
  }
  pendingStates.set(state, { ...payload, expiresAt: now + STATE_TTL_MS });
}

/** 原子消费：取出即删除，杜绝重放 */
export function consumeState(state) {
  if (!state) return null;
  const v = pendingStates.get(state);
  pendingStates.delete(state);
  if (!v || v.expiresAt <= Date.now()) return null;
  return v;
}
