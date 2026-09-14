/**
 * 扫描编排：拉取 → 打标签 → 算指标 → 组装三屏数据
 *
 * 额度纪律（方案文档第四十四节）：
 *   L1 速览  1 次请求        —— 登录后自动执行，用 collections
 *   L2 深挖  ≤ 40 次请求     —— 用户主动点击才触发，逐夹遍历
 */

import { callUserDataApi, parseNextOffset, withRetry } from './zhihu.js';
import { tagTopics, UNCLASSIFIED } from './topics.js';
import {
  strata, dormancy, hoarding, motive, decay, reviveScore,
  buildReasons, TH,
} from './metrics.js';

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

/** 单次扫描请求上限（按实测 1,000 日额度收敛，文档第二十七节） */
const MAX_REQUESTS = 40;
const MAX_FOLDERS = 12;
const MAX_PAGES_PER_FOLDER = 3;

function mapItem(it) {
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
    author: it.Author
      ? { name: it.Author.Name ?? '', urlToken: it.Author.UrlToken ?? '', url: it.Author.Url ?? '' }
      : null,
  };
}

/** L1 速览：1 次请求 */
export async function scanPreview(ctx) {
  const data = await withRetry(() =>
    callUserDataApi('/api/v1/user/collections', { Limit: 50 }, ctx)
  );
  const items = (data.Items || []).map(mapItem).filter((it) => it.favTime);
  return {
    level: 'L1',
    requests: 1,
    items,
    coverage: { scanned: items.length, folders: null, note: '基于你最近 50 条收藏' },
  };
}

/** L2 深挖：逐夹遍历，硬约束请求数 */
export async function scanFull(ctx, onProgress) {
  let requests = 0;

  const listData = await withRetry(() =>
    callUserDataApi('/api/v1/user/favlists', { Limit: 50 }, ctx)
  );
  requests += 1;

  const folders = (listData.Items || []).map((f) => ({
    urlToken: String(f.UrlToken ?? ''),
    title: f.Title ?? '',
    isPublic: Boolean(f.IsPublic),
  }));

  const targetFolders = folders.slice(0, MAX_FOLDERS);
  const byUrl = new Map();
  let scannedFolders = 0;
  let stoppedByBudget = false;

  for (const f of targetFolders) {
    if (requests >= MAX_REQUESTS) { stoppedByBudget = true; break; }
    let offset = 0;
    let page = 0;
    while (page < MAX_PAGES_PER_FOLDER) {
      if (requests >= MAX_REQUESTS) { stoppedByBudget = true; break; }
      const d = await withRetry(() =>
        callUserDataApi(
          '/api/v1/user/favlist_contents',
          { FavlistUrlToken: f.urlToken, Offset: offset, Limit: 50 },
          ctx
        )
      );
      requests += 1;
      for (const raw of d.Items || []) {
        const it = mapItem(raw);
        if (!it.url || !it.favTime) continue;
        // 同一条可能出现在多个夹子：按 Url 归并，favlists 合并
        if (byUrl.has(it.url)) {
          const prev = byUrl.get(it.url);
          const seen = new Set(prev.favlists.map((x) => x.title));
          for (const fl of it.favlists) if (!seen.has(fl.title)) prev.favlists.push(fl);
        } else {
          byUrl.set(it.url, it);
        }
      }
      onProgress?.({ folders: scannedFolders + 1, items: byUrl.size, requests });

      let next = null;
      try { next = parseNextOffset(d.Paging); } catch { next = null; }
      if (next === null) break;
      offset = next;
      page += 1;
    }
    scannedFolders += 1;
  }

  return {
    level: 'L2',
    requests,
    items: [...byUrl.values()],
    folders,
    coverage: {
      scanned: scannedFolders,
      folders: folders.length,
      truncatedByProtocol: folders.length >= 50,
      stoppedByBudget,
      note: buildCoverageNote(scannedFolders, folders.length, stoppedByBudget),
    },
  };
}

