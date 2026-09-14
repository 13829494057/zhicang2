/**
 * 业务 API 路由
 *
 * 所有接口都要求已登录。调用用户数据 API 时同时带：
 *   Authorization: Bearer <Access Secret>   —— 鉴权开发者（额度算在这里）
 *   X-OAuth-Token: <用户 access_token>      —— 指明代表哪个用户
 *
 * 红线：token 失效时停止读取，绝不回落到 Access Secret 本人账号，
 *       否则访客会看到开发者自己的数据。
 */

import express from 'express';
import {
  callUserDataApi,
  parseNextOffset,
  withRetry,
  ZhihuApiError,
  DEV_CODE,
} from '../lib/zhihu.js';
import { scanPreview, scanFull, buildReport } from '../lib/scan.js';
import { getSession, updateSession } from '../lib/session.js';
import { SID_COOKIE } from './auth.js';
import {
  takeToken, acquireSlot, releaseSlot, runningCount,
  fetchQuota, circuitTier,
} from '../lib/ratelimit.js';

const router = express.Router();

/** 登录守卫 */
function requireLogin(req, res, next) {
  const s = getSession(req.cookies?.[SID_COOKIE]);
  if (!s) {
    return res.status(401).json({
      ok: false,
      error: 'not_logged_in',
      message: '请先使用知乎账号登录',
    });
  }
  if (s.tokenExpiresAt && s.tokenExpiresAt <= Date.now()) {
    return res.status(401).json({
      ok: false,
      error: 'token_expired',
      message: '登录已过期，请重新授权',
    });
  }
  req.zhSession = s;
  next();
}

/** 统一错误响应：业务码映射为用户可读文案，不暴露原始 Code */
function sendApiError(res, err) {
  if (err instanceof ZhihuApiError && err.domain === 'developer') {
    switch (err.code) {
      case DEV_CODE.AUTH_FAILED:
        return res.status(401).json({
          ok: false,
          error: 'auth_failed',
          message: '登录已失效，请重新授权',
        });
      case DEV_CODE.RATE_LIMITED:
        return res.status(429).json({
          ok: false,
          error: 'rate_limited',
          message: '请求过于频繁，请稍后再试',
        });
      case DEV_CODE.QUOTA_EXCEEDED:
        return res.status(503).json({
          ok: false,
          error: 'quota_exceeded',
          message: '今日接口额度已用完，明天再来',
        });
      case DEV_CODE.BAD_PARAM:
        return res
          .status(400)
          .json({ ok: false, error: 'bad_param', message: '请求参数有误' });
      default:
        break;
    }
  }
  console.error('[api] 调用失败:', err.message);
  return res
    .status(502)
    .json({ ok: false, error: 'upstream_error', message: '数据获取失败，请稍后重试' });
}

/** 构造调用上下文 */
function ctx(req) {
  return {
    accessSecret: process.env.ZHIHU_ACCESS_SECRET,
    oauthToken: req.zhSession.accessToken,
  };
}

function clampLimit(raw, def = 20, max = 50) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, 1), max);
}

