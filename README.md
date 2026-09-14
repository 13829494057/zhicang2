# 收藏夹考古 · 全栈 Demo

知乎黑客松 2026 校园新锐季参赛作品。接入知乎 OAuth 登录，读取并渲染当前授权用户的收藏夹、关注与创作数据。

## 快速开始

```bash
npm install
cp .env.example .env    # 填入凭证（本仓库的 .env 已配好，可直接跳过）
npm start               # http://127.0.0.1:3000
```

## 已实现功能

### 三屏产品形态（核心）

| 屏 | 回答什么问题 | 实现 |
|---|---|---|
| 屏零 · 授权扫描 | —— | 登录后自动扫描，实时计数（不是转圈） |
| 屏一 · 地层剖面 | 我这几年在关心什么，什么时候断了 | 季度 × 主题堆叠柱 + 断层标注 + 点色块下钻 |
| 屏二 · 体检报告 | 为什么它们死了，哪些该删 | 六张诊断卡 + 下钻抽屉 + 逐条勾选删除 |
| 屏三 · 今天读这篇 | 那我现在该读哪一篇 | 单条推荐 + 三行可追溯理由 + 换一篇 + 交接契约 |

三屏是一条收敛漏斗：几百条 → 六个诊断结论 → 一篇。

### 指标层（六个纯函数，零 LLM）

| 层 | 函数 | 输入 | 产出 |
|---|---|---|---|
| ① | `strata` | FavTime + 主题 | 季度 × 主题矩阵 → 屏一 |
| ② | `motive` | FavTime − CreatedAt | 三分类标签 → 屏二 / 理由句 |
| ③ | `decay` | 内容年龄 / 半衰期 | 腐坏度 → 删除建议 |
| ④ | `dormancy` | 各主题最后收藏时间 | 断层月数 → 屏一虚线 |
| ⑤ | `hoarding` | Favlists / Author | 重复 / 集中 / 漂移 → 屏二 |
| ⑥ | `reviveScore` | ②③④ 组合 | 排序分 → 屏三 |

阈值集中在 `src/lib/metrics.js` 的 `TH` 常量，现场可调。

### 主题标签器（四级兜底）

L1 词典命中（15 类主题）→ L2 夹子名反推 → L3 字符 bigram 最近邻 → L4 未分类。
宁可留"未分类"灰块，也不硬塞主题 —— 错标会直接毁掉屏三的理由可信度。

### 其他

| 功能 | 位置 |
|---|---|
| 知乎 OAuth 登录 | 首页按钮，token 只留服务端 |
| 用户信息展示 | 右上角头像 + 昵称 |
| 个人主页 | 点头像进入，关注 / 创作双 Tab 分页 |
| 演示模式 | `/?sample=1`，脱敏样本、零接口调用、断网可演 |
| 隐私说明页 | `/privacy.html` |

## 凭证配置

**所有凭证只通过环境变量注入，不写进源码。** `.env` 已被 `.gitignore` 忽略。

| 变量 | 说明 | 能否公开 |
|---|---|---|
| `ZHIHU_APP_ID` | 赛事页面创建项目后分配 | 可以，属公开配置 |
| `ZHIHU_APP_KEY` | 后端换 Token 专用 | **绝对不能** |
| `ZHIHU_ACCESS_SECRET` | developer.zhihu.com 自助申请 | **绝对不能** |
| `ZHIHU_REDIRECT_URI` | 必须与项目登记值完全一致 | 可以 |

> 这条对应官方提交前检查第 5 条：「App Key、Access Secret、OAuth Token 等凭证没有出现在
> 代码仓库、前端响应、日志、截图或视频中」。凭证写进源码会直接导致这一项不达标。

## 目录结构