function buildCoverageNote(scanned, total, stoppedByBudget) {
  if (!total) return '未读取到公开收藏夹';
  if (scanned >= total && !stoppedByBudget) return `已扫全部 ${total} 个收藏夹`;
  const pct = Math.round((scanned / total) * 100);
  return `已扫 ${scanned}/${total} 个收藏夹，覆盖 ${pct}%`;
}

/**
 * 把原始条目算成三屏数据。纯本地计算，无网络请求。
 */
export function buildReport(scan, excludeUrls = [], excludeTopics = []) {
  const now = nowSec();
  const items = scan.items;

  if (!items.length) {
    return { empty: true, tier: 'empty', coverage: scan.coverage, level: scan.level };
  }

  // 打主题标签
  tagTopics(items);

  // 动机与腐坏度
  for (const it of items) {
    it._motive = motive(it);
    it._decay = decay(it, now);
    it._favMonths = Math.floor((now - it.favTime) / DAY / 30);
  }

  // 夹子容量表（供"单独建夹"判定）
  const folderSizes = new Map();
  for (const it of items) {
    for (const f of it.favlists || []) {
      folderSizes.set(f.title, (folderSizes.get(f.title) || 0) + 1);
    }
  }

  const topicCounts = new Map();
  for (const it of items) topicCounts.set(it._topic, (topicCounts.get(it._topic) || 0) + 1);

  // 样本量分档（文档 43.1）：空态 / 轻量档 / 完整档
  const times = items.map((it) => it.favTime);
  const spanDays = (Math.max(...times) - Math.min(...times)) / DAY;
  let tier = 'full';
  if (items.length < 20 || spanDays < 90) tier = 'light';

  // ① 地层剖面 + ④ 断层
  const st = strata(items);
  const faults = dormancy(items, st);
  st.faults = faults;

  // ⑤ 囤积体检
  const hd = hoarding(items);

  // ② 六卡数字
  const avgDormantMonths =
    items.reduce((s, it) => s + it._favMonths, 0) / items.length;
  const oldest = items.reduce((a, b) => (a.favTime < b.favTime ? a : b));
  const hotFollow = items.filter((it) => it._motive === '热点跟收');
  const expired = items.filter((it) => it._decay > 1);

  const cards = [
    {
      key: 'scale', label: '规模', value: `${items.length} 条`,
      sub: st.buckets.length ? `跨度 ${st.buckets[0]} – ${st.buckets[st.buckets.length - 1]}` : '',
      drill: items.map((it) => it.url),
    },
    {
      key: 'dormancy', label: '平均躺置', value: `${avgDormantMonths.toFixed(1)} 个月`,
      sub: `最久的一条躺了 ${oldest._favMonths} 个月`,
      drill: [...items].sort((a, b) => a.favTime - b.favTime).map((it) => it.url),
    },
    {
      key: 'hotFollow', label: '热点跟收占比',
      value: `${((hotFollow.length / items.length) * 100).toFixed(1)}%`,
      sub: `收藏时它刚发布不到 ${TH.HOT_FOLLOW_DAYS} 天 —— 你是被推荐流带着收的`,
      drill: hotFollow.map((it) => it.url),
    },
    {
      key: 'expired', label: '建议删除', value: `${expired.length} 条`,
      sub: '主题已过时效，留着只增加检索噪声',
      drill: expired.map((it) => it.url), deletable: true,
    },
    {
      key: 'duplicated', label: '重复囤积', value: `${hd.duplicated.length} 条`,
      sub: hd.duplicated.length
        ? '同一条躺在多个收藏夹里'
        : '很好，没有一条被重复收进多个夹子',
      drill: hd.duplicated.map((it) => it.url),
    },
    hd.authorAvailable
      ? {
          key: 'authors', label: '作者集中度',
          value: `${(hd.concentration * 100).toFixed(1)}%`,
          sub: hd.topAuthors[0]
            // 分母是「接口返回了作者字段的条目数」而非总条数，必须写明，
            // 否则用户拿 3÷77 一算就会认为百分比算错了。
            ? `你收藏最多的是「${hd.topAuthors[0].name}」，在 ${hd.authorKnownCount} 条可识别作者的收藏里占了 ${hd.topAuthors[0].count} 条，不如直接关注他`
            : '',
          // 下钻展示 Top 作者本身；每个作者带其被收藏的条目 url
          drill: hd.topAuthors.flatMap((a) => a.urls),
          topAuthors: hd.topAuthors,
        }
      : {
          key: 'authors', label: '作者集中度', value: '—',
          sub: '接口未返回作者字段，此项不做推测', disabled: true, drill: [],
        },
  ];

  // ⑥ 屏三：今天读这篇
  const ctx = { folderSizes, faults, topicCounts };
  const excludeUrlSet = new Set(excludeUrls);
  const excludeTopicSet = new Set(excludeTopics);

  const scored = items
    .filter((it) => !excludeUrlSet.has(it.url))
    .filter((it) => !excludeTopicSet.has(it._topic))
    .map((it) => ({ it, score: reviveScore(it, ctx, now) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);

  const pick = scored[0]?.it || null;
  const today = pick
    ? {
        title: pick.title,
        url: pick.url,
        contentType: pick.contentType,
        topic: pick._topic,
        author: pick.author?.name || null,
        publishedAt: pick.createdAt,
        favMonths: pick._favMonths,
        score: Number(scored[0].score.toFixed(3)),
        reasons: buildReasons(pick, ctx, now),
        handoff: {
          url: pick.url,
          contentType: pick.contentType,
          topic: pick._topic,
          favAgeMonth: pick._favMonths,
          reasons: buildReasons(pick, ctx, now).map((r) => r.text),
        },
      }
    : null;

  // 屏一分类总结：每个主题看了多少、占比、最近一次收藏、主导动机
  // 全部来自真实 FavTime / motive，无任何写死或构造
  const topicSummary = [...topicCounts.entries()]
    .map(([topic, count]) => {
      const list = items.filter((it) => it._topic === topic);
      const lastFav = Math.max(...list.map((it) => it.favTime));
      const lastMonths = Math.floor((now - lastFav) / DAY / 30);
      const motiveCount = { 主动检索: 0, 常规: 0, 热点跟收: 0 };
      for (const it of list) motiveCount[it._motive] += 1;
      const dominant = Object.entries(motiveCount).sort((a, b) => b[1] - a[1])[0][0];
      return {
        topic,
        count,
        ratio: Number((count / items.length).toFixed(3)),
        lastMonths,
        dominantMotive: dominant,
        expiredCount: list.filter((it) => it._decay > 1).length,
      };
    })
    .sort((a, b) => b.count - a.count);

  return {
    empty: false,
    tier,
    level: scan.level,
    coverage: scan.coverage,
    requests: scan.requests,
    total: items.length,
    spanText: st.buckets.length ? `${st.buckets[0]} – ${st.buckets[st.buckets.length - 1]}` : '',
    strata: tier === 'full' ? st : null,
    faults,
    cards: tier === 'full'
      ? cards
      // 轻量档：关掉依赖时间跨度的"平均躺置"和依赖时效判定的"建议删除"，
      // 其余仍成立（文档 43.1：只出"你的收藏偏好"与"今天读这篇"）
      : cards.filter((c) => ['scale', 'hotFollow', 'duplicated', 'authors'].includes(c.key)),
    drifts: hd.drifts,
    today,
    candidateCount: scored.length,
    // 供下钻用的精简条目表
    items: items.map((it) => ({
      url: it.url, title: it.title, summary: it.summary,
      contentType: it.contentType, topic: it._topic, motive: it._motive,
      decay: Number(it._decay.toFixed(2)), favMonths: it._favMonths,
      createdAt: it.createdAt, favTime: it.favTime,
      likeCount: it.likeCount, author: it.author?.name || null,
      folders: (it.favlists || []).map((f) => f.title),
    })),
    topicStats: [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([topic, count]) => ({ topic, count })),
    topicSummary,
    unclassifiedRatio: Number(
      ((topicCounts.get(UNCLASSIFIED) || 0) / items.length).toFixed(3)
    ),
  };
}
