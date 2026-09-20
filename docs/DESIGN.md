# 设计与实现说明

本文说明 SynthFlow 的内部机制。想先上手看 [`README.md`](../README.md)。

---

## 1. 总体结构

```
浏览器 (public/)                Node 服务 (src/)                 模型
─────────────────              ──────────────────               ─────
输入框每一笔改动  ──HTTP──▶  /api/input
                              │
                              ├─ analyzeIntent()        意图 0~1 + 理由
                              ├─ decidePromptChange()   增量/续写/重生成
                              │
                              ├─ 320ms 预演 (spec)  ──▶ provider.stream()
                              └─ 900/1600ms 提交    ──▶  （mock 或 OpenAI 兼容）
                                        ▲                        │
                                        │                  流式 SSE/HTTP
                                        │                        ▼
                              createProtocolParser() ◀──── 文本分片
                                        │
              SSE (/api/events) ◀───────┤
                                        │
        think / suggest / file / intent │
                                        ▼
                              workspace.applyOp()  →  沙箱写盘
                                        │
                              workspace.snapshot()  →  版本链
                                        │
                              session.recordCommit() → 上下文栈
```

分层原则：**判定与状态（`session.js`）不碰网络；网络与调度（`runner.js`）不改文件内容；
文件写入只走 `workspace.js`。** 这样每一层都能单独测（`scripts/smoke.mjs` 就是这么做的）。

---

## 2. 流协议

模型用**同一条流**交替输出四种通道，所以"边写代码边给建议"在协议层就是天然成立的：

```
<<<SF think>>>
推理内容（会被实时推到"思考"面板）
<<<SF /think>>>

<<<SF suggest kind="clarify|optimize|risk|test|a11y" title="标题" impact="high|medium|low" insert="可直接写进提示词的一句话">>
建议正文
<<<SF /suggest>>>

<<<SF file path="src/a.js" action="create|update|rewrite|delete" lang="js">>
文件内容，或补丁块（见下）
<<<SF /file>>>

<<<SF memory key="style.indent">>2<<<SF /memory>>>
```

**增量补丁**采用 Aider 风格的 search/replace，让模型有能力"只改几行"：

```
<<<<<<< SEARCH
const a = 1;
=======
const a = 2;
>>>>>>> REPLACE
```

### 解析器的三个关键决策

1. **容错**：接受 `>>` 或 `>>>` 结尾（真实模型经常少打一个尖括号）。
2. **只在真像标记时等待**：`isMarkerAttempt()` 只对 `<<<SF…` 或 ≤4 字符的 `<<<S` 前缀挂起等待，
   其它一律按普通文本逐字吐出。否则代码里的 `<<<<<<< SEARCH` 会被当成标记开头而破坏内容。
3. **通道内容即到即推**：`onThinkDelta` / `onFileDelta` 立刻发 SSE，所以前端看到的是"打字机"效果，
   而不是等整段结束。SSE 侧对高频 delta 做了 45ms 合并，避免刷爆事件流。

`scripts/smoke.mjs` 会用 1/2/3/7/13 字节的极端分片重放同一段协议，
断言解析结果**逐字段一致**——这是整个实时体验的地基。

---

## 3. 意图完整度判定（想法 6）

`session.analyzeIntent(text, { idleMs })` 输出 `{ score, complete, reasons, signals }`。

| 信号 | 权重 | 说明 |
| --- | --- | --- |
| 句末标点 `。！？!?；;` / `.` | +0.34 | 最强的"写完了"信号 |
| 长度 ≥ 6 / ≥ 18 / ≥ 40 | +0.30 / +0.12 / +0.06 | 太短的多半没写完 |
| 命中动作词（写/实现/优化/refactor/…） | +0.16 | 说明是完整祈使句 |
| 短指令白名单（"继续"/"go on"/"好的"） | +0.55 | 语义完整但很短 |
| 停顿 ≥ 0.7s / ≥ 1.2s | +0.06 / +0.12 | 停得越久越像写完了 |
| 括号 / 代码围栏 / 引号未闭合 | −0.35 / −0.30 | 明显还在输入中 |
| 结尾是连接词（的/和/然后/with/and…） | −0.38 | "我要一个可以…" 这类 |
| 结尾是逗号顿号 | −0.26 | |
| 结尾像没打完的单词 | −0.12 | |
| 相比上一次仍在增长 | −0.05 | |