```
src/
  server.js            入口，路由装配
  lib/
    zhihu.js           API 客户端（两个域、两套判据、Int64 无损解析）
    session.js         会话存储（内存 Map + LRU + TTL）
    topics.js          主题标签器（15 类词典 + 四级兜底 + 半衰期）
    metrics.js         指标层六函数 + 阈值总表 + 理由句生成
    scan.js            扫描编排（L1 速览 / L2 深挖）+ 三屏数据组装
    sample.js          演示模式脱敏样本
  routes/
    auth.js            OAuth 登录、回调、登录态、登出
    api.js             收藏夹 / 关注 / 创作 + 三屏扫描接口
public/
  index.html           三屏主体（屏零/一/二/三 + 下钻抽屉）
  profile.html         个人主页：用户信息 + 关注 / 创作
  privacy.html         隐私说明
  common.js            前端公共工具
  style.css            基础样式
  screens.css          三屏专用样式
scripts/
  probe.mjs            接口连通性自检
  probe-paging.mjs     分页与字段契约自检
  probe-metrics.mjs    指标层自检（真实数据）
  probe-full-tier.mjs  完整档自检（地层剖面/断层/长青豁免/硬闸）
```

## 自检脚本

```bash
node scripts/probe.mjs            # 四个接口连通性
node scripts/probe-paging.mjs     # 翻页、NextOffset 转型、字段契约
node scripts/probe-metrics.mjs    # 六卡数字、屏三理由、换一篇去重
node scripts/probe-full-tier.mjs  # 完整档：地层剖面、断层、长青豁免、硬闸
```

`probe-metrics.mjs` 的输出必须与页面六卡数字**逐位一致** —— 对不上就说明存在两套计算逻辑。

## 关键实现要点

这些都是官方文档里明确标注、且容易写错的地方：

1. **回调字段名不一致**：知乎回传的是 `authorization_code`，但 token 交换接口的表单字段叫 `code`。
   代码中两者都兼容，以 `authorization_code` 为主路径。

2. **回调不返 state**：官方实测确认授权回调不带回 `state`，因此关联性校验用 HttpOnly Cookie
   兜底，并对 state 做原子消费（取出即删），防重放。

3. **两套业务码不能混用**：
   - `openapi.zhihu.com` —— 检查 `access_token` / 用户对象是否存在，`code: 20000` 表示成功
   - `developer.zhihu.com` —— `Code === 0` 才是成功

4. **Int64 无损解析**：`uid` 和 `UrlToken` 可能超过 JS 安全整数范围，在 JSON 解析**之前**
   用正则转成字符串，不能先 `parse` 成 Number 再 `toString`。

5. **NextOffset 类型不一致**：响应里是 String，请求参数是 Int64。严格正则校验后转型，
   解析失败返回协议错误而非静默截断；翻页终止条件用 `IsEnd` 而不是累加条数。

6. **favlists 无分页**：服务端不返回 `Paging` 且忽略 `Offset`，`Limit` 上限 50。
   取满 50 条时页面会如实标注可能被截断。

7. **红线 —— token 失效不回落**：OAuth token 失效时停止读取，**绝不切换到 Access Secret
   本人账号**，否则访客会看到开发者自己的数据。

8. **空数据不是错误**：`Code=0` + `Items` 为空是合法业务状态，走空态页而非抛错。

## 自检脚本（见上方目录结构一节）

## 本地 UI 预览（可选）

未完成 OAuth 授权时，可用 Access Secret 本人身份预览登录态页面：

```bash
ALLOW_DEV_LOGIN=1 npm start
# 浏览器访问 http://127.0.0.1:3000/__dev/login
```

**生产部署不要设置 `ALLOW_DEV_LOGIN`。**

## 部署前必做

1. **先部署拿到稳定 HTTPS 域名**，再去赛事页面创建项目填回调地址——官方未说明回调地址
   创建后能否修改，顺序反了可能无法挽回。
2. `ZHIHU_REDIRECT_URI` 必须与登记值**完全一致**，包括协议、域名、路径、尾斜杠。
3. 多实例部署时，`src/lib/session.js` 的内存 Map 需换成共享存储（Redis 等），
   否则负载均衡会导致随机掉线。
4. 授权账号需**绑定手机号并完成实名认证**，否则 OAuth 校验必然失败。

## 额度提醒

用户数据接口按开发者账号计费，**所有访客共用同一个池子**。2026-09-13 实测
`user_data` 日额度为 **1,000 次**（非文档标称的 10,000）。

```bash
zhihu-cli quota    # 查看当日剩余
```

单次全量扫描消耗 `1 + Σ⌈每夹条数/50⌉` 次请求。公开访问前请先做限流与熔断，
详见方案文档第四十四节。
