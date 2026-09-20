// SynthFlow 运行控制器：预演（speculative）→ 提交（commit）→ 落盘 → 版本快照。
// 这是"边打字边生成"的心脏：
//   · 打字停顿 320ms 就先跑一次**预演**，用户看到的是"我还没写完，AI 已经在写了"
//   · 意图判定为完整后 900ms，直接把预演结果**采纳落盘**（省掉一次完整调用）
//   · 若预演期间提示词漂移了，按漂移决策做增量续写 / 定点补丁 / 重生成
import { createProvider } from './llm.js';
import { buildMessages } from './prompt.js';
import { createProtocolParser } from './protocol.js';
import { analyzeIntent, decidePromptChange } from './session.js';
import { scanStyle } from './style.js';
import { buildProjectMap, locate, locatorBrief } from './projectmap.js';
import { addedLineNumbers, compactDiff, newId, nowIso, sha1 } from './util.js';

/**
 * 单文件超过这个大小就不记"轮次前像"了（回退时会如实告知哪几个文件退不回来），
 * 免得一个大文件把会话文件撑爆。
 */
const JOURNAL_MAX_FILE_BYTES = 256 * 1024;

export class Runner {
  constructor({ session, workspace, rag, memory, config, emit }) {
    this.session = session;
    this.workspace = workspace;
    this.rag = rag;
    this.memory = memory;
    // 定时参数必须收敛成有限数值：一旦某个字段缺失/为 null，
    // setTimeout(fn, undefined) 会退化成"立即执行"，那就会在你敲第一个字时直接提交。
    this.config = normalizeTiming(config ?? {});
    this.emit = emit;
    this.provider = createProvider(config);
    this.run = null;
    this.draft = null; // 预演结果（未落盘）
    this.specTimer = null;
    this.commitTimer = null;
    this.settleTimer = null;
    this.pendingInput = false;
    this.committedPrompt = session.versions[session.activeIndex]?.promptAfter ?? '';
    this.recentFiles = [];
    this.lastIntent = null;
    this.lastDecision = null;
    // 想法 B：用户在代码面板里选中的片段，下一轮需求优先作用于此
    this.selection = null;
    // 想法 1（第三轮）：同步生成开关。关掉后打字只做意图判定，不会自动预演/生成。
    this.syncEnabled = session.syncEnabled !== false;
    this.busy = false;
  }

  /* ------------------------------ 输入处理 ------------------------------ */

  /**
   * 客户端每次（防抖后的）输入变化都会调用这里。
   * @param {{text:string, idleMs?:number}} payload
   */
  onInput({ text, idleMs = 0 }) {
    const s = this.session;
    const next = String(text ?? '');
    const prevPrompt = s.prompt;
    const intent = analyzeIntent(next, { idleMs, prevText: prevPrompt, threshold: this.config.intentThreshold });
    const decision = decidePromptChange(this.committedPrompt || prevPrompt, next, {
      hasCode: this.workspace.listFiles().length > 0,
      codeBytes: this.workspace.totalBytes(),
      anchorFiles: this.recentFiles,
    });
    s.prompt = next;
    // 只在"有实质变化"时写上下文栈，避免每个按键都塞一条记录
    if (prevPrompt.trim() !== next.trim() && (decision.ratio ?? 1) > 0.03) {
      s.pushSegment({
        kind: 'typed',
        text: next,
        delta: decision.span?.isAppend ? decision.span.added : `${decision.span?.removed ? `-${decision.span.removed.slice(0, 60)}` : ''}${decision.span?.added ? `+${decision.span.added.slice(0, 60)}` : ''}`,
        meta: { ratio: decision.ratio, decision: decision.mode },
      });
    }
    s.pendingIntent = intent;
    s.lastDecision = decision;
    this.lastIntent = intent;
    this.lastDecision = decision;
    this.emit('intent', { intent, decision, prompt: next, promptChars: next.length });

    clearTimeout(this.specTimer);
    clearTimeout(this.commitTimer);
    clearTimeout(this.settleTimer);

    if (!next.trim()) return;

    // 想法 1（第三轮）：同步生成被关掉时，只上报意图，不自动预演 / 不自动落盘。
    // 「立即生成」按钮仍然可用 —— 那本来就是手动触发。
    if (!this.syncEnabled) {
      if (process.env.SF_DEBUG) console.error(`[onInput] 同步生成已关闭，只做意图判定 score=${intent.score.toFixed(2)}`);
      return;
    }

    // 生成中继续输入（想法 9）：不打断，等当前运行结束后增量续写
    if (this.busy) {
      if (decision.mode === 'regenerate' && decision.ratio > 0.7) {
        this.pendingInput = true;
        this.cancel('提示词整体变化，重新生成');
      } else {
        this.pendingInput = true;
        this.emit('queued', { reason: '生成中，已排队做增量续写', mode: decision.mode });
      }
      return;
    }

    if (!this.provider.ready) {
      this.emit('run:error', { message: `模型未就绪：${this.provider.note}` });
      return;
    }

    // 预演：只要有基本轮廓就先跑，用户能看到"我还在打字它已经在写"。
    // 注意门槛不能只看分数：结尾是连接词（「…把时间戳格式化」）会被扣 0.38 分，
    // 长句也会被压到 0.32 以下 —— 而那恰恰是最该提前开工的时刻。
    // 所以再加一条：已经写了足够长、并且有明确动作词，就值得预演。
    const enoughContext = intent.signals.length >= 12 && intent.signals.hasVerb;
    const specWorthy = intent.score >= 0.32 || enoughContext;
    if (specWorthy) {
      if (process.env.SF_DEBUG) console.error(`[onInput] score=${intent.score.toFixed(2)} len=${next.length} busy=${this.busy} -> 预演@${this.config.specDelayMs}ms`);
      this.specTimer = setTimeout(() => this.#startRun('spec', decision), this.config.specDelayMs);
    } else if (process.env.SF_DEBUG) {
      console.error(`[onInput] score=${intent.score.toFixed(2)} len=${next.length} -> 不预演 reasons=${intent.reasons.join('/')}`);
    }
    // 提交：判定句子写完了
    if (intent.complete) {
      this.commitTimer = setTimeout(() => this.commit({ reason: 'intent-complete' }).catch((err) => this.emit('run:error', { message: err.message })), this.config.commitIdleMs);
    } else if (intent.score >= 0.42 && this.config.autoCommit) {
      // 兜底：用户停手不打了、句子却没以标点结尾（例如"帮我写一个登录页"），
      // 长时间停顿后也应该自动开工，而不是让他一直等或手动点按钮。
      this.settleTimer = setTimeout(async () => {
        if (this.busy) return;
        const settled = analyzeIntent(this.session.prompt, { idleMs: this.config.settleMs, threshold: this.config.intentThreshold });
        if (settled.score < 0.4) return;
        this.emit('toast', { level: 'ok', message: `检测到输入停顿（${(settled.score * 100) | 0}% 把握），已按当前提示词开工` });
        try {
          await this.commit({ reason: 'settled' });
        } catch (err) {
          this.emit('run:error', { message: err.message });
        }
      }, this.config.settleMs);
    }
  }

  /** 一轮结束后，如果期间用户又输入了内容，自动接着做增量。 */
  #maybeResume() {
    if (!this.pendingInput || this.busy) return;
    this.pendingInput = false;
    const text = this.session.prompt;
    if (!text.trim()) return;
    this.emit('queued', { reason: '接着处理你刚才补充的内容', mode: 'continue' });
    setTimeout(() => {
      const intent = analyzeIntent(text, { idleMs: this.config.commitIdleMs, threshold: this.config.intentThreshold });
      const decision = decidePromptChange(this.committedPrompt, text, {
        hasCode: this.workspace.listFiles().length > 0,
        codeBytes: this.workspace.totalBytes(),
        anchorFiles: this.recentFiles,
      });
      const run = this.#startRun('commit', { ...decision, reason: 'resume' });
      if (!run) this.emit('toast', { level: 'warn', message: `续写未能启动（意图分 ${(intent.score * 100) | 0}%）` });
    }, 40);
  }

