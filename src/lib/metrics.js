/**
 * 指标层 · 六个纯函数（方案文档第十一节）
 *
 * 全部零 LLM —— 不是为了省钱，是为了让每个数字都能在路演现场
 * 被追问"这是怎么算出来的"时都答得上来。
 *
 * ① strata        季度 × 主题矩阵      → 屏一
 * ② motive        FavTime − CreatedAt  → 屏二 / 理由句
 * ③ decay         内容年龄 / 半衰期     → 删除建议
 * ④ dormancy      各主题最后收藏时间    → 屏一断层虚线
 * ⑤ hoarding      重复 / 集中 / 漂移    → 屏二
 * ⑥ reviveScore   ②③④ 组合            → 屏三
 */

import { TS_PAT, topicHalfLife, isEvergreen, UNCLASSIFIED } from './topics.js';

/** 阈值总表（文档 11.4，现场可调，集中在此一处） */
export const TH = {
  HOT_FOLLOW_DAYS: 7,       // 热点跟收判定：lag < 7 天
  ACTIVE_SEARCH_DAYS: 180,  // 主动检索判定：lag ≥ 180 天
  DECAY_GATE: 1.2,          // 腐坏硬闸：decay > 1.2 出局
  DORMANCY_QUARTERS: 2,     // 断层判定：连续 ≥ 2 季度为 0
  DRIFT_MIN_ITEMS: 12,      // 漂移提示线：夹子 ≥ 12 条才判断漂移
  DORMANT_BONUS_CAP: 1.5,   // 躺置加分上限（约 18 个月）
  SMALL_FOLDER_MAX: 5,      // "单独建夹"判定：夹子条目数 ≤ 5
  TS_HALF_LIFE: 180,        // 标题带时效标记时的半衰期上限
  EVERGREEN_DECAY: 0.3,     // 长青主题豁免后的固定腐坏度
};

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

