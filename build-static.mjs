/**
 * 生成三个自包含静态 HTML：把真实报告数据烘焙进页面，双击即可打开，无需后端。
 * 用法：node scripts/build-static.mjs <report.json> <输出目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const reportPath = process.argv[2];
const outDir = process.argv[3];
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const baseCss = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const screensCss = fs.readFileSync(path.join(pub, 'screens.css'), 'utf8');

const PALETTE = ['#2f6fed', '#3aa17e', '#d9a33c', '#cf6b4b', '#8b7ec8', '#9aa6b2'];
const CHART_H = 240;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const typeLabel = (t) => ({ answer: '回答', article: '文章', zvideo: '视频', pin: '想法', question: '问题' }[t] || t || '内容');
const fmtDate = (ts) => { if (!ts) return ''; const d = new Date(ts * 1000); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

function shell(title, activeScreen, bodyInner, links) {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 收藏夹考古</title>
<style>${baseCss}\n${screensCss}</style>
</head><body>
<header class="topbar">
  <span class="brand"><span class="brand-mark">考</span> 收藏夹考古</span>
  <div class="user-area"><span style="font-size:13px;color:var(--muted)">静态预览 · 真实数据快照</span></div>
</header>
<main class="wrap">
  <div class="screens">${links}</div>
  ${bodyInner}
  <div class="coverage-note">${esc(report.coverage?.note || '')}　·　深挖档　·　数据来自真实账号收藏（静态快照，无后端）</div>
</main>
</body></html>`;
}

function navLinks(active) {
  const items = [
    ['strata.html', '屏一 · 地层剖面', 1],
    ['diagnosis.html', '屏二 · 体检报告', 2],
    ['today.html', '屏三 · 今天读这篇', 3],
  ];
  return items.map(([href, label, n]) =>
    `<a class="screen-dot ${n === active ? 'active' : ''}" href="${href}" style="text-decoration:none">${label}</a>`
  ).join('');
}

/* ── 屏一 ── */
function buildStrata() {
  const st = report.strata;
  const { buckets, topics, matrix } = st;
  const colTotals = buckets.map((_, bi) => topics.reduce((s, _t, ti) => s + matrix[ti][bi], 0));
  const max = Math.max(...colTotals, 1);
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const dense = buckets.length > 16;
  const step = dense ? (buckets.length > 28 ? 4 : 2) : 1;

  const yAxis = ticks.map((v) => `<span class="strata-ytick" style="top:${CHART_H - (v / max) * CHART_H}px">${v}</span>`).join('');
  const grid = ticks.filter((v) => v > 0).map((v) => `<div class="strata-grid" style="bottom:${(v / max) * CHART_H}px"></div>`).join('');
  const cols = buckets.map((b, bi) => {
    if (!colTotals[bi]) return `<div class="strata-col" title="${esc(b)} · 无收藏"><div class="strata-empty"></div></div>`;
    return `<div class="strata-col">${topics.map((t, ti) => {
      const v = matrix[ti][bi]; if (!v) return '';
      return `<div class="strata-seg" style="height:${(v / max) * CHART_H}px;background:${PALETTE[ti % 6]}" title="${esc(b)} · ${esc(t)} · ${v} 条"></div>`;
    }).join('')}</div>`;
  }).join('');
  const xAxis = buckets.map((b, i) => `<span>${(i % step === 0 || i === buckets.length - 1) ? esc(b) : ''}</span>`).join('');
  const legend = topics.map((t, i) => `<div class="legend-item"><span class="legend-swatch" style="background:${PALETTE[i % 6]}"></span>${esc(t)}</div>`).join('');
  const faults = (report.faults || []).map((f) => `<div class="fault-line">断层 · 你在 <strong>${esc(f.topic)}</strong> 上的收藏停在 ${esc(f.lastBucket)}，已经 ${f.gapMonths} 个月没有新增</div>`).join('');

  const sum = report.topicSummary || [];
  const maxC = Math.max(...sum.map((t) => t.count), 1);
  const mtag = { 主动检索: ['主动搜的', 'm-active'], 热点跟收: ['刷到就收', 'm-hot'], 常规: ['常规收藏', 'm-normal'] };
  const rows = sum.map((t, i) => {
    const [ml, mc] = mtag[t.dominantMotive] || ['', ''];
    const color = t.topic === '未分类' ? '#9aa6b2' : PALETTE[i % 6];
    const last = t.lastMonths >= 1 ? `上次收藏在 ${t.lastMonths} 个月前` : '上个月还在收';
    return `<div class="summary-row">
      <div class="summary-name"><span class="summary-dot" style="background:${color}"></span>${esc(t.topic)}</div>
      <div class="summary-bar-wrap"><div class="summary-bar" style="width:${(t.count / maxC) * 100}%;background:${color}"></div></div>
      <div class="summary-num">${t.count} 条 · ${(t.ratio * 100).toFixed(0)}%</div>
      <div class="summary-meta"><span class="mtag ${mc}">${ml}</span><span>${last}</span>${t.expiredCount > 0 ? `<span class="mtag m-expired">${t.expiredCount} 条已过时效</span>` : ''}</div>
    </div>`;
  }).join('');
  const top3 = sum.filter((t) => t.topic !== '未分类').slice(0, 3).map((t) => `${t.topic}（${t.count} 条）`).join('、');

  const body = `
    <div id="screen1">
      <div class="strata-wrap">
        <div style="font-size:15px;font-weight:700">我这几年在关心什么，什么时候断了</div>
        <div style="font-size:13px;color:var(--muted);margin-top:5px">按季度分桶，纵轴为收藏量</div>
        <div class="strata-plot">
          <div class="strata-yaxis">${yAxis}</div>
          <div class="strata-scroll"><div class="strata-chart ${dense ? 'dense' : ''}">${grid}${cols}</div></div>
        </div>
        <div class="strata-x ${dense ? 'dense' : ''}" style="margin-left:44px">${xAxis}</div>
        <div class="legend">${legend}</div>
        ${faults}
      </div>
      <div class="summary-wrap">
        <div class="summary-head">
          <div style="font-size:15px;font-weight:700">你看过的内容分布</div>
          <div style="font-size:13px;color:var(--muted);margin-top:4px">跨度 ${esc(report.spanText)}，共 ${report.total} 条。你收藏最多的是 ${esc(top3)}。</div>
        </div>
        <div class="summary-list">${rows}</div>
      </div>
    </div>`;
  return shell('屏一 · 地层剖面', 1, body, navLinks(1));
}