`score ≥ 0.6` 视为写完。界面上会把 `reasons` 直接显示出来（例如"结尾是连接词「包含」，句子未完"），
所以判定不是黑盒——你能看到它为什么还在等。

### 两级兜底

- **预演门槛 0.32**：只要有一点轮廓就先跑预演，满足"打字时就已生成"。
- **停手兜底 0.42 + 1600ms**：句子没以标点结尾（`帮我写一个登录页`）但人已经停手了，
  也会自动开工并提示"检测到输入停顿（58% 把握），已按当前提示词开工"。不会让你干等。

---

## 4. 漂移决策：增量还是重生成（想法 4/7/9）

`session.decidePromptChange(prev, next, state)`：

```
similarity 使用字符 3-gram 的 Dice 系数（对中文友好，且对"尾部追加"不敏感）
ratio = 1 - similarity

prev 为空                       → regenerate（首次）
prev === next                   → noop
纯尾部追加：
    已有代码 且 ratio < 0.8     → continue    （增量续写，附"新增内容"指令）
    其它                        → incremental
中间被改写：
    ratio < 0.06                → noop（打字抖动）
    ratio < 阈值                → incremental（附"删掉了什么/新要求是什么" + 锚点文件）
    否则                        → regenerate
阈值：代码量 < 24KB 时 0.55，≥ 24KB 时收紧到 0.42   ← 想法 4 的"prompt 很长时不该重生成"
```

`incremental` 会生成一段明确指令，例如：

```
用户修改了提示词的中间片段：
- 删除/替换掉：「蓝色主题」
- 新的要求：「暗色主题」
请**只针对受影响的部分做增量补丁**（使用 search/replace），不要全量重写整个项目。
重点检查这些文件：src/styles.css, src/main.js
```

**锚点文件**来自 `runner.recentFiles`——最近被写入或被用户打开过的 8 个文件，天然贴合"自动定位对应上下文片段"。

---

## 5. 预演 → 采纳：省钱的关键（想法 1/2）

```
onInput(text)
  ├─ 320ms 后启动 spec 运行（kind='spec'）  ← 不落盘，只推 SSE 给前端预览
  │     结果存进 this.draft
  └─ 判定完成后（900ms 或 1600ms 兜底）调用 commit()
        ├─ 若 draft 存在且提示词漂移 ≤ 0.06  → 直接 #applyRun(draft)   ★ 0 次额外调用
        └─ 否则丢弃 draft，按新决策重新生成
```

注意一个容易写错的地方：**预演运行也必须使用真正的 mode（continue / incremental）**，
而不是笼统地当成"预演模式"。否则用户在已有项目上追加需求时，预演会产出整份重写，
采纳之后既不省钱也可能覆盖掉正确的代码。早期版本就踩过这个坑，`scripts/smoke.mjs`
里"追加需求 → 走增量补丁，不改动其它文件"这条用例专门守住它。

`speculative: true` 只作为**提示**加进 system/user 消息（"用户可能还在打字，先给结论性思考与建议"），
不改变增量策略。

---

## 6. 上下文栈与版本链（想法 5/8/13）

**上下文栈** `session.segments`：每一次对提示词的实质改动都留痕，字段包括
`kind`（typed / adopt / turn / spec / revert）、`delta`、`runId`、`versionId`、`files`、`reverted`。
`compilePrompt()` 就是当前输入框内容；其它上下文（项目地图、RAG 命中、技能、用户画像）
在 `prompt.js` 里组装成消息，不污染用户的输入框。

**版本链与游标** `session.versions` + `session.activeIndex`：`v0` 是空项目基线，之后每轮一个版本，记录
`snapshotId / promptBefore / promptAfter / files / summary`。版本记录**永远保留**，回退只是把游标左移。

```
moveVersion('back')    游标 -1 → 恢复该版本快照 → prompt = 该版本 promptAfter
moveVersion('forward') 游标 +1 → 同上
recordCommit()         若游标不在末尾 → 丢弃右侧分支（记入 droppedBranches，界面明确提示）→ 压入新版本
```

版本号由 `versionSeq` 单调递增产生（不是 `versions.length`），否则回退后再提交会撞号。
`versionList()` 返回 `{ versions, activeVersionId, canBack, canForward }`，前端据此启用/禁用 ⏪⏩ 按钮。

