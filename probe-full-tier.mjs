/**
 * 完整档验证：构造跨年度样本，验证屏一地层剖面、断层标注、腐坏度与删除建议。
 * 这些分支在真实账号（25 条、跨度 1 个月）下走不到，必须单独验证。
 */
import { buildReport } from '../src/lib/scan.js';

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

function mk(title, topicHint, favMonthsAgo, ageMonths, folder, type = 'answer', extra = {}) {
  return {
    contentType: type,
    title: `${title}${topicHint}`,
    summary: topicHint,
    url: `https://www.zhihu.com/answer/${Math.random().toString(36).slice(2)}`,
    createdAt: NOW - ageMonths * 30 * DAY,
    favTime: NOW - favMonthsAgo * 30 * DAY,
    likeCount: 100,
    commentCount: 5,
    favoriteCount: 20,
    favlists: [{ urlToken: '1', title: folder, url: '' }],
    author: extra.author ? { name: extra.author, urlToken: 'a', url: '' } : null,
    ...extra.raw,
  };
}

const items = [];
// 考研：2023 年密集，2024Q1 后断层（应触发断层虚线 + 腐坏过期）
for (let i = 0; i < 8; i++) items.push(mk('考研择校经验', ' 考研 复试 政治', 34 - i, 36 - i, '考研资料', 'answer', { author: '上岸学长' }));
// 求职面经：2024 年
for (let i = 0; i < 6; i++) items.push(mk('秋招面经', ' 面经 秋招 offer 简历', 22 - i, 24 - i, '求职', 'answer', { author: '面试官老王' }));
// AI 工程：2025-2026 持续
for (let i = 0; i < 10; i++) items.push(mk('大模型微调实践', ' LLM 大模型 RAG 微调 Agent', 12 - i, 13 - i, '稍后再读', 'article', { author: 'AI 研究员' }));
// 写作方法（长青，不应被判过期）
for (let i = 0; i < 4; i++) items.push(mk('如何写好结构', ' 写作 结构 叙事 表达', 20 - i * 3, 40, '写作', 'article', { author: '编辑老李' }));
// 情绪心理（长青）
for (let i = 0; i < 3; i++) items.push(mk('如何应对内耗', ' 焦虑 内耗 边界感 自洽', 15 - i * 2, 30, '写作', 'answer'));
// 单独建夹的一条（投入证据）
items.push(mk('这篇很重要', ' 写作 表达', 18, 20, '单独收藏', 'article', { author: '编辑老李' }));
// 跨夹重复
const dup = mk('重复收藏的内容', ' LLM 大模型', 9, 10, '稍后再读', 'article', { author: 'AI 研究员' });
dup.favlists = [
  { urlToken: '1', title: '稍后再读', url: '' },
  { urlToken: '2', title: '写作', url: '' },
  { urlToken: '3', title: '求职', url: '' },
];
items.push(dup);
// 应被硬闸挡掉的三种类型
items.push(mk('一个视频', ' LLM', 5, 6, '稍后再读', 'zvideo'));
items.push(mk('一条想法', ' 写作', 5, 6, '写作', 'pin'));
items.push(mk('一个问题页', ' 考研', 5, 6, '考研资料', 'question'));

const scan = { level: 'L2', requests: 0, items, coverage: { note: '构造样本' } };
const r = buildReport(scan);

console.log('══════ 分档 ══════');
console.log(`tier = ${r.tier}（应为 full）`);
console.log(`条目 ${r.total}`);

console.log('\n══════ 屏一 · 地层剖面 ══════');
console.log(`分桶：${r.strata.mode}，${r.strata.buckets.length} 桶`);
console.log(`时间桶：${r.strata.buckets.join(' ')}`);
const w = Math.max(...r.strata.topics.map((t) => t.length));
r.strata.topics.forEach((t, i) => {
  console.log(`  ${t.padEnd(w + 2, '　')} ${r.strata.matrix[i].map((n) => String(n).padStart(2)).join(' ')}`);
});

console.log('\n══════ 断层标注 ══════');
if (r.faults.length) {
  r.faults.forEach((f) => console.log(`  ${f.topic}：停在 ${f.lastBucket}，已 ${f.gapMonths} 个月无新增`));
} else console.log('  无');

console.log('\n══════ 屏二 · 六卡 ══════');
r.cards.forEach((c) => console.log(`  ${c.label.padEnd(7, '　')} ${String(c.value).padEnd(11)} 下钻 ${c.drill.length} 条 ${c.deletable ? '[可删]' : ''}${c.disabled ? '[关闭]' : ''}`));

console.log('\n══════ 长青豁免检查 ══════');
const ever = r.items.filter((it) => ['写作方法', '情绪心理'].includes(it.topic));
const everExpired = ever.filter((it) => it.decay > 1);
console.log(`长青类 ${ever.length} 条，被判过期 ${everExpired.length} 条（应为 0）`);
console.log(`长青类腐坏度取值：${[...new Set(ever.map((it) => it.decay))].join(', ')}`);

console.log('\n══════ 硬闸检查 ══════');
const gated = ['zvideo', 'pin', 'question'];
console.log('屏三候选池:', r.candidateCount);
console.log('今天读这篇类型:', r.today?.contentType, gated.includes(r.today?.contentType) ? '❌ 硬闸失效' : '✅ 非受限类型');

console.log('\n══════ 屏三 ══════');
console.log(`标题：${r.today.title}`);
console.log(`主题：${r.today.topic} | 排序分 ${r.today.score}`);
r.today.reasons.forEach((x, i) => console.log(`  0${i + 1} [${x.kind}] ${x.text}`));

console.log('\n══════ 换一篇连点 5 次 ══════');
const su = []; const st = [];
for (let i = 0; i < 5; i++) {
  const rr = buildReport(scan, su, st);
  if (!rr.today) { console.log(`第 ${i + 1} 次：候选耗尽`); break; }
  console.log(`  ${i + 1}. [${rr.today.topic}] ${rr.today.title.slice(0, 30)} (分 ${rr.today.score})`);
  if (gated.includes(rr.today.contentType)) console.log('     ❌ 出现受限类型');
  su.push(rr.today.url); st.push(rr.today.topic);
}
console.log(`主题重复：${st.length !== new Set(st).size ? '❌ 有' : '✅ 无'}`);
