/**
 * 额度限流与熔断（方案文档第四十四节）
 *
 * 背景：user_data 实测日额度仅 1,000 次，所有访客共用开发者一个池子。
 * 人气奖鼓励把链接发给尽可能多的人，而每人扫一次都在花公共预算 ——
 * 必须在设计层解决，不能靠运气。
 *
 * 三道闸：
 *   1. 会话级节流：同一会话 10 分钟内复用快照（在 api.js 的 SCAN_TTL 实现）
 *   2. 全局令牌桶 + 并发闸：限每秒出手 + 同时扫描数
 *   3. 按剩余额度三级熔断：> 30% 全功能 / 10–30% 关 L2 / 3–10% 限流 / < 3% 降级
 */

// ── 全局令牌桶：限制每秒发起的扫描数 ──
const bucket = {
  capacity: 3,      // 桶容量
  tokens: 3,
  refillPerSec: 1,  // 每秒回补 1 个
  last: Date.now(),
};

function refill() {
  const now = Date.now();
  const add = ((now - bucket.last) / 1000) * bucket.refillPerSec;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + add);
  bucket.last = now;
}

export function takeToken() {
  refill();
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

// ── 并发闸：同时进行的深挖扫描数 ──
let running = 0;
const MAX_CONCURRENT = 3;

export function acquireSlot() {
  if (running >= MAX_CONCURRENT) return false;
  running += 1;
  return true;
}
export function releaseSlot() {
  running = Math.max(0, running - 1);
}
export function queueLength() {
  return Math.max(0, running - MAX_CONCURRENT);
}
export function runningCount() {
  return running;
}

// ── 额度熔断：读 quota 的 user_data 剩余比例决定档位 ──
let quotaCache = { at: 0, remaining: null, total: null };
const QUOTA_TTL = 60 * 1000; // quota 查询本身也可能计费，缓存 60 秒

/**
 * 查询 user_data 剩余额度。失败时返回 null（视为未知，按保守档处理）。
 */
export async function fetchQuota(accessSecret) {
  if (Date.now() - quotaCache.at < QUOTA_TTL && quotaCache.remaining !== null) {
    return quotaCache;
  }
  try {
    const res = await fetch('https://developer.zhihu.com/api/v1/quota', {
      headers: {
        Authorization: `Bearer ${accessSecret}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      },
    });
    const json = await res.json();
    const arr = Array.isArray(json.Data) ? json.Data : [];
    const u = arr.find((x) => x.APIID === 'user_data');
    if (u) {
      quotaCache = {
        at: Date.now(),
        remaining: Number(u.RemainingQuota),
        total: Number(u.TotalQuota),
      };
    }
  } catch {
    // 查询失败：保留旧值或 null
  }
  return quotaCache;
}

/**
 * 三级熔断档位。阈值按 1,000 基数重定（文档 44.4）。
 * @returns {{tier:'full'|'l1only'|'throttle'|'degraded', remaining, total, pct}}
 */
export function circuitTier(quota) {
  const { remaining, total } = quota || {};
  if (remaining === null || remaining === undefined || !total) {
    // 额度未知：保守起见只开 L1
    return { tier: 'l1only', remaining: null, total: null, pct: null };
  }
  const pct = remaining / total;
  let tier;
  if (pct > 0.3) tier = 'full';
  else if (pct > 0.1) tier = 'l1only';
  else if (pct > 0.03) tier = 'throttle';
  else tier = 'degraded';
  return { tier, remaining, total, pct };
}