  /* ------------------------------ 运行控制 ------------------------------ */

  #startRun(kind, decision = {}, extra = {}) {
    if (process.env.SF_DEBUG) console.error(`[startRun] kind=${kind} busy=${this.busy} draft=${Boolean(this.draft)}`);
    if (this.busy) return this.run;
    const s = this.session;
    const prompt = s.compilePrompt();
    if (!prompt) return null;

    const mode = !decision.mode || decision.mode === 'noop' ? 'regenerate' : decision.mode;
    const runId = newId(kind === 'spec' ? 'spec' : 'run');
    const abort = new AbortController();
    const run = {
      id: runId,
      kind,
      mode, // 预演也沿用真正的增量策略：用户还在打字时就已经在"补"而不是"重写"
      speculative: kind === 'spec',
      prompt,
      startedAt: Date.now(),
      abort,
      thoughts: [],
      suggestions: [],
      ops: [],
      files: [],
      tokensIn: 0,
      chars: 0,
      error: null,
      usage: null,
      ...extra,
    };
    this.run = run;
    this.busy = true;
    s.status = kind === 'spec' ? 'speculating' : 'generating';
    this.emit('run:start', { runId, kind, mode, provider: this.provider.name, label: this.provider.label, prompt });

    // 先落一个"本轮轮次"段落，方便回退时定位
    s.pushSegment({ kind: kind === 'spec' ? 'spec' : 'turn', text: prompt, delta: decision.instruction ?? decision.reason ?? '', runId, meta: { mode } });