/* ── 屏二 ── */
function buildDiagnosis() {
  const cards = report.cards.map((c) => `
    <div class="dcard ${c.disabled ? 'disabled' : ''}">
      <div class="dcard-label">${esc(c.label)}</div>
      <div class="dcard-value">${esc(c.value)}</div>
      <div class="dcard-sub">${esc(c.sub || '')}</div>
    </div>`).join('');
  const drifts = (report.drifts || []).map((d) => `<div class="drift-band">「${esc(d.folder)}」${d.total} 条里 ${(d.ratio * 100).toFixed(1)}% 是 ${esc(d.topic)} —— 这个夹子名和内容已经不匹配了</div>`).join('');
  const body = `<div id="screen2"><div class="cards6">${cards}</div>${drifts}</div>`;
  return shell('屏二 · 体检报告', 2, body, navLinks(2));
}

/* ── 屏三 ── */
function buildToday() {
  const t = report.today;
  let inner;
  if (!t) {
    inner = `<div class="today-card" style="text-align:center"><div class="today-kicker">今天读这篇</div><h2 style="font-size:20px">你的收藏夹里没有值得今天读的了</h2><p style="color:var(--sub)">这是好事。</p></div>`;
  } else {
    inner = `<div class="today-card">
      <div class="today-kicker">今天读这篇</div>
      <a class="today-title" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.title)}</a>
      <div class="today-meta">
        <span class="tag">${typeLabel(t.contentType)}</span>
        <span class="tag gray">${esc(t.topic)}</span>
        ${t.author ? `<span>${esc(t.author)}</span><span class="sep">·</span>` : ''}
        <span>发布于 ${fmtDate(t.publishedAt)}</span><span class="sep">·</span>
        <span>收藏于 ${t.favMonths >= 1 ? t.favMonths + ' 个月前' : '近一个月内'}</span>
      </div>
      <div class="reasons"><div class="reasons-head">为什么是这一篇</div><div class="reason-chain">
        ${t.reasons.map((x, i) => `<div class="reason"><span class="reason-no">0${i + 1}</span><div class="reason-body"><div class="reason-kind">${esc(x.kind)}</div><div class="reason-text">${esc(x.text)}</div></div></div>`).join('')}
      </div></div>
      <div class="today-actions"><a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">打开原文</a></div>
    </div>`;
  }
  return shell('屏三 · 今天读这篇', 3, `<div id="screen3">${inner}</div>`, navLinks(3));
}

fs.writeFileSync(path.join(outDir, 'strata.html'), buildStrata());
fs.writeFileSync(path.join(outDir, 'diagnosis.html'), buildDiagnosis());
fs.writeFileSync(path.join(outDir, 'today.html'), buildToday());
console.log('生成完成:', outDir);