function parseOffset(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 归一化分页信息给前端 */
function normalizePaging(paging) {
  let nextOffset = null;
  try {
    nextOffset = parseNextOffset(paging);
  } catch {
    // NextOffset 非法：停止自动翻页并如实告知分页信息不完整
    return { isEnd: true, nextOffset: null, totals: paging?.Totals ?? null, incomplete: true };
  }
  return {
    isEnd: Boolean(paging?.IsEnd) || nextOffset === null,
    nextOffset,
    totals: paging?.Totals ?? null,
    incomplete: false,
  };
}

// ───────────────────── 收藏夹列表 ─────────────────────
// 注意：该接口无 Paging、会忽略 Offset，Limit 上限 50。
// 收藏夹超过 50 个的用户物理上无法穷举，页面必须如实标注。
router.get('/favlists', requireLogin, async (req, res) => {
  const limit = clampLimit(req.query.limit, 50, 50);
  try {
    const data = await withRetry(() =>
      callUserDataApi('/api/v1/user/favlists', { Limit: limit }, ctx(req))
    );
    const items = (data.Items || []).map((it) => ({
      urlToken: String(it.UrlToken ?? ''),
      title: it.Title ?? '',
      description: it.Description ?? '',
      url: it.Url ?? '',
      isPublic: Boolean(it.IsPublic),
    }));
    res.json({
      ok: true,
      items,
      // 协议上限提示：取满 50 条说明可能被截断
      truncated: items.length >= 50,
      note: '仅包含公开范围内的收藏夹；该接口无分页，最多返回 50 个',
    });
  } catch (err) {
    sendApiError(res, err);
  }
});

// ───────────────────── 收藏夹内容 ─────────────────────
router.get('/favlists/:urlToken/items', requireLogin, async (req, res) => {
  const { urlToken } = req.params;
  if (!/^\d+$/.test(urlToken)) {
    return res
      .status(400)
      .json({ ok: false, error: 'bad_param', message: '收藏夹标识无效' });
  }
  const limit = clampLimit(req.query.limit, 20, 50);
  const offset = parseOffset(req.query.offset);

  try {
    const data = await withRetry(() =>
      callUserDataApi(
        '/api/v1/user/favlist_contents',
        { FavlistUrlToken: urlToken, Offset: offset, Limit: limit },
        ctx(req)
      )
    );
    res.json({
      ok: true,
      items: (data.Items || []).map(mapCollectionItem),
      paging: normalizePaging(data.Paging),
    });
  } catch (err) {
    sendApiError(res, err);
  }
});

// ───────────────────── 近期收藏 ─────────────────────
// 无 Offset、无 Paging，一次最多 50 条，不等于完整收藏历史
router.get('/collections', requireLogin, async (req, res) => {
  const limit = clampLimit(req.query.limit, 50, 50);
  try {
    const data = await withRetry(() =>
      callUserDataApi('/api/v1/user/collections', { Limit: limit }, ctx(req))
    );
    res.json({
      ok: true,
      items: (data.Items || []).map(mapCollectionItem),
      note: '基于近期收藏，不等于完整收藏历史',
    });
  } catch (err) {
    sendApiError(res, err);
  }
});

// ───────────────────── 关注的人 ─────────────────────
router.get('/followees', requireLogin, async (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 50);
  const offset = parseOffset(req.query.offset);
  try {
    const data = await withRetry(() =>
      callUserDataApi('/api/v1/user/followees', { Offset: offset, Limit: limit }, ctx(req))
    );
    res.json({
      ok: true,
      items: (data.Items || []).map((it) => ({
        fullname: it.Fullname ?? '',
        urlToken: it.UrlToken ?? '',
        url: it.Url ?? '',
        avatarUrl: it.AvatarUrl ?? '',
        headline: it.Headline ?? '',
        gender: Number(it.Gender ?? 0),
        followerCount: Number(it.FollowerCount ?? 0),
      })),
      paging: normalizePaging(data.Paging),
    });
  } catch (err) {
    sendApiError(res, err);
  }
});

// ───────────────────── 创作内容 ─────────────────────
router.get('/contents', requireLogin, async (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 50);
  const offset = parseOffset(req.query.offset);
  const allowedTypes = ['all', 'answer', 'article', 'zvideo', 'pin', 'question'];
  const contentType = allowedTypes.includes(req.query.type) ? req.query.type : 'all';
  const sortField = ['ts', 'like_count'].includes(req.query.sort) ? req.query.sort : 'ts';
  const sortOrder = ['asc', 'desc'].includes(req.query.order) ? req.query.order : 'desc';

  try {
    const data = await withRetry(() =>
      callUserDataApi(
        '/api/v1/user/contents',
        {
          ContentType: contentType,
          Offset: offset,
          Limit: limit,
          SortField: sortField,
          SortOrder: sortOrder,
        },
        ctx(req)
      )
    );
    res.json({
      ok: true,
      items: (data.Items || []).map((it) => ({
        contentType: it.ContentType ?? '',
        title: it.Title ?? '',
        summary: it.Summary ?? '',
        url: it.Url ?? '',
        createdAt: Number(it.CreatedAt ?? 0),
        likeCount: Number(it.LikeCount ?? 0),
        commentCount: Number(it.CommentCount ?? 0),
        favoriteCount: Number(it.FavoriteCount ?? 0),
      })),
      paging: normalizePaging(data.Paging),
    });
  } catch (err) {
    sendApiError(res, err);
  }
});

// ═══════════════════ 三屏：扫描与报告 ═══════════════════

const SCAN_TTL_MS = 10 * 60 * 1000; // 官方四处强调"务必在应用层做缓存"

/**
 * L1 速览：1 次请求，登录后自动执行
 * 产出偏好分布 + 动机分型 + 今天读这篇（不含地层剖面全量结论）
 */
