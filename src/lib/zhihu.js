/**
 * 知乎开放平台 API 客户端
 *
 * 两个域，鉴权方式与成功判据都不同，不可混用：
 *
 *  openapi.zhihu.com     —— OAuth 域
 *    · POST /access_token  换取 token
 *    · GET  /user          授权用户基础信息
 *    · 鉴权：Authorization: Bearer <oauth_access_token>
 *    · 成功判据：响应含 access_token / 用户对象；业务字段 code=20000 表示成功
 *
 *  developer.zhihu.com   —— 用户数据域
 *    · GET /api/v1/user/...
 *    · 鉴权：Authorization: Bearer <access_secret>
 *             + X-OAuth-Token: <oauth_access_token>   （代表其他用户时）
 *             + X-Request-Timestamp: <unix 秒>
 *    · 成功判据：Code === 0
 */

const OPENAPI_BASE = 'https://openapi.zhihu.com';
const DEVELOPER_BASE = 'https://developer.zhihu.com';

/** developer 域业务错误码 */
export const DEV_CODE = {
  OK: 0,
  BAD_PARAM: 10001,
  AUTH_FAILED: 20001,
  RATE_LIMITED: 30001,
  QUOTA_EXCEEDED: 30002,
  INTERNAL: 90001,
};

export class ZhihuApiError extends Error {
  constructor(message, { domain, code, httpStatus, retriable = false } = {}) {
    super(message);
    this.name = 'ZhihuApiError';
    this.domain = domain;
    this.code = code;
    this.httpStatus = httpStatus;
    this.retriable = retriable;
  }
}

/**
 * uid 可能超过 JS 安全整数范围，必须在 JSON 解析阶段无损处理。
 * 做法：先把裸数字形态的 uid 用正则替换为字符串，再 JSON.parse。
 * 不能先 parse 成 Number 再 toString —— 那样已经丢精度了。
 */
function parseJsonPreservingBigIds(text, bigIntFields = ['uid']) {
  let patched = text;
  for (const field of bigIntFields) {
    const re = new RegExp(`("${field}"\\s*:\\s*)(-?\\d{16,})`, 'g');
    patched = patched.replace(re, '$1"$2"');
  }
  return JSON.parse(patched);
}

/** 统一超时的 fetch */
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── OAuth 域 ─────────────────────────

/** 构造授权页 URL。redirect_uri 必须 URL 编码且与登记值完全一致 */
export function buildAuthorizeUrl({ appId, redirectUri, state }) {
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    app_id: appId,
    response_type: 'code',
  });
  // 官方实测回调不返 state，但仍按协议发送；本地用 Cookie 兜底关联性校验
  if (state) params.set('state', state);
  return `${OPENAPI_BASE}/authorize?${params.toString()}`;
}

/**
 * 用授权码换取 access_token
 * 注意字段名两头不一致：回调回传 authorization_code，token 接口表单字段却叫 code
 */
export async function exchangeToken({ appId, appKey, redirectUri, code }) {
  const body = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });

  const res = await fetchWithTimeout(`${OPENAPI_BASE}/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ZhihuApiError('token 接口返回非 JSON', {
      domain: 'openapi',
      httpStatus: res.status,
    });
  }

  // 优先检查 access_token 是否存在，不把 code=20000 当错误
  if (!json.access_token) {
    throw new ZhihuApiError(json.message || json.data || 'token 交换失败', {
      domain: 'openapi',
      code: json.code,
      httpStatus: res.status,
    });
  }

  return {
    accessToken: json.access_token,
    tokenType: json.token_type || 'Bearer',
    expiresIn: Number(json.expires_in) || 3600,
  };
}

/** 获取授权用户基础信息。只用 OAuth token，不需要 Access Secret */
export async function fetchUserProfile(accessToken) {
  const res = await fetchWithTimeout(`${OPENAPI_BASE}/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const text = await res.text();
  let json;
  try {
    json = parseJsonPreservingBigIds(text, ['uid']);
  } catch {
    throw new ZhihuApiError('用户信息接口返回非 JSON', {
      domain: 'openapi',
      httpStatus: res.status,
    });
  }

  // 同时检查 HTTP 状态与响应内容，不能只凭 HTTP 200 判断成功
  const hasIdentity = json && (json.uid || json.hash_id);
  if (!hasIdentity) {
    throw new ZhihuApiError(
      typeof json?.data === 'string' ? json.data : '未获取到有效用户标识',
      { domain: 'openapi', code: json?.code, httpStatus: res.status }
    );
  }

  return {
    uid: String(json.uid ?? ''),
    hashId: json.hash_id ?? '',
    fullname: json.fullname ?? '',
    gender: json.gender ?? 'unknown',
    headline: json.headline ?? '',
    description: json.description ?? '',
    avatarPath: json.avatar_path ?? '',
    url: json.url ?? '',
  };
}

// ─────────────────────── 用户数据域 ───────────────────────

/**
 * 调用 developer 域列表接口
 * @param {string} path            形如 /api/v1/user/favlists
 * @param {object} query           Query 参数
 * @param {string} accessSecret    开放平台 Access Secret（必传）
 * @param {string} [oauthToken]    代表其他用户时传入；不传则读 Secret 本人
 */
export async function callUserDataApi(path, query, { accessSecret, oauthToken } = {}) {
  if (!accessSecret) {
    throw new ZhihuApiError('缺少 Access Secret，无法调用用户数据 API', {
      domain: 'developer',
    });
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }

  const headers = {
    Authorization: `Bearer ${accessSecret}`,
    'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
    'Content-Type': 'application/json',
  };
  if (oauthToken) headers['X-OAuth-Token'] = oauthToken;

  const url = `${DEVELOPER_BASE}${path}${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetchWithTimeout(url, { headers });

  const text = await res.text();
  let json;
  try {
    // UrlToken、uid 等 Int64 字段同样需要无损解析
    json = parseJsonPreservingBigIds(text, ['UrlToken', 'uid', 'Totals']);
  } catch {
    throw new ZhihuApiError('用户数据接口返回非 JSON', {
      domain: 'developer',
      httpStatus: res.status,
    });
  }

  // developer 域判据：Code === 0
  if (json.Code !== DEV_CODE.OK) {
    const retriable = json.Code === DEV_CODE.RATE_LIMITED;
    throw new ZhihuApiError(json.Message || `业务错误 ${json.Code}`, {
      domain: 'developer',
      code: json.Code,
      httpStatus: res.status,
      retriable,
    });
  }

  return json.Data ?? {};
}

/**
 * NextOffset 声明为 String 但语义是数字，必须严格解析，不静默截断
 * @returns {number|null} 解析失败或不存在返回 null
 */
export function parseNextOffset(paging) {
  if (!paging || paging.IsEnd) return null;
  const raw = paging.NextOffset;
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new ZhihuApiError(`NextOffset 不是合法整数: ${s}`, {
      domain: 'developer',
    });
  }
  return Number(s);
}

/** 带退避的重试：仅对 30001 频率限制重试 */
export async function withRetry(fn, { retries = 2, baseDelayMs = 600 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ZhihuApiError) || !err.retriable) throw err;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr;
}