/** 秒级时间戳 → 季度键，如 2026Q3 */
export function quarterKey(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}Q${Math.floor(d.getMonth() / 3) + 1}`;
}

/** 秒级时间戳 → 月份键，如 2026-09 */
export function monthKey(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 补齐时间轴上缺失的桶。
 * 空槽位必须保留 —— 断层的视觉前提就是"看得见的空白"。
 */
function fillGaps(keys, mode) {
  if (keys.length < 2) return keys;
  const out = [];
  const parse = (k) =>
    mode === 'month'
      ? { y: +k.slice(0, 4), n: +k.slice(5) }       // 1–12
      : { y: +k.slice(0, 4), n: +k.slice(5) };       // 1–4
  const per = mode === 'month' ? 12 : 4;
  const fmt = (y, n) =>
    mode === 'month' ? `${y}-${String(n).padStart(2, '0')}` : `${y}Q${n}`;

  let cur = parse(keys[0]);
  const end = parse(keys[keys.length - 1]);
  let guard = 0;
  while (guard++ < 400) {
    out.push(fmt(cur.y, cur.n));
    if (cur.y === end.y && cur.n === end.n) break;
    cur.n += 1;
    if (cur.n > per) { cur.n = 1; cur.y += 1; }
  }
  return out;
}

// ───────────────── ② 动机分型（本方案原创点） ─────────────────
/**
 * 只用两个时间戳的差值。
 * 所有同类产品都在分析"收藏了什么"（标题文本），
 * 只有它分析"怎么收的"（时间差）—— 用户无法反驳自己的时间戳。
 */
export function motive(it) {
  const lag = (it.favTime - it.createdAt) / DAY;
  if (lag < TH.HOT_FOLLOW_DAYS) return '热点跟收';
  if (lag < TH.ACTIVE_SEARCH_DAYS) return '常规';
  return '主动检索';
}

// ───────────────── ③ 腐坏度 ─────────────────
export function halfLife(it) {
  let hl = topicHalfLife(it._topic);
  // 标题带年份/版本号 → 时效性强，砍到半年
  if (TS_PAT.test(it.title || '')) hl = Math.min(hl, TH.TS_HALF_LIFE);
  return hl;
}

export function decay(it, now = nowSec()) {
  const hl = halfLife(it);
  // 长青主题豁免：写作方法、情绪心理等不参与腐坏判定
  if (hl >= 1200 && !TS_PAT.test(it.title || '')) return TH.EVERGREEN_DECAY;
  return (now - it.createdAt) / DAY / hl; // > 1 视为过期候选
}

// ───────────────── ① 地层剖面 ─────────────────
/**
 * 季度 × 主题矩阵。时间跨度 < 4 季度时降级按月分桶。
 * @returns {{buckets, topics, matrix, mode, faults}}
 */
export function strata(items, faults = []) {
  if (!items.length) return { buckets: [], topics: [], matrix: [], mode: 'quarter', faults: [] };

  const times = items.map((it) => it.favTime).filter(Boolean);
  const span = (Math.max(...times) - Math.min(...times)) / DAY;
  const mode = span < 365 ? 'month' : 'quarter';
  const keyOf = mode === 'month' ? monthKey : quarterKey;

  // 主题热度排序，Top 5 着色，其余并入"其他"
  const topicCount = new Map();
  for (const it of items) {
    topicCount.set(it._topic, (topicCount.get(it._topic) || 0) + 1);
  }
  const ranked = [...topicCount.entries()]
    .filter(([t]) => t !== UNCLASSIFIED)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);

  const hasOther = [...topicCount.keys()].some((t) => !ranked.includes(t));
  const topics = hasOther ? [...ranked, '其他'] : ranked;

  // 时间桶：按真实时间顺序排列，并补齐中间缺失的桶
  // 缺的季度必须留空槽，否则时间轴被压缩，会把"中断"误读成"连续"
  const presentKeys = [...new Set(items.map((it) => keyOf(it.favTime)))].sort();
  const buckets = fillGaps(presentKeys, mode);

  const idxT = new Map(topics.map((t, i) => [t, i]));
  const idxB = new Map(buckets.map((b, i) => [b, i]));
  const matrix = topics.map(() => buckets.map(() => 0));

  for (const it of items) {
    const bi = idxB.get(keyOf(it.favTime));
    const ti = idxT.has(it._topic) ? idxT.get(it._topic) : idxT.get('其他');
    if (bi === undefined || ti === undefined) continue;
    matrix[ti][bi] += 1;
  }

  return { buckets, topics, matrix, mode, faults };
}

// ───────────────── ④ 断层 ─────────────────
/**
 * 某主题连续 ≥ 2 个时间桶为 0，在最后一次出现处标断层。
 * 跨度过短（按月分桶）时不标断层。
 */
export function dormancy(items, strataResult) {
  const { buckets, topics, matrix, mode } = strataResult;
  if (mode === 'month' || buckets.length < 3) return [];

  const now = Math.floor(Date.now() / 1000);

  // 主题 → 最后一次真实收藏时间，避免用「季度数 × 3」估算月数，
  // 否则同一主题在断层条与分布列表里会给出两个不同的月份，用户一眼看出矛盾。
  const lastFavByTopic = new Map();
  for (const it of items) {
    const t = it._topic;
    const ft = Number(it.favTime || 0);
    if (!t || !ft) continue;
    if (!lastFavByTopic.has(t) || ft > lastFavByTopic.get(t)) lastFavByTopic.set(t, ft);
  }

  const faults = [];
  topics.forEach((topic, ti) => {
    if (topic === '其他') return;
    const row = matrix[ti];
    let lastIdx = -1;
    for (let i = row.length - 1; i >= 0; i--) {
      if (row[i] > 0) { lastIdx = i; break; }
    }
    if (lastIdx < 0) return;
    const gap = buckets.length - 1 - lastIdx;
    if (gap >= TH.DORMANCY_QUARTERS) {
      const lastFav = lastFavByTopic.get(topic);
      const gapMonths = lastFav
        ? Math.floor((now - lastFav) / DAY / 30)
        : gap * 3;
      faults.push({
        topic,
        lastBucket: buckets[lastIdx],
        gapQuarters: gap,
        gapMonths,
      });
    }
  });
  return faults;
}

// ───────────────── ⑤ 囤积体检 ─────────────────
export function hoarding(items) {
  // 跨夹重复
  const duplicated = items.filter((it) => (it.favlists || []).length > 1);

  // 作者集中度（Author 非必返，缺失则整卡关闭，不猜不补）
  const withAuthor = items.filter((it) => it.author && it.author.name);
  const authorAvailable = withAuthor.length >= Math.max(5, items.length * 0.3);
  let topAuthors = [];
  let concentration = null;
  if (authorAvailable) {
    const byAuthor = new Map();
    for (const it of withAuthor) {
      const n = it.author.name;
      if (!byAuthor.has(n)) {
        byAuthor.set(n, { name: n, count: 0, url: it.author.url || '', urls: [] });
      }
      const a = byAuthor.get(n);
      a.count += 1;
      a.urls.push(it.url);
    }
    topAuthors = [...byAuthor.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    concentration = topAuthors.length ? topAuthors[0].count / withAuthor.length : null;
  }

  // 分类漂移：夹子 ≥ 12 条时，看夹内最大主题占比
  const byFolder = new Map();
  for (const it of items) {
    for (const f of it.favlists || []) {
      if (!f.title) continue;
      if (!byFolder.has(f.title)) byFolder.set(f.title, []);
      byFolder.get(f.title).push(it);
    }
  }
  const drifts = [];
  for (const [title, list] of byFolder) {
    if (list.length < TH.DRIFT_MIN_ITEMS) continue;
    const cnt = new Map();
    for (const it of list) cnt.set(it._topic, (cnt.get(it._topic) || 0) + 1);
    const [topTopic, topCount] = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topTopic === UNCLASSIFIED) continue;
    const ratio = topCount / list.length;
    if (ratio >= 0.2) {
      drifts.push({ folder: title, topic: topTopic, ratio, total: list.length });
    }
  }

  return { duplicated, topAuthors, concentration, authorAvailable, authorKnownCount: withAuthor.length, drifts };
}

// ───────────────── ⑥ 定向复活打分 ─────────────────
/**
 * 先硬闸，再排序。
 * zvideo 拿不到正文、pin 短到不需要复活、question 是问题页不是文章 ——
 * 三者都无法交接给下游阅读器，推了也走不通下一步。
 */
export function reviveScore(it, ctx = {}, now = nowSec()) {
  const d = decay(it, now);
  if (d > TH.DECAY_GATE) return -1;
  if (['zvideo', 'pin', 'question'].includes(it.contentType)) return -1;

  let s = { 主动检索: 1.0, 常规: 0.4, 热点跟收: 0.0 }[it._motive] ?? 0;
  s += Math.max(0, 1 - d);
  s += Math.min((now - it.favTime) / DAY / 365, TH.DORMANT_BONUS_CAP);
  // 单独建夹 = 当时真的在意
  s += isInSmallFolder(it, ctx.folderSizes) ? 0.5 : 0;
  return s;
}

function isInSmallFolder(it, folderSizes) {
  if (!folderSizes) return false;
  return (it.favlists || []).some(
    (f) => (folderSizes.get(f.title) ?? 999) <= TH.SMALL_FOLDER_MAX
  );
}

// ───────────────── 理由句生成（屏三） ─────────────────
/**
 * 模板化生成，不用 LLM —— 避免胡说，也避免额度依赖。
 * 每条理由都必须能指回具体字段，没有一行是形容词。
 */
export function buildReasons(it, ctx, now = nowSec()) {
  const reasons = [];
  const favDays = Math.floor((now - it.favTime) / DAY);
  const favMonths = Math.floor(favDays / 30);
  // 躺置不足一个月时用天表述，避免出现"躺了 0 个月"这种不成立的句子
  const dormantText = favMonths >= 1 ? `${favMonths} 个月` : `${Math.max(favDays, 1)} 天`;

  // 投入证据：所在夹子条目数 ≤ 5
  const smallFolder = (it.favlists || []).find(
    (f) => (ctx.folderSizes?.get(f.title) ?? 999) <= TH.SMALL_FOLDER_MAX
  );
  if (smallFolder) {
    reasons.push({
      kind: '投入证据',
      text: `你为它单独建过收藏夹「${smallFolder.title}」，只放了 ${ctx.folderSizes.get(smallFolder.title)} 条，它是其中之一`,
    });
  }

  // 动机证据
  if (it._motive === '主动检索') {
    const lagDays = Math.floor((it.favTime - it.createdAt) / DAY);
    reasons.push({
      kind: '动机证据',
      text: `它是你主动搜出来的 —— 内容发布 ${lagDays} 天后你才收藏，不是热点推给你的`,
    });
  } else if (it._motive === '常规') {
    const lagDays = Math.floor((it.favTime - it.createdAt) / DAY);
    reasons.push({
      kind: '动机证据',
      text: `内容发布 ${lagDays} 天后你才收它，不属于刷到顺手就收的那一类`,
    });
  }

  // 保质期证据：长青类
  if (isEvergreen(it._topic) && !TS_PAT.test(it.title || '')) {
    const ageDays = Math.floor((now - it.createdAt) / DAY);
    const ageText = ageDays >= 365
      ? `${Math.floor(ageDays / 365)} 年`
      : `${Math.max(ageDays, 1)} 天`;
    reasons.push({
      kind: '保质期证据',
      text: `「${it._topic}」属于长青主题，发布 ${ageText}后内容依然成立`,
    });
  }

  // 断层证据
  const fault = (ctx.faults || []).find((f) => f.topic === it._topic);
  if (fault) {
    reasons.push({
      kind: '断层证据',
      text: `你在「${it._topic}」上的线索停在 ${fault.lastBucket}，这是最后一条`,
    });
  }

  // 孤本证据：该主题仅此 1 条
  if (ctx.topicCounts?.get(it._topic) === 1 && it._topic !== UNCLASSIFIED) {
    reasons.push({
      kind: '孤本证据',
      text: `整个收藏夹里，「${it._topic}」只有它这一条`,
    });
  }

  // 稀缺证据：该主题条目数很少
  if (reasons.length < 3) {
    const cnt = ctx.topicCounts?.get(it._topic);
    if (cnt && cnt <= 3 && it._topic !== UNCLASSIFIED) {
      reasons.push({
        kind: '稀缺证据',
        text: `「${it._topic}」这个方向你一共只收了 ${cnt} 条，线索很薄`,
      });
    }
  }

  // 保鲜证据：还没过保质期，来自 decay 真实取值
  if (reasons.length < 3 && it._decay !== undefined && it._decay < 0.6) {
    reasons.push({
      kind: '保鲜证据',
      text: `按「${it._topic}」的时效性测算，它还远没到过期线（腐坏度 ${it._decay.toFixed(2)}）`,
    });
  }

  // 兜底：躺置时长永远可用，且来自真实字段
  if (reasons.length < 3) {
    reasons.push({
      kind: '躺置证据',
      text: `收藏于 ${dormantText}前，此后没有再被打开过的记录`,
    });
  }

  // 仍不足 3 条时，用互动数据补一条（同样来自真实字段）
  if (reasons.length < 3) {
    reasons.push({
      kind: '公认证据',
      text: `它有 ${it.likeCount} 个赞同，不是冷门内容，只是被你放着没读`,
    });
  }

  return reasons.slice(0, 3);
}