    this.#consume(run, decision).catch((err) => {
      run.error = err?.message ?? String(err);
      this.emit('run:error', { runId, message: run.error });
      this.busy = false;
      s.status = 'error';
    });
    return run;
  }

  async #consume(run, decision) {
    const s = this.session;
    const existingFiles = {};
    for (const rel of this.workspace.listFiles()) {
      const r = this.workspace.read(rel);
      if (r) existingFiles[rel] = r.content;
    }
    const ragHits = this.rag ? this.rag.search(run.prompt, { k: 4 }).filter((h) => h.kind === 'code') : [];
    const skills = this.rag ? this.rag.matchSkills(run.prompt) : [];
    // 想法 4：扫描项目现有风格（有缓存，文件没变就直接复用）
    let style = null;
    try {
      style = scanStyle(this.workspace);
    } catch { /* 风格扫描失败不影响生成 */ }
    const styleSummary = style?.summary && style.scanned >= 3 ? style.summary : null;
    // 想法 4（第三轮）：页面/组件定位索引 —— 改已有项目时先找到该改哪个文件，
    // 并把定位到的文件内容排到上下文最前面。
    let projectMap = null;
    let located = [];
    try {
      projectMap = buildProjectMap(this.workspace);
      located = locate(projectMap, run.prompt, { k: 5 }).filter((h) => existingFiles[h.file] !== undefined);
    } catch { /* 定位失败就退化成原来的 RAG */ }
    const locator = locatorBrief(this.workspace, projectMap);
    const manualEdits = (s.manualEdits ?? []).filter((m) => existingFiles[m.path] !== undefined);
    const manualEditNote = manualEdits.length
      ? `【用户手动改过这些文件，请务必保留他的改动，不要当成脏数据覆盖回去】\n` +
        manualEdits.map((m) => `- ${m.path}（用户改过 ${m.count} 次，最近 ${String(m.at).slice(11, 19)}）`).join('\n') +
        `\n如果要改这些文件，请使用 search/replace 补丁，并且 SEARCH 必须取自下面【现有文件内容】里的最新版本。`
      : null;
    const projectNote = this.workspace.staging
      ? `【当前是"暂存模式"】你写出的改动会先进入暂存层，用户确认后才会应用到真实项目 ` +
        `${this.workspace.root}。项目里的已有文件都是真实的，请先读再改，不要假设某文件不存在；` +
        `不要重建已有的目录结构，也不要顺手"优化"与本次需求无关的文件。`
      : null;
    const selectionNote = this.selection
      ? `【用户选中的代码片段（本次需求优先只作用于这一段）】${this.selection.path} 第 ${this.selection.startLine}-${this.selection.endLine} 行：\n` +
        `\`\`\`${this.selection.lang ?? ''}\n${String(this.selection.text).slice(0, 4000)}\n\`\`\`\n` +
        `如果需求与这段代码相关，请**优先只修改这一段周边**，用 search/replace 补丁，不要顺带重构整个文件。`
      : null;
    const messages = buildMessages({
      prompt: run.prompt,
      mode: run.mode,
      speculative: run.speculative,
      instruction: decision?.instruction ?? '',
      repoMap: this.workspace.repoMap(),
      ragHits,
      skills,
      memoryBriefing: this.memory?.briefing() ?? '',
      existingFiles,
      // 定位到的页面/组件文件排最前，其次才是补丁重试指定的文件、最近碰过的文件
      recentFiles: [
        ...located.map((l) => l.file),
        ...(run.forceFiles ?? []),
        ...this.recentFiles,
      ].filter((v, i, arr) => arr.indexOf(v) === i),
      adopted: s.segments.filter((x) => x.kind === 'adopt' && !x.reverted).map((x) => ({ text: x.text })),
      previousPrompt: this.committedPrompt,
      config: this.config,
      requireSuggestions: true,
      styleSummary,
      locatorBrief: locator,
      projectNote,
      manualEditNote,
      selectionNote,
    });
    run.context = {
      ragHits: ragHits.length,
      skills: skills.map((k) => k.name),
      files: Object.keys(existingFiles).length,
      chars: messages.reduce((a, m) => a + m.content.length, 0),
      styleScanned: style?.scanned ?? 0,
      styled: Boolean(styleSummary),
      located: located.map((l) => ({ file: l.file, route: l.route, name: l.name, kind: l.kind })),
    };
    this.emit('run:context', { runId: run.id, ...run.context });

    const currentFile = { path: null };
    const parser = createProtocolParser({
      onThinkStart: () => this.emit('think:start', { runId: run.id }),
      onThinkDelta: (d) => {
        run.chars += d.length;
        this.emit('think:delta', { runId: run.id, delta: d });
      },
      onThinkEnd: (text) => {
        if (text) run.thoughts.push(text);
        this.emit('think:end', { runId: run.id, text });
      },
      onSuggestionStart: (meta) => this.emit('suggest:start', { runId: run.id, meta }),
      onSuggestionEnd: (sug) => {
        run.suggestions.push(sug);
        s.stats.charsGenerated += (sug.body ?? '').length;
        // 想法 6（v2）：正式生成阶段的建议本轮结束后统一弹出；预演阶段用户还在打字，实时给。
        if (run.kind !== 'commit') {
          if (this.#filterSuggestions([sug]).length) this.emit('suggest', { runId: run.id, suggestion: sug, draft: true });
        }
        // 想法 10：高价值优化建议 + 用户开启自动采纳时，同步改写 prompt
        if (this.config.autoAdoptHigh && sug.kind === 'optimize' && sug.impact === 'high' && sug.insert) {
          const r = s.adoptSuggestion(sug, { auto: true });
          if (r.ok) this.emit('prompt', { text: r.prompt, reason: 'auto-adopt', suggestion: sug });
        }
      },
      onFileStart: (meta) => {
        currentFile.path = meta.path;
        this.emit('file:start', { runId: run.id, path: meta.path, action: meta.action ?? 'create', lang: meta.lang ?? '' });
      },
      onFileDelta: (d) => {
        run.chars += d.length;
        this.emit('file:delta', { runId: run.id, path: currentFile.path, delta: d });
      },
      onFileEnd: (op) => {
        run.ops.push(op);
        run.files.push(op.path);
        this.emit('file:end', { runId: run.id, op: publicOp(op) });
      },
      onText: (d) => {
        run.chars += d.length;
        this.emit('run:text', { runId: run.id, delta: d });
      },
      onError: (err) => this.emit('run:error', { runId: run.id, message: `协议解析异常: ${err.message}` }),
    });

    try {
      for await (const evt of this.provider.stream({ messages, signal: run.abort.signal, userPrompt: run.prompt, mode: run.mode, existingFiles })) {
        if (run.abort.signal.aborted) break;
        if (evt?.type === 'delta' && evt.text) parser.push(evt.text);
        else if (evt?.type === 'usage' && evt.usage) run.usage = evt.usage; // 真实 token 用量
      }
      parser.end();
    } catch (err) {
      if (!run.abort.signal.aborted) throw err;
    }

    const ms = Date.now() - run.startedAt;
    this.busy = false;
    this.run = null;

    if (run.abort.signal.aborted) {
      s.status = 'idle';
      this.emit('run:cancelled', { runId: run.id, ms });
      this.#maybeResume();
      return;
    }

    if (run.kind === 'spec') {
      this.draft = {
        runId: run.id,
        prompt: run.prompt,
        promptHash: sha1(run.prompt),
        mode: run.mode,
        ops: run.ops,
        suggestions: run.suggestions,
        thoughts: run.thoughts,
        createdAt: nowIso(),
        ms,
      };
      s.status = 'idle';
      this.emit('spec:done', { runId: run.id, ms, files: run.files, suggestions: run.suggestions.length, ops: run.ops.map(publicOp) });
      // 预演完成后如果意图其实已经完整，直接升级为提交
      const intent = analyzeIntent(s.prompt, { idleMs: this.config.commitIdleMs, threshold: this.config.intentThreshold });
      if (intent.complete && this.config.autoCommit) {
        try {
          await this.commit({ reason: 'spec-then-commit' });
        } catch (err) {
          this.emit('run:error', { runId: run.id, message: `自动提交失败: ${err.message}` });
        }
      } else {
        this.#maybeResume();
      }
      return;
    }

    await this.#applyRun(run, ms);
  }

  async #applyRun(run, ms) {
    const s = this.session;
    s.status = 'applying';
    const promptBefore = this.committedPrompt;
    const manualMode = this.config.saveMode !== 'auto';

    // v3.3：写盘**之前**记下这一轮要碰的每个文件的"前像"，用于一轮一轮往回退。
    // 只记这一轮真正改到的文件（通常 1-3 个），比每轮打一个全量快照省得多。
    const before = {};
    const skipped = [];
    const seen = new Set();
    for (const op of run.ops ?? []) {
      const rel = String(op.path || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      const cur = this.workspace.read(rel);
      if (cur?.tooLarge || (cur?.content?.length ?? 0) > JOURNAL_MAX_FILE_BYTES) {
        skipped.push(rel); // 太大的文件不记前像，回退时如实告知
        continue;
      }
      before[rel] = { existed: Boolean(cur), content: cur ? cur.content : null };
    }

    // 想法 11：还需要一个"第一轮未保存改动之前"的全量快照，供"一次性撤销全部未保存改动"。
    // 以前这里**每一轮**都打一个全量快照，而且 setPendingRound 每轮把 preSnapshotId 覆盖掉 ——
    // 结果是白占磁盘，撤销时也只退得掉最后一轮。现在只在第一轮取一次。
    let preSnapshot = null;
    if (!manualMode || !s.pendingRound?.preSnapshotId) {
      try {
        preSnapshot = this.workspace.snapshot({ label: `pre-round ${run.id}`, runId: run.id, meta: { kind: 'pre-round' } });
      } catch { /* 快照失败不影响写入 */ }
    }
    const results = [];
    for (const op of run.ops) {
      let res;
      try {
        res = this.workspace.applyOp(op);
      } catch (err) {
        res = { path: op.path, ok: false, mode: op.mode, error: err.message };
      }
      results.push({ ...res, diff: res.diff ? res.diff.slice(0, 400) : undefined });
      if (res.ok) this.recentFiles = [res.path, ...this.recentFiles.filter((p) => p !== res.path)].slice(0, 8);
    }
    const okFiles = results.filter((r) => r.ok).map((r) => r.path);
    const failed = results.filter((r) => !r.ok);
    const summary = `${run.retryOf ? '补丁重试 · ' : ''}${run.mode === 'regenerate' ? '生成' : run.mode === 'continue' ? '增量续写' : '增量修改'} ${okFiles.length} 个文件${failed.length ? `（${failed.length} 个失败）` : ''}`;
    let version = null;
    if (manualMode) {
      // v3.3：把这一轮的前像记进日志（时间线上一轮一个"可回退"的点）
      if (okFiles.length) {
        s.pushRoundJournal({ id: run.id, prompt: run.prompt, mode: run.mode, files: before, skipped });
      }
      // 想法 11：只有点「保存为版本」才产生版本，这里只记一笔"未保存的改动"
      s.setPendingRound({
        // 关键：保留**第一轮**的快照 id，不能被后面几轮覆盖 ——
        // 否则"撤销未保存的改动"实际上只退得掉最后一轮。
        preSnapshotId: s.pendingRound?.preSnapshotId ?? preSnapshot?.id ?? null,
        runId: run.id,
        files: [...new Set([...(s.pendingRound?.files ?? []), ...okFiles])],
        promptBefore,
        promptAfter: run.prompt,
        round: (s.pendingRound?.round ?? 0) + 1,
        at: nowIso(),
      });
    } else {
      const snap = this.workspace.snapshot({ label: run.prompt.slice(0, 60), runId: run.id, meta: { mode: run.mode, files: okFiles } });
      version = s.recordCommit({
        runId: run.id,
        promptBefore,
        promptAfter: run.prompt,
        files: okFiles,
        summary,
        snapshotId: snap.id,
        confirmed: true,
      });
    }
    this.committedPrompt = run.prompt;
    s.status = 'idle';
    // 用过的选区就消费掉，避免一直粘在后续轮次上
    this.selection = null;

    // token 用量：优先用接口返回的真实 usage，没有就按字符数估算
    const usage = run.usage
      ? { tokens: run.usage.total_tokens ?? (run.usage.prompt_tokens ?? 0) + (run.usage.completion_tokens ?? 0), real: true }
      : { tokens: Math.max(0, Math.round(run.chars / 3)), real: false };
    s.stats.modelCalls = (s.stats.modelCalls ?? 0) + 1;
    s.stats.estTokens = (s.stats.estTokens ?? 0) + usage.tokens;

    this.memory?.observeRun({
      prompt: run.prompt,
      files: okFiles,
      contents: results.filter((r) => r.ok && r.after).map((r) => r.after),
      adopted: s.notes.filter((n) => n.type === 'adopt').map((n) => n.suggestion),
      mode: run.mode,
      ms,
      tokens: usage.tokens,
    });
    this.rag?.build({ force: true });
    s.save();

    this.emit('run:applied', { runId: run.id, results: results.map(stripDiff), versionId: version?.id ?? null, files: okFiles, unsaved: manualMode });
    this.emit('tree', { tree: this.safeTree() });
    this.emit('versions', s.versionList());
    // 想法 3：把这一轮（思考/建议/文件操作）写进会话，刷新页面后还能看到
    s.recordRound({
      id: run.id,
      kind: run.kind,
      mode: run.mode,
      at: nowIso(),
      ms,
      files: okFiles,
      versionId: version?.id ?? null,
      thoughts: run.thoughts,
      suggestions: this.#filterSuggestions(run.suggestions),
      ops: run.ops.map((o) => ({ path: o.path, action: o.action, mode: o.mode })),
    });
    // 想法 6（v2）：本轮结束后才把建议推给用户，避免生成过程中分散注意力。
    // 预演被直接采纳的情况例外：预演阶段已经实时给过建议了，不能再推一遍。
    if (!run.promotedFromDraft) this.#flushSuggestions(run);
    this.emit('run:done', {
      runId: run.id,
      kind: 'commit',
      ms,
      mode: run.mode,
      files: okFiles,
      failed: failed.map((f) => ({ path: f.path, error: f.error })),
      versionId: version?.id ?? null,
      chars: run.chars,
      usage,
      droppedBranches: version?.droppedBranches ?? 0,
      pendingSave: manualMode && okFiles.length > 0,
      unsavedCount: manualMode ? (s.pendingRound?.round ?? 0) : 0,
      staging: this.workspace.staging,
    });
    this.emit('state', this.snapshot());

    if (failed.length) {
      this.emit('toast', { level: 'warn', message: `${failed.length} 个补丁未命中：${failed.map((f) => f.path).join(', ')}（已保留其余改动）` });
    }
    // 注意 version 可能是 null：手动保存模式（saveMode: 'manual'）下这一轮不产生版本，
    // 上面几处都已经写成 version?.id，这里以前漏了问号 ——
    // 结果是"每生成成功一次就抛一次 TypeError"，状态栏变红「出错了」，
    // 用户以为生成失败，其实文件早就写对了。
    if (version && version.droppedBranches) {
      this.emit('toast', { level: 'warn', message: `你刚才在历史版本上继续生成，已丢弃后面的 ${version.droppedBranches} 个版本分支` });
    }

    // 补丁未命中 → 自动重试一次（把真实文件内容重新喂回去让它重出补丁）
    if (this.#maybeRetryPatch(run, failed)) return;
    this.#maybeResume();
  }

  /** 本轮结束后统一推建议（先按用户开关过滤，再按影响度排序）。 */
  #flushSuggestions(run) {
    const list = this.#filterSuggestions(run.suggestions);
    if (!list.length) return;
    const order = { high: 0, medium: 1, low: 2 };
    const sorted = [...list].sort((a, b) => (order[a.impact] ?? 1) - (order[b.impact] ?? 1));
    for (const sug of sorted) {
      this.emit('suggest', { runId: run.id, suggestion: sug, batch: true });
    }
  }

  /** 想法 5：按用户开关过滤建议类型与条数（模型侧也会被提示，这里是双保险）。 */
  #filterSuggestions(list) {
    const cfg = this.config.suggest ?? {};
    const max = Math.max(0, Math.min(9, Number(cfg.max ?? 4)));
    if (max === 0) return [];
    return (list ?? []).filter((s) => cfg[s.kind] !== false).slice(0, max);
  }

  /** 补丁没命中时自动重试一次（默认开启，可在设置里关闭）。 */
  #maybeRetryPatch(run, failed) {
    if (!this.config.patchRetry || run.retryOf || !failed.length) return false;
    const retryFiles = failed.filter((f) => f.mode === 'patch' || f.mode === 'rewrite').map((f) => f.path);
    if (!retryFiles.length) return false;
    this.emit('retry', { runId: run.id, files: retryFiles });
    const instruction =
      `你上一次输出的补丁**没有命中真实文件内容**（涉及：${retryFiles.join(', ')}）。\n` +
      `下面会给出这些文件的**真实当前内容**，请重新生成 search/replace 补丁。\n` +
      `硬性要求：\n` +
      `1. SEARCH 片段必须与文件内容**逐字一致**（包含缩进、空行、结尾分号）。\n` +
      `2. 只做最小必要改动，不要重写整个文件。\n` +
      `3. 只输出这些文件的补丁，不要动别的文件。`;
    const r = this.#startRun(
      'commit',
      { mode: 'incremental', reason: '补丁未命中自动重试', instruction, ratio: 0 },
      { retryOf: run.id, forceFiles: retryFiles },
    );
    if (!r) this.emit('toast', { level: 'warn', message: '补丁重试未能启动' });
    return Boolean(r);
  }

  /** 打开/关闭"同步思考 + 同步生成"（想法 1）。关闭时同时停掉在跑的那一轮。 */
  setSync(enabled, { silent = false } = {}) {
    this.syncEnabled = Boolean(enabled);
    clearTimeout(this.specTimer);
    clearTimeout(this.commitTimer);
    clearTimeout(this.settleTimer);
    if (!this.syncEnabled) {
      this.pendingInput = false;
      if (this.busy) this.cancel('sync-off');
      this.session.status = 'idle';
    }
    if (!silent) {
      this.emit('sync', { syncEnabled: this.syncEnabled });
      this.emit('toast', {
        level: this.syncEnabled ? 'ok' : 'warn',
        message: this.syncEnabled
          ? '已开启同步生成：打字停顿就会预演，判定写完自动落盘'
          : '已关闭同步生成：打字不会触发思考与生成，需要时点「立即生成」',
      });
    }
    return { ok: true, syncEnabled: this.syncEnabled };
  }

  /** 把本轮改动保存成一个版本（想法 11：只有显式保存才产生版本）。 */
  saveVersion({ label = '' } = {}) {
    const s = this.session;
    const pending = s.pendingRound;
    const files = pending?.files?.length ? pending.files : this.recentFiles.slice(0, 20);
    const snap = this.workspace.snapshot({ label: label || `手动保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`, meta: { kind: 'manual-save' } });
    const version = s.recordCommit({
      runId: pending?.runId ?? null,
      promptBefore: pending?.promptBefore ?? this.committedPrompt,
      promptAfter: pending?.promptAfter ?? s.prompt,
      files,
      summary: label || (pending ? `保存第 ${pending.round ?? ''} 轮改动`.trim() : '手动保存'),
      snapshotId: snap.id,
      kind: 'manual',
      confirmed: true,
    });
    s.clearPendingRound();
    // 这些轮次已经进了版本，轮次前像日志就功成身退了（回退改走版本链）
    s.clearRoundJournal();
    s.save();
    this.emit('versions', s.versionList());
    this.emit('state', this.snapshot());
    this.emit('toast', { level: 'ok', message: `已保存为版本 ${version.id}（可随时回退）` });
    return { ok: true, versionId: version.id, versions: s.versionList() };
  }

  /** 撤销"还没保存的那些轮次"的改动（回到最近一次保存的状态）。 */
  undoRound() {
    const s = this.session;
    const pending = s.pendingRound;
    if (!pending?.preSnapshotId) return { ok: false, error: '没有可撤销的未保存改动' };
    let restore;
    try {
      restore = this.workspace.restore(pending.preSnapshotId);
    } catch (err) {
      return { ok: false, error: `撤销失败：${err.message}` };
    }
    s.clearPendingRound();
    s.clearRoundJournal();
    s.prompt = pending.promptBefore ?? s.prompt;
    this.committedPrompt = s.currentVersion?.promptAfter ?? '';
    this.rag?.build({ force: true });
    s.save();
    this.emit('tree', { tree: this.safeTree() });
    this.emit('versions', s.versionList());
    this.emit('prompt', { text: s.prompt, reason: 'undo-round' });
    this.emit('state', this.snapshot());
    this.emit('toast', { level: 'warn', message: `已撤销未保存的改动（恢复 ${restore.restored} 个文件）` });
    return { ok: true, ...restore };
  }

  /**
   * 往回退 N 轮（v3.3）。粒度是"轮"，不是"已保存的版本" ——
   * 之前 ⏪ 只能退回上一个已保存版本，中间那些没保存的轮次既看不见也退不动。
   * 用的是每轮记下的文件前像，所以只动这一轮真正改过的文件。
   */
  undoRoundStep({ count = 1 } = {}) {
    const s = this.session;
    const n = Math.max(1, Math.min(30, Number(count) || 1));
    if (s.activeIndex !== s.versions.length - 1) {
      return { ok: false, error: '你正处于历史版本上，请先点 ⏩ 回到最新版本再按轮回退' };
    }
    const undone = [];
    const touched = new Set();
    let failedFiles = 0;
    for (let i = 0; i < n; i += 1) {
      const entry = s.popRoundJournal();
      if (!entry) break;
      for (const [rel, pre] of Object.entries(entry.files ?? {})) {
        try {
          if (pre.existed) this.workspace.write(rel, pre.content ?? '');
          else this.workspace.remove(rel);
          touched.add(rel);
        } catch {
          failedFiles += 1;
        }
      }
      undone.push(entry);
    }
    if (!undone.length) return { ok: false, error: '没有可以回退的轮次了' };

    // 思考栏里那些已经撤回的轮次也要去掉，不然它还留在那儿让人以为改动还在
    const ids = new Set(undone.map((e) => e.id));
    s.timeline = s.timeline.filter((t) => !ids.has(t.id));
    if (!s.roundJournal.length) {
      s.clearPendingRound();
    } else if (s.pendingRound) {
      const remain = [...new Set(s.roundJournal.flatMap((e) => Object.keys(e.files ?? {})))];
      s.setPendingRound({ files: remain, round: s.roundJournal.length });
    }
    this.recentFiles = this.recentFiles.filter((p) => touched.has(p));
    this.rag?.build({ force: true });
    s.save();
    this.emit('tree', { tree: this.safeTree() });
    this.emit('versions', s.versionList());
    this.emit('state', this.snapshot());
    this.emit('timeline', { timeline: s.timeline });
    this.emit('toast', {
      level: 'ok',
      message: `已回退 ${undone.length} 轮（还原 ${touched.size} 个文件）${failedFiles ? `，${failedFiles} 个文件还原失败` : ''}`,
    });
    return { ok: true, undone: undone.length, files: [...touched], failedFiles, remaining: s.roundJournal.length };
  }

  /** 提交：优先就地"采纳"预演结果，避免重复调用模型（省钱 + 更快）。 */
  async commit({ reason = 'manual', force = false } = {}) {
    clearTimeout(this.specTimer);
    clearTimeout(this.commitTimer);
    if (this.busy) return { ok: false, error: '正在生成中' };
    const s = this.session;
    const prompt = s.compilePrompt();
    if (!prompt.trim()) return { ok: false, error: '提示词为空' };
    // 只要真正提交，就把这次提示词计入习惯记忆（预演被采纳的路径也要记）
    this.memory?.observePrompt(prompt);

    if (this.draft && !force) {
      const drift = decidePromptChange(this.draft.prompt, prompt, { hasCode: true, codeBytes: this.workspace.totalBytes() });
      if (drift.mode === 'noop' || drift.ratio <= 0.06) {
        const run = {
          id: this.draft.runId,
          kind: 'commit',
          mode: this.draft.mode,
          prompt: this.draft.prompt,
          ops: this.draft.ops,
          suggestions: this.draft.suggestions,
          thoughts: this.draft.thoughts,
          files: this.draft.ops.map((o) => o.path),
          chars: 0,
          startedAt: Date.now(),
          promotedFromDraft: true,
        };
        this.emit('run:promoted', { runId: run.id, reason: '预演结果直接采纳，无需二次调用', ms: this.draft.ms });
        this.draft = null;
        await this.#applyRun(run, 0);
        return { ok: true, promoted: true, runId: run.id };
      }
      this.emit('run:promoted', { runId: this.draft.runId, reason: `提示词已漂移(${drift.mode})，放弃预演结果改走增量生成`, ms: this.draft.ms });
      this.draft = null;
    }

    const decision = decidePromptChange(this.committedPrompt || prompt, prompt, {
      hasCode: this.workspace.listFiles().length > 0,
      codeBytes: this.workspace.totalBytes(),
      anchorFiles: this.recentFiles,
    });
    const run = this.#startRun('commit', { ...decision, reason });
    if (!run) return { ok: false, error: '无法启动生成' };
    return { ok: true, runId: run.id, mode: decision.mode, reason };
  }

  cancel(reason = 'user') {
    clearTimeout(this.specTimer);
    clearTimeout(this.commitTimer);
    clearTimeout(this.settleTimer);
    if (this.run) {
      this.run.abort.abort();
      this.emit('run:cancel-request', { runId: this.run.id, reason });
      return true;
    }
    this.emit('run:cancelled', { reason });
    return false;
  }

  /**
   * 在版本链上移动游标。回退之后仍可用 forward 回到刚才的版本（想法 9）。
   */
  moveVersion(direction = 'back', versionId) {
    const s = this.session;
    const res = s.moveVersion(direction, versionId);
    if (!res.ok) return res;
    this.draft = null;
    clearTimeout(this.specTimer);
    clearTimeout(this.commitTimer);
    clearTimeout(this.settleTimer);
    this.committedPrompt = s.currentVersion?.promptAfter ?? '';
    // 在版本链上移动游标 = 整体覆盖了工作区状态，未保存轮次的前像不再对应任何东西
    s.clearPendingRound();
    s.clearRoundJournal();
    this.rag?.build({ force: true });
    if (direction !== 'forward') this.memory?.observeRollback();
    s.save();
    this.emit('tree', { tree: this.safeTree() });
    this.emit('versions', s.versionList());
    this.emit('prompt', { text: s.prompt, reason: direction === 'forward' ? 'redo' : 'rollback' });
    this.emit('rollback', res);
    this.emit('state', this.snapshot());
    return res;
  }

  /** 兼容旧接口。 */
  rollback(versionId) {
    return this.moveVersion('back', versionId);
  }

  adopt(suggestion) {
    const s = this.session;
    const res = s.adoptSuggestion(suggestion);
    if (!res.ok) return res;
    s.save();
    this.emit('prompt', { text: res.prompt, reason: 'adopt', suggestion });
    this.emit('suggest:adopted', { suggestion, segment: res.segment });
    this.emit('state', this.snapshot());
    // 采纳后若已停止输入，自动跑一次增量生成
    if (!this.busy) {
      clearTimeout(this.commitTimer);
      this.commitTimer = setTimeout(() => {
        this.commit({ reason: 'adopt-followup' }).catch((err) => this.emit('run:error', { message: `采纳后自动生成失败: ${err.message}` }));
      }, 260);
    }
    return res;
  }

  dismiss(suggestion) {
    this.session.dismissSuggestion(suggestion);
    this.session.save();
    this.emit('state', this.snapshot());
    return { ok: true };
  }

  /** 生成文件树时做一次兜底，任何异常都不应该打断生成流程。 */
  safeTree() {
    try {
      return this.workspace.listTree();
    } catch (err) {
      this.emit('toast', { level: 'err', message: `文件树渲染失败（不影响代码写入）：${err.message}` });
      return { name: 'workspace', path: '', type: 'dir', children: [] };
    }
  }

  /** 直接写入文件（用户在编辑器里手改后保存）。 */
  writeFile(rel, content, { manual = true } = {}) {
    const res = this.workspace.write(rel, content);
    const snap = this.workspace.snapshot({ label: `手动保存 ${rel}`, meta: { kind: 'manual', path: rel } });
    const s = this.session;
    const version = s.recordCommit({
      runId: null,
      promptBefore: this.committedPrompt,
      promptAfter: s.prompt,
      files: [rel],
      summary: `手动保存 ${rel}`,
      snapshotId: snap.id,
      kind: 'manual',
      confirmed: true, // 手动保存本身就是用户的确认动作
    });
    // 想法 1/A：记住这是人改的，下一轮提示词里要告诉模型别覆盖
    if (manual) s.noteManualEdit({ path: rel, chars: content.length, summary: '用户在编辑器里手动修改' });
    s.save();
    this.emit('tree', { tree: this.safeTree() });
    this.emit('versions', s.versionList());
    this.emit('file:saved', { path: rel, bytes: res.bytes, manual });
    this.emit('state', this.snapshot());
    return { ok: true, ...res, versionId: version.id };
  }

  /** 设置/清除"选中代码"（想法 B）。 */
  setSelection(sel) {
    if (!sel || !sel.path) {
      this.selection = null;
      return { ok: true, selection: null };
    }
    this.selection = {
      path: sel.path,
      startLine: Number(sel.startLine) || 1,
      endLine: Number(sel.endLine) || 1,
      text: String(sel.text ?? '').slice(0, 4000),
      lang: sel.lang ?? '',
    };
    return { ok: true, selection: this.selection };
  }

  confirmVersion(versionId) {
    const res = this.session.confirmVersion(versionId);
    if (!res.ok) return res;
    this.session.save();
    this.emit('versions', this.session.versionList());
    this.emit('state', this.snapshot());
    return res;
  }

  discardVersion(versionId) {
    const res = this.session.discardVersion(versionId);
    if (!res.ok) return res;
    this.committedPrompt = this.session.currentVersion?.promptAfter ?? '';
    this.rag?.build({ force: true });
    this.session.save();
    this.emit('tree', { tree: this.safeTree() });
    this.emit('versions', this.session.versionList());
    this.emit('prompt', { text: this.session.prompt, reason: 'discard' });
    this.emit('rollback', { ...res, direction: 'back', prompt: this.session.prompt, activeVersionId: this.session.activeVersionId });
    this.emit('state', this.snapshot());
    return res;
  }

  /** 把暂存层的改动真正应用到目标项目（想法 D）。 */
  applyPending() {
    if (!this.workspace.staging) return { ok: false, error: '当前是直接写入模式，没有待应用的改动' };
    const res = this.workspace.applyPending();
    this.rag?.build({ force: true });
    this.emit('tree', { tree: this.safeTree() });
    this.emit('pending', { items: this.workspace.pending(), staging: this.workspace.staging });
    this.emit('state', this.snapshot());
    this.emit('toast', {
      level: 'ok',
      message: `已应用到项目：修改 ${res.applied.length} 个文件${res.deleted.length ? `，删除 ${res.deleted.length} 个` : ''}`,
    });
    return { ok: true, ...res };
  }

  /** 丢弃全部暂存改动（真实项目分毫未动）。 */
  discardPending() {
    if (!this.workspace.staging) return { ok: false, error: '当前是直接写入模式' };
    const res = this.workspace.discardPending();
    this.rag?.build({ force: true });
    this.emit('tree', { tree: this.safeTree() });
    this.emit('pending', { items: [], staging: true });
    this.emit('state', this.snapshot());
    this.emit('toast', { level: 'warn', message: `已丢弃 ${res.discarded} 处暂存改动，目标项目未受影响` });
    return { ok: true, ...res };
  }

  snapshot() {
    const s = this.session;
    return {
      session: s.snapshotState(),
      // 每个 state 事件都要带上"当前项目"，否则前端在状态刷新时会把项目名擦成空白
      paths: {
        projectDir: this.workspace.root,
        staging: this.workspace.staging,
        writeMode: this.workspace.staging ? 'staging' : 'direct',
        files: this.workspace.listFiles().length,
      },
      provider: { name: this.provider.name, label: this.provider.label, ready: this.provider.ready, note: this.provider.note, model: this.config.model },
      profile: { id: this.config.activeProfileId, name: (this.config.profiles ?? []).find((p) => p.id === this.config.activeProfileId)?.name ?? '' },
      busy: this.busy,
      run: this.run ? { id: this.run.id, kind: this.run.kind, mode: this.run.mode } : null,
      draft: this.draft ? { runId: this.draft.runId, files: this.draft.ops.map((o) => o.path), mode: this.draft.mode, ms: this.draft.ms } : null,
      versions: s.versionList(),
      pendingConfirm: s.pendingConfirm,
      unsaved: s.pendingRound
        ? {
          round: s.pendingRound.round,
          files: s.pendingRound.files ?? [],
          at: s.pendingRound.at,
          canUndo: Boolean(s.pendingRound.preSnapshotId),
          // v3.3：时间线要显示"还没保存的每一轮"，⏪ 也要能一轮一轮往回退
          rounds: s.roundJournalBrief(),
        }
        : { round: 0, files: [], at: null, canUndo: false, rounds: [] },
      syncEnabled: this.syncEnabled,
      intent: this.lastIntent,
      decision: this.lastDecision ? { mode: this.lastDecision.mode, ratio: this.lastDecision.ratio, reason: this.lastDecision.reason } : null,
      workspace: {
        files: this.workspace.listFiles().length,
        bytes: this.workspace.totalBytes(),
        recent: this.recentFiles,
        root: this.workspace.root,
        staging: this.workspace.staging,
        pendingCount: this.workspace.staging ? this.workspace.pendingRels().size : 0,
      },
      selection: this.selection,
      manualEdits: (s.manualEdits ?? []).map((m) => ({ path: m.path, count: m.count, at: m.at })),
      rag: this.rag ? this.rag.stats() : null,
      memory: this.memory ? this.memory.summary() : null,
      config: {
        specDelayMs: this.config.specDelayMs,
        commitIdleMs: this.config.commitIdleMs,
        settleMs: this.config.settleMs,
        intentThreshold: this.config.intentThreshold,
        autoCommit: this.config.autoCommit,
        autoAdoptHigh: this.config.autoAdoptHigh,
        patchRetry: this.config.patchRetry,
        saveMode: this.config.saveMode,
        suggest: this.config.suggest,
        compactStyle: this.config.compactStyle,
        streamLimitKB: this.config.streamLimitKB,
        writeMode: this.config.writeMode,
        projectDir: this.config.projectDir,
      },
    };
  }
}