router.get('/preview', requireLogin, async (req, res) => {
  const sid = req.cookies[SID_COOKIE];
  const cached = req.zhSession.previewCache;
  if (cached && Date.now() - cached.at < SCAN_TTL_MS) {
    return res.json({ ok: true, cached: true, report: cached.report });
  }
  try {
    // 熔断：< 3% 额度时连速览都停，走降级
    const quota = await fetchQuota(process.env.ZHIHU_ACCESS_SECRET);
    const circuit = circuitTier(quota);
    if (circuit.tier === 'degraded') {
      return res.status(503).json({
        ok: false, error: 'quota_low',
        message: '今日体验名额已满，明天再来',
        circuit,
      });
    }
    // 全局令牌桶：限制每秒发起的扫描数
    if (!takeToken()) {
      return res.status(429).json({
        ok: false, error: 'busy', message: '当前访问的人有点多，请稍等几秒重试',
      });
    }
    const scan = await scanPreview(ctx(req));
    const report = buildReport(scan);
    report.circuit = circuit; // 把额度档位带给前端做角标
    updateSession(sid, { previewCache: { at: Date.now(), report, scan } });
    res.json({ ok: true, cached: false, report });
  } catch (err) {
    sendApiError(res, err);
  }
});

/**
 * L2 深挖：逐夹遍历，请求数硬上限 40
 * 补齐地层剖面与腐坏度全量结论
 */
router.get('/scan', requireLogin, async (req, res) => {
  const sid = req.cookies[SID_COOKIE];
  const cached = req.zhSession.scanCache;
  if (cached && Date.now() - cached.at < SCAN_TTL_MS) {
    return res.json({ ok: true, cached: true, report: cached.report });
  }
  // L2 深挖成本高（≤40 次请求），额度不足 30% 时关闭，只保留速览
  const quota = await fetchQuota(process.env.ZHIHU_ACCESS_SECRET);
  const circuit = circuitTier(quota);
  if (circuit.tier !== 'full') {
    return res.status(503).json({
      ok: false, error: 'l2_closed',
      message: '深挖名额今日已用完，速览仍可用',
      circuit,
    });
  }
  // 并发闸：同时深挖数 ≤ 3，其余排队
  if (!acquireSlot()) {
    return res.status(429).json({
      ok: false, error: 'busy',
      message: `前面还有 ${runningCount()} 人在深挖，请稍后重试`,
    });
  }
  try {
    const scan = await scanFull(ctx(req));
    const report = buildReport(scan);
    report.circuit = circuit;
    updateSession(sid, { scanCache: { at: Date.now(), report, scan } });
    res.json({ ok: true, cached: false, report });
  } catch (err) {
    sendApiError(res, err);
  } finally {
    releaseSlot();
  }
});

/**
 * 换一篇：从已缓存的快照里重排，不再打知乎接口（零额度消耗）
 * exclude 传已推过的 url，excludeTopic 传已推过的主题实现 7 天同主题去重
 */
router.get('/today', requireLogin, (req, res) => {
  const cache = req.zhSession.scanCache || req.zhSession.previewCache;
  if (!cache) {
    return res.status(409).json({
      ok: false, error: 'no_snapshot', message: '请先完成一次扫描',
    });
  }
  const excludeUrls = String(req.query.exclude || '').split(',').filter(Boolean);
  const excludeTopics = String(req.query.excludeTopic || '').split(',').filter(Boolean);
  const report = buildReport(cache.scan, excludeUrls, excludeTopics);
  res.json({
    ok: true,
    today: report.today,
    candidateCount: report.candidateCount,
  });
});

function mapCollectionItem(it) {
  return {
    contentType: it.ContentType ?? '',
    title: it.Title ?? '',
    summary: it.Summary ?? '',
    url: it.Url ?? '',
    createdAt: Number(it.CreatedAt ?? 0),
    favTime: Number(it.FavTime ?? 0),
    likeCount: Number(it.LikeCount ?? 0),
    commentCount: Number(it.CommentCount ?? 0),
    favoriteCount: Number(it.FavoriteCount ?? 0),
    favlists: (it.Favlists || []).map((f) => ({
      urlToken: String(f.UrlToken ?? '0'),
      title: f.Title ?? '',
      url: f.Url ?? '',
    })),
    // Author 为非必返字段，缺失时给 null，前端不显示该行而非显示"数据不足"
    author: it.Author
      ? {
          name: it.Author.Name ?? '',
          urlToken: it.Author.UrlToken ?? '',
          url: it.Author.Url ?? '',
          headline: it.Author.Headline ?? '',
        }
      : null,
  };
}

export default router;
