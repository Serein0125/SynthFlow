// SynthFlow 运行控制器：预演（speculative）→ 提交（commit）→ 落盘 → 版本快照。
// 这是"边打字边生成"的心脏：
//   · 打字停顿 320ms 就先跑一次**预演**，用户看到的是"我还没写完，AI 已经在写了"
//   · 意图判定为完整后 900ms，直接把预演结果**采纳落盘**（省掉一次完整调用）
//   · 若预演期间提示词漂移了，按漂移决策做增量续写 / 定点补丁 / 重生成
import { createProvider } from './llm.js';
import { buildMessages } from './prompt.js';
import { createProtocolParser } from './protocol.js';
import { analyzeIntent, decidePromptChange } from './session.js';
import { addedLineNumbers, compactDiff, newId, nowIso, sha1 } from './util.js';

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
    this.committedPrompt = session.versions[session.versions.length - 1]?.promptAfter ?? '';
    this.recentFiles = [];
    this.lastIntent = null;
    this.lastDecision = null;
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

    // 预演：只要有基本轮廓就先跑，用户能看到"我还在打字它已经在写"
    if (intent.score >= 0.32) {
      this.specTimer = setTimeout(() => this.#startRun('spec', decision), this.config.specDelayMs);
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
      // 补丁重试时，把上次未命中的文件提到上下文最前面
      recentFiles: run.forceFiles?.length ? [...run.forceFiles, ...this.recentFiles] : this.recentFiles,
      adopted: s.segments.filter((x) => x.kind === 'adopt' && !x.reverted).map((x) => ({ text: x.text })),
      previousPrompt: this.committedPrompt,
      config: this.config,
      requireSuggestions: true,
    });
    run.context = { ragHits: ragHits.length, skills: skills.map((k) => k.name), files: Object.keys(existingFiles).length, chars: messages.reduce((a, m) => a + m.content.length, 0) };
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
          this.emit('suggest', { runId: run.id, suggestion: sug, draft: true });
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
    const snap = this.workspace.snapshot({
      label: run.prompt.slice(0, 60),
      runId: run.id,
      meta: { mode: run.mode, files: okFiles },
    });
    const version = s.recordCommit({
      runId: run.id,
      promptBefore,
      promptAfter: run.prompt,
      files: okFiles,
      summary: `${run.retryOf ? '补丁重试 · ' : ''}${run.mode === 'regenerate' ? '生成' : run.mode === 'continue' ? '增量续写' : '增量修改'} ${okFiles.length} 个文件${failed.length ? `（${failed.length} 个失败）` : ''}`,
      snapshotId: snap.id,
    });
    this.committedPrompt = run.prompt;
    s.status = 'idle';

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

    this.emit('run:applied', { runId: run.id, results: results.map(stripDiff), versionId: version.id, files: okFiles });
    this.emit('tree', { tree: this.safeTree() });
    this.emit('versions', s.versionList());
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
      versionId: version.id,
      chars: run.chars,
      usage,
      droppedBranches: version.droppedBranches ?? 0,
    });
    this.emit('state', this.snapshot());

    if (failed.length) {
      this.emit('toast', { level: 'warn', message: `${failed.length} 个补丁未命中：${failed.map((f) => f.path).join(', ')}（已保留其余改动）` });
    }
    if (version.droppedBranches) {
      this.emit('toast', { level: 'warn', message: `你刚才在历史版本上继续生成，已丢弃后面的 ${version.droppedBranches} 个版本分支` });
    }

    // 补丁未命中 → 自动重试一次（把真实文件内容重新喂回去让它重出补丁）
    if (this.#maybeRetryPatch(run, failed)) return;
    this.#maybeResume();
  }

  /** 本轮结束后统一推建议（按影响度排序，高的在前）。 */
  #flushSuggestions(run) {
    if (!run.suggestions.length) return;
    const order = { high: 0, medium: 1, low: 2 };
    const sorted = [...run.suggestions].sort((a, b) => (order[a.impact] ?? 1) - (order[b.impact] ?? 1));
    for (const sug of sorted) {
      this.emit('suggest', { runId: run.id, suggestion: sug, batch: true });
    }
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

  /** 直接写入文件（用户在预览里手改后保存）。 */
  writeFile(rel, content) {
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
    });
    s.save();
    this.emit('tree', { tree: this.safeTree() });
    this.emit('versions', s.versionList());
    this.emit('file:saved', { path: rel, bytes: res.bytes });
    this.emit('state', this.snapshot());
    return { ok: true, ...res, versionId: version.id };
  }

  snapshot() {
    const s = this.session;
    return {
      session: s.snapshotState(),
      provider: { name: this.provider.name, label: this.provider.label, ready: this.provider.ready, note: this.provider.note, model: this.config.model },
      busy: this.busy,
      run: this.run ? { id: this.run.id, kind: this.run.kind, mode: this.run.mode } : null,
      draft: this.draft ? { runId: this.draft.runId, files: this.draft.ops.map((o) => o.path), mode: this.draft.mode, ms: this.draft.ms } : null,
      versions: s.versionList(),
      intent: this.lastIntent,
      decision: this.lastDecision ? { mode: this.lastDecision.mode, ratio: this.lastDecision.ratio, reason: this.lastDecision.reason } : null,
      workspace: { files: this.workspace.listFiles().length, bytes: this.workspace.totalBytes(), recent: this.recentFiles },
      rag: this.rag ? this.rag.stats() : null,
      memory: this.memory ? this.memory.summary() : null,
      config: { specDelayMs: this.config.specDelayMs, commitIdleMs: this.config.commitIdleMs, settleMs: this.config.settleMs, intentThreshold: this.config.intentThreshold, autoCommit: this.config.autoCommit, autoAdoptHigh: this.config.autoAdoptHigh },
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
