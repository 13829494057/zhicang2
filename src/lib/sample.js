/**
 * 演示模式样本（方案文档：演示模式是 P0，不是 P2）
 *
 * 路演现场网络不可控，而本产品全部计算都在本地 —— 把脱敏快照喂给同一套
 * 指标层，就能在断网状态下完整演完三屏。
 *
 * 本文件构造的是跨年度样本，用于展示完整档形态（地层剖面 + 断层 + 腐坏度），
 * 真实账号数据量不足时页面会走轻量档，看不到屏一。
 */

const DAY = 86400;

function mk(title, keywords, favMonthsAgo, ageMonths, folder, type = 'answer', author = null) {
  const now = Math.floor(Date.now() / 1000);
  return {
    contentType: type,
    title,
    summary: keywords,
    url: `https://www.zhihu.com/answer/${Math.abs(hash(title + favMonthsAgo))}`,
    createdAt: now - ageMonths * 30 * DAY,
    favTime: now - favMonthsAgo * 30 * DAY,
    likeCount: 120 + (Math.abs(hash(title)) % 900),
    commentCount: 5 + (Math.abs(hash(title)) % 40),
    favoriteCount: 20 + (Math.abs(hash(title)) % 200),
    favlists: [{ urlToken: '1', title: folder, url: '' }],
    author: author ? { name: author, urlToken: 'a', url: '' } : null,
  };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** 考研上岸党样本：2023 密集收藏，2024Q1 后断层 */
export function buildSampleScan() {
  const items = [];

  const kaoyan = [
    '考研择校到底该怎么选，学硕专硕差别在哪',
    '政治怎么背才不忘，时间线梳理方法',
    '英语一阅读做到 30+ 的解题顺序',
    '复试面试常问的十个问题怎么准备',
    '专业课真题该刷几遍，哪一遍最关键',
    '考研择校避坑：这几类院校慎报',
    '上岸后回头看，我在复习上浪费的三个月',
    '考研政治冲刺阶段的取舍',
  ];
  kaoyan.forEach((t, i) =>
    items.push(mk(t, '考研 择校 政治 英语一 复试 真题 上岸', 34 - i, 36 - i, '考研资料', 'answer', '上岸学长阿泽'))
  );

  const job = [
    '秋招简历怎么写才能过筛，HR 到底看什么',
    '互联网大厂面经合集：一面到三面的差别',
    '收到两个 offer 怎么选，看这五个维度',
    '笔试算法题准备到什么程度够用',
    '实习转正的关键动作有哪些',
    '春招补录还有机会吗',
  ];
  job.forEach((t, i) =>
    items.push(mk(t, '面经 秋招 offer 笔试 简历 面试 实习', 22 - i, 24 - i, '求职', 'answer', '面试官老王'))
  );

  const ai = [
    '大模型微调到底该选 LoRA 还是全参',
    'RAG 系统的检索质量怎么评估',
    'Agent 框架横向对比，选型看什么',
    'prompt 工程还有价值吗，随模型变强会消失吗',
    '向量数据库选型：主流方案的取舍',
    'LLM 推理成本怎么压，token 账怎么算',
    '本地部署大模型真的划算吗',
    'Transformer 架构里最容易被误解的一点',
    '大模型幻觉能被彻底解决吗',
    'AI 工程师和算法工程师的能力差异',
  ];
  ai.forEach((t, i) =>
    items.push(mk(t, 'LLM 大模型 RAG 微调 Agent prompt token 向量', 12 - i, 13 - i, '稍后再读', 'article', 'AI 研究员陈'))
  );

  const writing = [
    '怎么把一件复杂的事讲清楚：结构先行',
    '叙事节奏是怎么控制的',
    '好的表达都在减少读者的认知成本',
    '写作卡住时，问自己这三个问题',
  ];
  writing.forEach((t, i) =>
    items.push(mk(t, '写作 结构 叙事 表达 文笔', 20 - i * 3, 40 - i, '写作方法', 'article', '编辑老李'))
  );

  const psy = [
    '内耗的本质是什么，怎么停下来',
    '边界感不是冷漠，是清楚自己的责任范围',
    '焦虑来的时候，先分清哪些是真问题',
  ];
  psy.forEach((t, i) =>
    items.push(mk(t, '焦虑 内耗 边界感 自洽 情绪', 15 - i * 2, 30 - i, '写作方法', 'answer', '心理咨询师苏'))
  );

  // 单独建夹的一条 —— 触发"投入证据"
  items.push(mk('这篇讲透了长期主义，值得反复读', '写作 表达 结构', 18, 20, '单独收藏', 'article', '编辑老李'));

  // 跨夹重复 —— 触发"重复囤积"
  const dup = mk('大模型时代，普通人的机会在哪', 'LLM 大模型 Agent', 9, 10, '稍后再读', 'article', 'AI 研究员陈');
  dup.favlists = [
    { urlToken: '1', title: '稍后再读', url: '' },
    { urlToken: '2', title: '写作方法', url: '' },
    { urlToken: '3', title: '求职', url: '' },
  ];
  items.push(dup);

  // 三种受限类型 —— 验证硬闸
  items.push(mk('一个讲大模型的视频', 'LLM 大模型', 5, 6, '稍后再读', 'zvideo', 'AI 研究员陈'));
  items.push(mk('随手记的一条想法', '写作 表达', 5, 6, '写作方法', 'pin'));
  items.push(mk('这个问题下有很多好回答', '考研 复试', 5, 6, '考研资料', 'question'));

  return {
    level: 'L2',
    requests: 0,
    items,
    coverage: { scanned: 5, folders: 5, note: '演示样本 · 考研上岸党（脱敏）' },
  };
}
