# 调研笔记：别人是怎么做的，SynthFlow 借鉴了什么

调研范围：主流 AI 编程工具（Cursor / Copilot / Continue / Aider / Cline / Claude Code / Zed）的
补全与生成机制。目标是回答一个问题——**"边打字边生成 + 并行建议"这件事，业界已经解决到哪一步了？**

---

## 1. 业界现状

| 产品 | 机制 | 与本项目的差距 |
| --- | --- | --- |
| **GitHub Copilot** | 防抖 + **请求取消**：每次击键重置定时器，旧请求立即 abort | 只补"当前光标处几行"，不理解一句话的完整需求 |
| **Cursor Tab** | 预测下一处编辑并给出 diff 预览，Tab 采纳；支持"跳到下一个预测点" | 作用在**已有代码**上，不负责"从需求生成功能" |
| **Zed edit prediction** | 把预测编辑直接应用到缓冲区，显示为幽灵文本 | 同上，单点编辑 |
| **Continue / Tabby** | 自动补全子系统：多行 FIM、LRU 缓存、按上下文裁剪、取消与去重 | 补全导向，无需求级编排 |
| **Aider** | **search/replace 补丁块**、repo map（用 tree-sitter 提炼符号）、每次改动自动 commit、`/undo` | 需要你**手动回车**才执行；没有"打字即生成"；但**补丁语义与版本管理是行业标杆** |
| **Cline / Roo Code** | 多文件 diff 应用 + **checkpoint**（每步快照，可回滚） | 对话式、回合制，生成时用户插话只能排队 |
| **Claude Code** | **Speculation（预判执行）**：预测下一步动作并在 fork 中预先执行，命中则直接采用 | 预测的是"下一条命令/编辑"，不是"用户下一句话" |

关键文献与出处：

- [Claude Code 预判执行系统拆解](https://cloud.tencent.cn/developer/article/2653154) —— "speculation" 的工程实现思路，本项目预演机制的灵感来源。
- [Continue 自动补全子系统（DeepWiki）](https://deepwiki.com/continuedev/continue/6.4-autocomplete-system) —— 防抖、取消、缓存、上下文裁剪的标准做法。
- [AI 编程助手系统设计：code_copilot](https://github.com/harshuljain13/llm-inference-at-scale/blob/master/content/11_system_designs/10.2_code_copilot/code_copilot.md) —— 延迟预算与流式架构的系统视角。
- [coding-with-ai: autocomplete 章节](https://lem.che.udel.edu/git/furst/coding-with-ai/blame/commit/d2ca02bd90b1d91afc8277b9b3fcb664c4fba772/03-autocomplete/README.md) —— 教学向的补全原理梳理。
- 开源仓库（直接可读源码的）：[Aider](https://github.com/Aider-AI/aider)、[Continue](https://github.com/continuedev/continue)、[Cline](https://github.com/cline/cline)、[Roo Code](https://github.com/RooCodeInc/Roo-Code)、[Tabby](https://github.com/TabbyML/tabby)、[Zed](https://github.com/zed-industries/zed)。

---

## 2. 空白在哪里

把上面的机制按"用户处于哪个阶段"排一下，缺口非常清楚：

```
用户写需求 (prompt)          用户看代码            用户改需求
──────────────────           ──────────            ──────────
Copilot/Tab:  ✗ 不工作        ✓ 补全                ✗
Cursor Tab:   ✗ 不工作        ✓ 预测编辑            ✗
Aider:        ✗ 手动回车      ✓ 补丁+commit         ✓ 重跑（可能全量重写）
Cline:        ✗ 手动回车      ✓ 多文件+checkpoint   △ 排队
Claude Code:  ✗ 手动回车      ✓ 预判命令            △ 重新规划
──────────────────           ──────────            ──────────
SynthFlow:    ✓ 打字即生成    ✓ 流式+自动跳转       ✓ 漂移决策/增量补丁/回退
              ✓ 并行给建议
```

**没有产品把"用户正在打的这句话"当成生成的输入源。** 所有工具都要求你先"提交"（回车 / Tab / 发送），
然后在生成期间把你当成旁观者。这正是本项目的立足点。

---

## 3. 明确借鉴了什么

| 借鉴对象 | 借鉴内容 | 在 SynthFlow 里的落点 |
| --- | --- | --- |
| Aider | SEARCH/REPLACE 补丁块语法 | `protocol.js` 的 `parseFilePayload` |
| Aider | repo map（项目符号摘要进上下文） | `workspace.repoMap()` |
| Aider | 每次改动一个可回滚单元 | `session.versions` + 快照链 |
| Continue / Copilot | 输入防抖 + 立即取消过期请求 | 前端 180ms 节流上报 + `AbortController` |
| Claude Code | 预判执行 → 命中就直接采用 | `runner.draft` 的预演采纳机制 |
| Cline / Roo | checkpoint 回滚 | `workspace.snapshot/restore` + 一键回退 |
| Cline / Roo | 多文件 diff 应用与失败清单 | `applyOp` 逐文件结果 + 未命中提示 |

## 4. 明确**没有**照抄的地方

- **不做 FIM（fill-in-the-middle）补全**：那是 IDE 内联补全的活，需要编辑器宿主。
  SynthFlow 做的是"需求 → 功能级代码"，粒度更粗、价值更高。
- **不做 tree-sitter repo map**：会引入原生依赖（编译工具链、下载），与你"别把电脑塞满"的要求冲突。
  改用正则提炼 `function/class/const/interface` 等符号，够用且零依赖。
- **不做向量检索**：BM25 零依赖、可解释、离线；语义检索留作后续可替换点（`rag.js` 已是单点接口）。
- **不做对话回合制**：回合制正是本项目要解决的问题，所以整个状态机围绕"输入流 + 漂移"设计，
  而不是"消息列表"。

---

## 5. 关于"建议"这件事的额外发现

现有工具里，"建议"通常有两种形态：内联补全（Copilot）或对话回复（ChatGPT 类）。
两者都不适合"用户正在打字"的场景——

- 内联补全占用光标位置，会打断输入；
- 对话回复需要用户读完再决定，破坏了"不中断"。

SynthFlow 的选择是**侧栏卡片 + 一键写入提示词**：建议不抢焦点、可以延后处理，
采纳的动作本身就是在继续写 prompt。这条交互路径在现有产品里没找到直接对应物，
是本项目自己长出来的设计。

---

## 6. 一句话总结

> 业界把"生成"做得很好，把"时机"留给了用户。
> SynthFlow 把"时机"从用户手里拿回来 —— 由意图判定决定何时生成，由漂移决策决定改哪里。