快照是**全量文本拷贝**（单文件上限 2MB），保留最近 60 个，超出按 `workspace.prune()` 自动淘汰。
在 `.synthflow/snapshots/index.json` 里可以随时看占了多少磁盘。

---

## 7. 文件补丁的三层兜底 + 自动重试

`workspace.locateBlock(haystack, needle)`：

1. **精确匹配** `indexOf` —— 正常情况走这里。
2. **归一匹配**：逐行 trim 后滑动窗口比对，容忍缩进/行尾空白漂移（模型最常见的失误）。
3. **首行锚点**：用 SEARCH 里第一行有意义的代码定位，再按行数截取区间。

补丁有多个块时，命中几个就应用几个；一个都没命中才判定为该操作失败，并回报
"补丁未命中（未匹配片段: …）"。**失败不会中断其它文件**，`run:done` 里会列出失败清单。

**自动重试（v2）**：整轮结束后若存在未命中的补丁，`runner.#maybeRetryPatch()` 会发起一次定向重试——
把**这些文件的真实当前内容**放进上下文最前面（`run.forceFiles` 会插到 `recentFiles` 队首，
`selectContextFiles` 按此优先级挑选），并给出一段硬性指令（SEARCH 必须逐字一致、只动这些文件）。
重试运行带 `retryOf` 标记，**不会递归重试**；可用 `patchRetry: false` 关闭。重试会单独产生一个版本
（摘要前缀 `补丁重试 · `），所以"回退一步"能精确退掉重试本身。

路径安全由 `util.resolveInside()` 保证：**先按原始输入判定绝对路径**（`/etc/passwd`、`D:\x`、`~/x` 直接拒绝），
再做 `../` 逃逸检查。任何越界操作都会被拒绝并回报，而不是静默写到别处。

---

## 8. 并发、取消与恢复

- **取消**：每次运行持有 `AbortController`；`provider.stream()` 是 async generator，
  取消时停止消费，generator 的 `finally` 自然收尾。真实模型侧的 `fetch` 会收到 abort 信号。
- **生成中又输入**（想法 9）：不打断当前运行，只置 `pendingInput = true`；本轮结束后
  `#maybeResume()` 自动按当前提示词发起一轮**增量**生成。
  只有漂移 > 0.7（整体换需求）才会取消当前运行。
- **定时器纪律**：`specTimer / commitTimer / settleTimer` 在每次 `onInput` 与 `cancel()` 里统一清理，
  避免"旧提示词的提交"在新提示词之后触发。
- **错误隔离**：`applyOp` 抛异常会被收进结果数组；`listTree` 有 `safeTree()` 兜底；
  `#consume` 的所有出口都包了 catch。任何一个环节出错都只会变成一条 `run:error` 事件或一个 toast，
  **不会让服务进程挂掉**。

---

## 9. RAG 与习惯记忆（想法 11/13）

- **检索**：`rag.js` 自实现 BM25（k1=1.2, b=0.75），文档 = 工作区文件按 48 行/8 行重叠切片 +
  技能文档。分词对中文做单字 + 双字组，对拉丁做词级。索引落在 `.synthflow/index.json`，
  签名（文件列表 + size + mtime）变了才重建。检索结果按"与本次提示词的相关度"取前 4 段注入。
- **技能**：`.synthflow/skills/*.md`，支持极简 frontmatter（`name` / `description` / `triggers`）。
  命中触发词就作为"必须遵守的规则"注入。这让 SynthFlow 天生可扩展成"你的团队规范助手"。
- **习惯画像**：`memory.js` 累计提示词、语言分布、缩进/引号/分号偏好、建议采纳与忽略的分布、
  高频说法（→ 变成输入框下方的快捷片段 chips），并生成一段中文"用户画像"注入 system prompt。
  你忽略得多的建议类型，它下次会少提。

---

## 10. 测试策略

