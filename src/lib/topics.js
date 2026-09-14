/**
 * 主题标签器（方案文档第十节）
 *
 * 只有标题和摘要、没有正文，所以不做聚类，做词典命中。
 * 词典命中可解释，聚类不可解释 —— 而本产品每个结论都要能说出理由。
 *
 * 四级兜底：L1 词典命中 → L2 夹子名反推 → L3 字符 bigram 相似 → L4 未分类
 * 宁可留"未分类"灰块，也不硬塞主题：错标会直接毁掉屏三的理由可信度。
 */

/** 主题 → [半衰期天数, 关键词表]。半衰期 ≥ 1200 天视为长青类 */
export const TOPICS = {
  考研: [365, ['考研', '择校', '政治', '英语一', '英语二', '复试', '考纲', '真题', '上岸', '专业课']],
  'AI 工程': [270, ['LLM', '大模型', 'RAG', '微调', 'Agent', 'GPT', 'Transformer', 'prompt', '提示词', '向量', 'token', 'AI', '人工智能', '深度学习', '机器学习']],
  求职面经: [540, ['面经', '秋招', '春招', 'offer', '笔试', '简历', '面试', '实习', '校招', 'HR', '八股']],
  投资理财: [240, ['基金', '股票', '债券', '开户', '定投', '理财', 'A股', '港股', '美股', '收益率', '比特币', '加密货币', '期权', '期货', '衍生品', '套利', '仓位']],
  金融专业: [900, ['金融', '投行', '行研', '券商', '私募', '量化', '风控', '尽职调查', '估值模型', '资产', '交易员', 'CFA', '财务', '会计', '经济学']],
  体育竞技: [700, ['足球', '篮球', 'NBA', '世界杯', '球员', '中后卫', '中场', '前锋', '球队', '联赛', '欧冠', '梅西', 'C罗', '教练', '战术', '巅峰期']],
  动漫游戏: [1200, ['漫画', '动漫', '番剧', '海贼王', '火影', '游戏', '主机', 'Steam', '角色', '剧情', '二次元', '怪谈', '轻小说', '三国']],
  影视音乐: [1200, ['电影', '影评', '导演', '演员', '剧集', '音乐', '乐队', '歌手', '专辑', '风格', '编曲']],
  升学择校: [700, ['大学', '院校', '双非', '985', '211', '保研', '专业选择', '就业情况', '难考', '调剂', '本科']],
  工具软件: [300, ['插件', '快捷键', '配置', '教程', 'VSCode', 'Vim', 'Docker', 'Git', '命令行', '效率工具', '部署', '运维']],
  编程开发: [400, ['Python', 'JavaScript', 'Java', 'Go', 'Rust', '算法', '数据结构', '源码', '框架', '后端', '前端', 'API', '数据库']],
  写作方法: [1800, ['写作', '结构', '叙事', '表达', '文笔', '行文', '措辞', '修辞']],
  情绪心理: [1800, ['焦虑', '内耗', '边界感', '自洽', '情绪', '心理', '抑郁', '自卑', '安全感', '原生家庭']],
  人际关系: [1800, ['沟通', '相处', '社交', '朋友', '恋爱', '婚姻', '择偶', '亲密关系', '父母']],
  健康医学: [900, ['健身', '减脂', '睡眠', '疫苗', '养生', '体检', '饮食', '营养', '疾病', '医生', '脱发', '掉头发', '护肤', '牙齿']],
  职场发展: [720, ['职场', '晋升', '跳槽', '汇报', '同事', '领导', '加班', '裁员', '涨薪', '上班']],
  商业观察: [300, ['商业模式', '创业', '融资', '估值', '市场', '增长', '产品经理', '运营', '行业']],
  历史人文: [1800, ['历史', '朝代', '典故', '考据', '文化', '哲学', '古代', '文学', '名著']],
  生活消费: [400, ['装修', '租房', '买房', '汽车', '数码', '手机', '相机', '旅行', '美食']],
  学习方法: [1800, ['学习方法', '记忆', '笔记', '专注', '时间管理', '自律', '效率', '阅读方法']],
};

export const UNCLASSIFIED = '未分类';

/** 长青豁免线：半衰期 ≥ 1200 天 */
export const EVERGREEN_HALF_LIFE = 1200;

/** 标题时效标记：带年份/版本号/时效词 → 时效性强 */
export const TS_PAT =
  /(20[12]\d年?|v\d+(\.\d+)?|最新|今年|刚刚|速报|开户|冲刺|新版|升级|发布)/i;

/** L1：主题词典命中，返回命中次数最多的主题 */
function matchByDict(text) {
  const lower = text.toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const [topic, [, keywords]] of Object.entries(TOPICS)) {
    let hits = 0;
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = topic;
    }
  }
  return bestHits > 0 ? best : null;
}

/** L2：夹子名反推 —— 夹子名本身命中主题词时继承 */
function matchByFolder(folderTitles) {
  for (const t of folderTitles) {
    const hit = matchByDict(t);
    if (hit) return hit;
  }
  return null;
}

/** 字符 bigram 集合 */
function bigrams(s) {
  const clean = s.replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
  return out;
}

/** Jaccard 相似度 */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 给全部条目打主题标签，就地写入 _topic 与 _topicLevel
 * @param {Array} items 归一化后的收藏条目
 */
export function tagTopics(items) {
  const SIM_THRESHOLD = 0.16;

  // L1 + L2
  for (const it of items) {
    const text = `${it.title || ''} ${it.summary || ''}`;
    let topic = matchByDict(text);
    let level = 'L1';

    if (!topic) {
      const folders = (it.favlists || []).map((f) => f.title || '');
      topic = matchByFolder(folders);
      level = topic ? 'L2' : null;
    }

    it._topic = topic;
    it._topicLevel = level;
  }

  // L3：未命中的用字符 bigram 与已标注条目求最近邻
  const labeled = items.filter((it) => it._topic);
  const labeledGrams = labeled.map((it) => ({
    topic: it._topic,
    grams: bigrams(`${it.title || ''} ${it.summary || ''}`),
  }));

  for (const it of items) {
    if (it._topic) continue;
    const g = bigrams(`${it.title || ''} ${it.summary || ''}`);
    let best = null;
    let bestSim = 0;
    for (const ref of labeledGrams) {
      const sim = jaccard(g, ref.grams);
      if (sim > bestSim) {
        bestSim = sim;
        best = ref.topic;
      }
    }
    if (best && bestSim >= SIM_THRESHOLD) {
      it._topic = best;
      it._topicLevel = 'L3';
    } else {
      // L4：兜底就叫未分类，不硬塞
      it._topic = UNCLASSIFIED;
      it._topicLevel = 'L4';
    }
  }

  return items;
}

/** 取主题半衰期；未分类按中位数 400 天处理 */
export function topicHalfLife(topic) {
  if (topic === UNCLASSIFIED || !TOPICS[topic]) return 400;
  return TOPICS[topic][0];
}

/** 是否长青主题 */
export function isEvergreen(topic) {
  return topicHalfLife(topic) >= EVERGREEN_HALF_LIFE;
}
