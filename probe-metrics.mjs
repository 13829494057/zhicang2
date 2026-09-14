/**
 * 指标层自检：用真实数据跑一遍六个函数，打印每个数字的来源
 * 这个脚本的输出必须与页面上的六卡数字逐位一致
 */
import 'dotenv/config';
import { scanFull, buildReport } from '../src/lib/scan.js';

const ctx = { accessSecret: process.env.ZHIHU_ACCESS_SECRET };

console.log('开始 L2 深挖扫描…');
const scan = await scanFull(ctx, (p) =>
  process.stdout.write(`\r  夹 ${p.folders} | 条目 ${p.items} | 请求 ${p.requests}   `)
);
console.log(`\n扫描完成：${scan.items.length} 条，消耗 ${scan.requests} 次请求`);
console.log(`覆盖率：${scan.coverage.note}\n`);

const r = buildReport(scan);

console.log('══════ 样本分档 ══════');
console.log(`tier = ${r.tier}（full=三屏全开 / light=关闭地层剖面与腐坏度）`);

console.log('\n══════ 屏二 · 六卡 ══════');
for (const c of r.cards) {
  console.log(`${c.label.padEnd(7, '　')} ${String(c.value).padEnd(12)} ${c.sub}`);
  if (c.disabled) console.log('        （该卡已关闭）');
}

console.log('\n══════ 屏一 · 地层剖面 ══════');
if (r.strata) {
  console.log(`分桶模式：${r.strata.mode}，共 ${r.strata.buckets.length} 桶`);
  console.log(`时间桶：${r.strata.buckets.join(' ')}`);
  r.strata.topics.forEach((t, i) => {
    console.log(`  ${t.padEnd(9, '　')} ${r.strata.matrix[i].join(' ')}`);
  });
  console.log(`断层：${r.faults.length ? r.faults.map((f) => `${f.topic}(停在${f.lastBucket}, ${f.gapMonths}个月)`).join('; ') : '无'}`);
} else {
  console.log('（轻量档，地层剖面已关闭）');
}

console.log('\n══════ 主题分布 ══════');
for (const t of r.topicStats) console.log(`  ${t.topic.padEnd(9, '　')} ${t.count}`);
console.log(`未分类占比：${(r.unclassifiedRatio * 100).toFixed(1)}%（> 30% 需补词典）`);

console.log('\n══════ 分类漂移 ══════');
if (r.drifts.length) {
  for (const dft of r.drifts) {
    console.log(`  「${dft.folder}」${dft.total} 条里 ${(dft.ratio * 100).toFixed(1)}% 是 ${dft.topic}`);
  }
} else console.log('  无（夹子条目数均 < 12，或主题天然集中）');

console.log('\n══════ 屏三 · 今天读这篇 ══════');
if (r.today) {
  console.log(`标题：${r.today.title}`);
  console.log(`类型：${r.today.contentType} | 主题：${r.today.topic} | 排序分：${r.today.score}`);
  console.log(`作者：${r.today.author || '(接口未返回)'} | 躺置 ${r.today.favMonths} 个月`);
  console.log('三行理由：');
  r.today.reasons.forEach((x, i) =>
    console.log(`  0${i + 1} [${x.kind}] ${x.text}`)
  );
  console.log(`候选池大小：${r.candidateCount}（已过硬闸）`);
} else {
  console.log('硬闸后候选为空 → 屏三显示「没有值得今天读的了，这是好事」');
}

console.log('\n══════ 换一篇（连点 5 次）══════');
const seenUrl = [];
const seenTopic = [];
for (let i = 0; i < 5; i++) {
  const rr = buildReport(scan, seenUrl, seenTopic);
  if (!rr.today) { console.log(`第 ${i + 1} 次：候选耗尽`); break; }
  console.log(`第 ${i + 1} 次：[${rr.today.topic}] ${rr.today.title.slice(0, 34)}`);
  seenUrl.push(rr.today.url);
  seenTopic.push(rr.today.topic);
}
const dupTopic = seenTopic.length !== new Set(seenTopic).size;
console.log(`主题是否重复：${dupTopic ? '❌ 有重复' : '✅ 无重复'}`);