| 层次 | 用例 | 覆盖 |
| --- | --- | --- |
| 工具层 | 5 | diff / 相似度 / 变更跨度 / 紧凑差异压缩 / 新增行号计算 |
| 协议层 | 4 | 分片一致性（1~13 字节）、围栏剥离、补丁解析 |
| 工作区 | 5 | 补丁三层兜底、路径逃逸六种写法、快照回滚、项目地图 |
| 判定层 | 3 | 半截句、完整句、停顿单调性 |
| 决策层 | 5 | 追加/中改/换需求/大项目阈值/noop |
| 会话层 | 7 | 上下文栈、采纳、版本回退、**回退后前进**、**历史版本上继续生成丢弃分支**、版本号不撞号 |
| RAG/记忆 | 2 | BM25 召回、技能命中、画像沉淀 |
| 调度层 | 10 | 预演不落盘、多文件生成、增量补丁、一键回退、**前进**、**补丁自动重试**、**重试开关**、**建议延后推送**、采纳跟进、定时参数兜底 |
| HTTP/SSE | 10 | 健康检查、**默认不暴露 mock**、静态资源、SSE 订阅、打字即生成、意图事件、REST 全家桶、**回退/前进事务**、404 不崩 |
| 前端契约 | 7 | id 引用完整、`el.*` 声明、关键 class 覆盖、**亮色主题令牌完整**、静态资源可路由、无 import/TS 注解、**DOM 垫片上真跑 app.js** |
| 高亮器 | 1 | 直接执行 app.js 里的真实实现，校验逐行不丢行、token 与 HTML 转义（XSS） |
| 配置健壮性 | 1 | **BOM / 空文件 / 坏 JSON 都能回落**（记事本与 PowerShell 会写 BOM） |

合计 **60 项**，全部离线、不消耗 API 额度。

`scripts/livecheck.mjs` 是**在线验收**：对着真实运行中的服务跑一遍五个场景，
既验证产品，也验证你配置的模型是否真的可用（离线模式用 `--provider mock` 起服务即可零成本跑）。

### 无头浏览器不可靠，于是换成"最小 DOM 垫片"

本机的无头 Edge 多次挂起且会在临时目录堆几十 MB，所以前端不再依赖浏览器验证：
`smoke.mjs` 用一个最小的 DOM 垫片（`querySelector` 返回记忆化桩节点、`EventTarget` 当 window、
假 `fetch`/`EventSource`/`localStorage`）把 **真实的 app.js 源码**执行一遍，等 `boot()` 跑完，
再手动派发 `intent / run:start / think:delta / file:start / file:delta / file:end / run:applied / run:done / state`
等 SSE 事件，断言状态栏、轮次块、用量显示都正确。

这一条实测抓出了三个会白屏的真 bug：

1. `/api/file` 返回非预期结构时 `S.files[path] = undefined`，随后 `reduce((a,c)=>a+c.length)` 直接抛错
   → 现在统一走 `cacheFile()/pullFile()`，校验类型并逐级回落。
2. 每个 `state` 事件都会用 `memory.runs` 覆盖客户端的用量计数（本地累加被冲掉）
   → 改成**以服务端 `session.stats` 为唯一数据源**，客户端只显示。
3. `run:done` 刚设置的"已写入 N 个文件"会被紧随其后的 `state` 立刻覆盖成"空闲"
   → 完成态有 6 秒保护期。

---

## 11. v3 架构补充

### 11.1 暂存层（overlay）：让 AI 敢碰真实项目

`Workspace` 的 `root`（目标项目）与 `overlayDir`（写入落点）是分开的两个概念：

```
直接模式   overlayDir === root         → 写盘立即生效（默认 workspace/ 用这个）
暂存模式   overlayDir = projects/<p>/staging  → 读合并视图，写只进暂存层
```

- `read(rel)`：暂存层优先，否则读目标项目
- `write(rel, content)`：**永远写暂存层**
- `remove(rel)`：暂存层有就删它；只有项目里有就记进 `deleted` 集合（延迟删除）
- `listFiles()/listTree()/repoMap()/RAG`：全部基于合并视图
- `pending()`：暂存层 vs 项目的逐文件差异（added / modified / deleted + +/- 行数）
- `applyPending()`：确认后逐文件拷贝进项目（先打快照），然后清空暂存层
- `discardPending()`：清空暂存层，目标项目分毫未动

这套语义让"AI 看得到真实项目"和"AI 不会改坏真实项目"同时成立。快照也基于合并视图，
所以**回退**在两种模式下都正确：直接模式清空工作区再重建；暂存模式清空暂存层，
合并视图自然回落到项目真实内容（不会误删项目里的文件 —— 这一点在冒烟测试里有专门用例）。

### 11.2 项目风格扫描（`style.js`）

扫描合并视图里的代码文件（上限 160 个），统计出：

