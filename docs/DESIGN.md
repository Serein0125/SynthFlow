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

**版本链** `session.versions`：`v0` 是空项目基线，之后每轮一个版本，记录
`snapshotId / promptBefore / promptAfter / files / summary`。

**回退**（`session.rollback()`）：

```
把工作区清空，按上一个版本的快照重建（工作区由 SynthFlow 独占管理，所以整目录重建是安全的）
删掉该版本及其之后的版本记录
把它们的段落标记为 reverted
prompt 恢复成该版本的 promptBefore   ← "这句话还没输入时"的状态
追加一条 kind='revert' 的栈记录
```

快照是**全量文本拷贝**（单文件上限 2MB），保留最近 60 个，超出按 `workspace.prune()` 自动淘汰。
在 `.synthflow/snapshots/index.json` 里可以随时看占了多少磁盘。

---

## 7. 文件补丁的三层兜底

`workspace.locateBlock(haystack, needle)`：

1. **精确匹配** `indexOf` —— 正常情况走这里。
2. **归一匹配**：逐行 trim 后滑动窗口比对，容忍缩进/行尾空白漂移（模型最常见的失误）。
3. **首行锚点**：用 SEARCH 里第一行有意义的代码定位，再按行数截取区间。

补丁有多个块时，命中几个就应用几个；一个都没命中才判定为该操作失败，并回报
"补丁未命中（未匹配片段: …）"。**失败不会中断其它文件**，`run:done` 里会列出失败清单，
界面上弹出黄色提示。已成功写入的文件保持生效——宁可部分成功并告知，也不要整轮回滚。

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
| 工具层 | 3 | diff / 相似度 / 变更跨度 |
| 协议层 | 4 | 分片一致性（1~13 字节）、围栏剥离、补丁解析 |
| 工作区 | 5 | 补丁三层兜底、路径逃逸六种写法、快照回滚、项目地图 |
| 判定层 | 3 | 半截句、完整句、停顿单调性 |
| 决策层 | 5 | 追加/中改/换需求/大项目阈值/noop |
| 会话层 | 5 | 上下文栈、采纳、版本回退、回退后再提交 |
| RAG/记忆 | 2 | BM25 召回、技能命中、画像沉淀 |
| 调度层 | 5 | 预演不落盘、多文件生成、增量补丁、一键回退、采纳跟进 |
| 时序安全 | 1 | 定时参数缺失/为 null 时不得退化成"立即提交" |
| HTTP/SSE | 9 | 健康检查、静态资源、SSE 订阅、打字即生成、意图事件、REST 全家桶、回退、404 不崩 |
| 前端契约 | 5 | id 引用完整、`el.*` 字段声明、关键 class 覆盖、静态资源可路由、无 import/TS 注解 |
| 高亮器 | 1 | 直接执行 app.js 里的真实实现，校验 token 与 HTML 转义（XSS） |

合计 **48 项**，全部离线、不消耗 API 额度。

`scripts/livecheck.mjs` 是**在线验收**：对着真实运行中的服务跑一遍五个场景，
既验证产品，也验证你配置的模型是否真的可用。

---

## 11. 已知取舍

- 回退是**线性**的，没有 redo / 分支。版本树会让 UI 与心智负担都变重，当前不值。
- 预演结果在漂移 ≤ 0.06 时才被采纳。这个阈值偏保守——宁可多花一次调用，也不要落一份对不上需求的代码。
- 快照是全量拷贝而非增量。文本文件 + 60 个版本上限，实测几百 KB 量级，不值得为此引入复杂度。
- 前端没有语法高亮之外的"智能"（无 LSP、无类型检查）。它是需求到代码的通道，不是 IDE 替代品。