function publicOp(op) {
  return {
    path: op.path,
    action: op.action,
    mode: op.mode,
    lang: op.lang,
    patches: op.patches?.length ?? 0,
    chars: (op.content?.length ?? 0) || (op.patches ?? []).reduce((a, p) => a + p.replace.length, 0),
    content: op.content?.length <= 4000 ? op.content : undefined,
    patchList: op.mode === 'patch' ? op.patches.map((p) => ({ search: p.search.slice(0, 400), replace: p.replace.slice(0, 1200) })) : undefined,
  };
}

/**
 * 把配置里的定时/阈值参数收敛成安全的有限数值。
 * 这一步不能省：任何缺失或非法值都可能让 setTimeout 变成"立即执行"，
 * 表现就是"刚敲一个字就直接生成并落盘"。
 */
export function normalizeTiming(config = {}) {
  const num = (v, def, min = 0) => {
    // null / undefined / '' 都必须回落：Number(null) === 0，会让 setTimeout 变成立即执行。
    if (v === null || v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : def;
  };
  return {
    ...config,
    specDelayMs: num(config.specDelayMs, 1000),
    commitIdleMs: num(config.commitIdleMs, 900),
    settleMs: num(config.settleMs, 1600),
    intentThreshold: (() => {
      const n = Number(config.intentThreshold);
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.6;
    })(),
    autoCommit: config.autoCommit !== false,
    autoAdoptHigh: config.autoAdoptHigh === true,
    patchRetry: config.patchRetry !== false,
    // 想法 11：默认只有显式保存才产生版本
    saveMode: config.saveMode === 'auto' ? 'auto' : 'manual',
  };
}

function stripDiff(res) {
  const out = {
    path: res.path,
    ok: res.ok,
    mode: res.mode,
    error: res.error,
    warning: res.warning,
    changedLines: res.changedLines,
    appliedCount: res.appliedCount,
    totalPatches: res.totalPatches,
  };
  if (res.ok && res.diff?.length) {
    out.compact = compactDiff(res.diff);
    // 只有增量补丁才标"本轮新增行"；整文件新建/重写时整篇都是新的，标了反而没意义
    if (res.mode === 'patch') out.addedLines = addedLineNumbers(res.diff).slice(0, 400);
  }
  return out;
}