| 维度 | 方法 |
| --- | --- |
| 缩进 | 统计有缩进的行，Tab 票数 vs 空格票数；空格取"最可能的步长"（2/4/8 中按 `票数/步长` 打分） |
| 引号 / 分号 | 统计 `'` 与 `"`；统计语句行里以 `;` 结尾的比例（样本 < 20 行时不表态） |
| 注释语言 | 抽出所有注释，比较 CJK 字符数与英文词数 |
| 命名 | 函数/类/常量声明名 → camel / Pascal / snake / CONSTANT 投票（少于 3 票不表态） |
| 文件名 | 文件名 → kebab / Pascal / camel / snake 投票（少于 2 票不表态） |
| 模块写法 | `import/export` 行数 vs `require/module.exports` 出现次数 |
| 技术栈 | 读 `package.json` 的 dependencies + devDependencies 白名单匹配 |

结果缓存在 `projects/<p>/style.json`，签名（文件列表 + 大小 + 内容长度）不变就复用。
只有扫描到 ≥3 个文件、且至少有一条明确结论时才注入提示词 —— 信号不足时宁可不说话，
否则会给模型错误的约束。

### 11.3 轮次时间线（想法 3）

`session.timeline` 保存最近 40 轮：`{id, kind, mode, at, ms, files, versionId, thoughts[], suggestions[], ops[]}`。
思考每段截断 3000 字符、最多 6 段，建议最多 8 条 —— 目的是"刷新页面还能看到"，不是做完整审计日志。
前端 `rehydrateTimeline()` 把它们按原样式重建为折叠的轮次块（恢复的建议标记为已处理，避免误点）。

### 11.4 建议过滤的双保险（想法 5）

1. **提示词层**：把关闭的类型明确列给模型（"本轮不要输出这些类型的建议"），并给出每轮条数上限 ——
   这是省 token 的关键，避免生成完再丢弃。
2. **服务端层**：`#filterSuggestions()` 在推送前再过滤一次并截断条数。模型不听话时兜底。

### 11.5 版本"待确认"（想法 2）

**文件当轮就落盘**（这是"不中断"的前提），确认动作只决定"要不要把这个版本留下"：

```
recordCommit({ confirmed: saveMode !== 'confirm' })
   confirmed=false → 时间线标「待确认」，轮次块出现 [保留] [丢弃]
confirmVersion(id) → 标记已确认
discardVersion(id) → 等价于 moveVersion('back')，并把该版本从历史里退掉
```

`pendingConfirm` 会随版本列表一起下发，界面据此显示"待确认"徽标。

### 11.6 多配置档（想法 8）

```
config.json
  ├── profiles: [{id, name, provider, baseUrl, model, apiKey, temperature, maxTokens}]
  └── activeProfileId
```

`loadConfig()` 把 `activeProfile` 派生到顶层的 `provider/baseUrl/model/apiKey`，所以下游（Provider、Runner）
完全不用感知配置档的存在。`normalizeProfiles()` 负责把 v2 的单份配置迁移成 `profiles[0]`。
接口只回传掩码（`apiKeySet` + `sk-…abcd`），明文 Key 永不出网。

### 11.7 前端模块化与"能在 Node 里跑起来"的取舍

前端拆成 5 个**经典脚本**（不是 ES Module）：`core → editor → layout → panels → app`。
这样做的直接好处是冒烟测试可以把它们按顺序拼成一个函数体，在最小 DOM 垫片上**真跑一遍** —— 
不用无头浏览器也能抓住"某个 id 拼错 / 变量未定义 / boot 抛错"这类白屏级问题。
代价是模块间共享全局作用域（靠严格的命名约定维持：`el/S/LS/Editor/Layout/Panels`）。

`Editor` 是一个对象字面量而不是 class：**对象字面量不能用 `#private` 方法**，
这一点被 DOM 垫片测试当场抓到过（写的时候很像合法语法）。

### 11.8 预演门槛：分数之外还要看"写了多少"

最初只按意图分 `>= 0.32` 决定是否预演。实测发现一个反直觉的坑：

> `新建 src/datefmt.js 导出 formatDate 函数，把时间戳…` 打到「…把」时，结尾是连接词「把」，
> 被扣 0.38 分 → 分数 0.15 → **不预演**。而这恰恰是"用户明显在写一个完整需求"的时刻。

连接词扣分的本意是"句子没写完，别急着改代码"，但它不该**同时**关掉预演 —— 预演本来就不落盘。
所以门槛改成：

```js
const enoughContext = intent.signals.length >= 12 && intent.signals.hasVerb;
const specWorthy = intent.score >= 0.32 || enoughContext;
```

即"分数够，**或者**已经写了足够长且带明确动作词"。修复后 livecheck 场景 A 才稳定测出预演路径。

- **轮次块**：每轮生成是一个 `.stream-run`，头部显示 `第 N 轮 · 模式 · 时间 · 文件数 · 耗时`，
  按 `data-kind`/`data-mode` 着色；↑↓ 在轮次间跳转并 `anchor-flash` 高亮；整块可折叠。
  自动滚动只在用户已经贴近底部时才发生（`streamNearBottom()`），否则保持他的阅读位置。
- **思考默认折叠**：流式时展开（`.think.streaming`），`think:end` 时写入首句摘要并收起；
  面板右上角可全局切换，偏好存 localStorage。
- **差异就地切换**：`S.view = 'code' | 'diff'`，`Ctrl+D` 或工具栏分段控件切换。
  差异来自服务端 `compactDiff()`（只留变化行 + 2 行上下文，未改动区域折叠为 `{type:'gap',count}`）。
  代码视图用 `highlightLines()` **逐行**高亮，因此可以给"本轮新增行"加 `mark-added` 绿点标记
  ——逐行输出是必须的，否则跨行的模板串/块注释会把标签截断、行号整体错位。
- **状态栏**取代了绝大多数 toast：`输入中 / 预演中 / 正在生成 / 正在写入 / 已写入 N 个文件 / 补丁重试中 / 出错了`。
  剩余的 toast 只覆盖"需要你决策或出错"的情况，并做 4 秒去重与最多 3 条上限。

---

## 12. v3.1 架构补充

### 12.1 同步生成开关（想法 1）

`runner.syncEnabled` 是一个**闸门**，放在 `onInput()` 里、所有定时器之前：

```
onInput -> analyzeIntent -> emit intent -> if (!syncEnabled) return   // 只上报意图，绝不排程
                                        -> busy? 排队 : 排 spec/commit/settle
```

关掉时同时 `clearTimeout` 三个定时器并取消在跑的那一轮，所以"点停止"是立即生效的，
不是等这一轮跑完。「立即生成」走的是 `commit()`，不经过这道闸门 —— 它本来就是手动触发。

`POST /api/sync {enabled}` 切换，服务端回广播 `sync` 事件，前端据此切换两个按钮的文案与配色。

### 12.2 手动版本模型（想法 11）

原设计"每轮自动产生版本"被否掉了，改成：

```
#applyRun:
  1. 先打一个 pre-round 快照（不写进版本链，只用于"撤销未保存的改动"）
  2. 应用文件操作（文件仍然立即落盘 —— 这是"不中断"的前提）
  3. saveMode === 'auto'  → recordCommit() 产生版本（旧行为，保留为选项）
     saveMode === 'manual'（默认）→ session.setPendingRound({preSnapshotId, files, promptBefore, round++})
  4. run:done 带 pendingSave / unsavedCount，界面在轮次块里放一个醒目的「保存为版本」

POST /api/version/save       -> 现在才 snapshot + recordCommit，然后清空 pendingRound
POST /api/version/undo-round -> restore(preSnapshotId)，把未保存的改动整体撤掉
```

关键点：**"没有版本"不等于"没有安全网"**。回退（⏪）走的是版本链，只能回到你保存过的版本；
而"撤销未保存的改动"退回的是本轮开始前的状态。两者职责分离，界面上也分得很清楚
（顶栏 ⏪ 是版本回退；未保存时 ⏪ 优先做撤销）。

### 12.3 定位索引（想法 4）

`projectmap.js` 的目标是回答一个具体问题：**用户说的那个东西在哪个文件里。**

三层来源：

1. **路由**：vue-router 的 `{path, component}` / 动态 `import()`、react-router 的 `<Route>` → `路由 → 文件`
2. **注解**：Spring 的 `@RequestMapping/@GetMapping/...` + `*Controller` 类名 → `接口路径 → 文件`
3. **符号**：跨语言的顶层声明正则（`class|interface|enum|record|function|def|struct|type|const`）→ `文件名 → 主要声明`

`locate()` 在 name / path / route / symbols 四个维度上加权打分，同名文件只留最高分。
**中英对照表**（`SYNONYMS`）解决"用户说中文、代码写英文"的错位：
「简历列表页」要能匹配到 `resume.ts`，「后端接口」要能匹配到 `controller/service`。

命中结果不只是"显示给你看"：`#consume()` 会把定位到的文件**排到上下文最前面**
（`recentFiles` 队首），`selectContextFiles()` 按这个顺序优先塞进提示词 —— 这才是"快速定位"的实际收益。
索引缓存在 `projects/<p>/projectmap.json`，签名（文件列表 + 大小）不变就复用。

### 12.4 按需加载（想法 15 的根因）

原来 boot 与 `refreshAll()` 都会 `for (const rel of tree.files) await pullFile(rel)` —— 顺序发几百个 HTTP 请求，
在真实项目上界面直接失去响应（用户看到的就是"点文件没反应"）。
现在只拉 `GET /api/tree` 的目录结构，文件内容**点开哪个拉哪个**（`openFile` 内部 `pullFile`），
树上的 pending / 手改标记来自服务端元数据而不是文件内容。这一条同时修掉了"大项目卡死"和"点文件没反应"。

### 12.5 前端重置（想法 13）

切项目 = 换 session。服务端 `reloadServices()` 除了常规事件外会先广播一个 `reset`，
带着新的 projectDir / staging / prompt / timeline。前端 `applyReset()` 做一次彻底清场：
文件缓存、标签页、轮次、建议、选区、手改记录、折叠状态全部清空，编辑器模型解绑，然后再 `refreshAll()`。
**不能只依赖 `timeline` 事件**：新会话时间线是空的，原来的实现遇到空数组直接 return，界面就留着旧内容了。

### 12.6 暂存模式回退的最小化（顺手修的缺陷）

原来 `restore()` 在暂存模式下会把快照里的**全部文件**写进 staging —— 一次回退就等于把整个项目复制一份。
现在：

```
for (rel of snapshot.files)   if (readProject(rel) === content) continue   // 与项目一致就不落暂存层
for (rel of projectFiles)     if (!(rel in snapshot.files)) deleted.add(rel) // 快照里没有 → 标记待删除
```

既省磁盘，语义也更准：暂存层里**只应该出现真正的差异**。

---

## 13. 已知取舍

- 回退是**线性版本链 + 游标**：能自由往返，但在历史版本上继续生成会丢弃右侧分支（界面会告知丢弃了几个）。
  版本树会让 UI 与心智负担都变重，当前不值。
- 预演结果在漂移 ≤ 0.06 时才被采纳。这个阈值偏保守——宁可多花一次调用，也不要落一份对不上需求的代码。
- 快照是全量拷贝而非增量。文本文件 + 60 个版本上限，实测几百 KB 量级，不值得为此引入复杂度。
- 前端没有语法高亮之外的"智能"（无 LSP、无类型检查）。它是需求到代码的通道，不是 IDE 替代品。
- 逐行高亮意味着跨行结构（块注释、模板字符串）在行边界处会重新开标签，视觉上分段但内容无误。
  这是"能标注新增行"必须付出的代价。Monaco 可用时不存在这个问题（走官方装饰器）。
- **暂存模式是覆盖式应用**，不做三方合并：同名文件直接用暂存内容覆盖。所以默认不开自动应用。
- **目标项目的读取是全局的**：切到真实项目后，风格扫描与 RAG 会读它的代码。追求极致隔离的话，
  可以把 `styleScan` 的 `maxFiles` 调小，或把目标目录指回 `workspace/`。
- **Monaco 是唯一的外部依赖**（裁剪后 25 MB）。它加载失败会自动降级为只读高亮，
  但降级路径的"编辑"能力就没了 —— `/selftest.html` 会明确报出是哪一步失败。
- 内置演示模型保留在代码里（`--provider mock`），因为它是离线回归测试的唯一手段；
  界面上已彻底隐藏，不影响正常使用。
- **"没有版本"不等于"没有安全网"**：手动保存模式下时间线只显示你保存过的版本，
  未保存的改动靠内部回合前快照兜底（撤销）。这是刻意的职责分离，不是遗漏。
- **同步生成关掉后，意图判定仍在跑**（输入框下方那条进度条还会动）。保留它是因为
  "我知道它理解到哪一步了"本身有价值；如果你希望彻底静默，可以再把 `intent` 事件也关掉。
