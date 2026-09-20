// SynthFlow 会话：上下文栈、意图完整度判定、漂移决策、版本与回退。
// 这一层不碰网络，纯状态与判定逻辑，便于冒烟测试单独验证。
import fs from 'node:fs';
import path from 'node:path';
import { changedSpan, clamp, ensureDir, newId, nowIso, readJsonSafe, sha1, similarity, writeJsonAtomic } from './util.js';

/** 轮次前像日志的总体积上限（会话文件每次保存都会整份重写，不能无限膨胀）。 */
const JOURNAL_MAX_BYTES = 1.5 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * 1) 意图完整度判定（想法 6）
 *    "不要一个字刚打就立刻改代码" —— 用多信号打分，而不是单纯等固定时间。
 * ------------------------------------------------------------------ */

const FINAL_RE = /[。！？!?；;]\s*$/;
const SOFT_FINAL_RE = /[.．]\s*$/;
const COMMA_RE = /[,，、:：]\s*$/;
const CONTINUERS = [
  '的', '地', '得', '和', '与', '或', '或者', '以及', '并', '并且', '然后', '接着', '再', '还',
  '把', '将', '被', '给', '对', '向', '从', '在', '为', '让', '使', '用', '以', '因为', '所以',
  '如果', '当', '想要', '需要', '希望', '请', '帮我', '给我', '包含', '支持', '可以', '应该',
  '能够', '实现', '比如', '例如', '例如说', '像', '类似', '一个', '一些', '这个', '那个', '就是',
  '要', '是', '有', '能', '会', '做', '写', '加', '改',
  'the', 'a', 'an', 'and', 'or', 'with', 'for', 'to', 'of', 'in', 'on', 'that', 'which', 'using',
];
const VERB_RE =
  /(写|做|生成|创建|实现|添加|增加|加上|新增|修改|改成|改为|调整|优化|重构|修复|替换|删除|去掉|补全|完善|整理|拆分|合并|接入|支持|导出|展示|渲染|封装|搭建|设计|画|搞|来|开始|继续|帮我|给我|请|create|build|make|add|implement|write|generate|refactor|fix|optimi[sz]e|update|change|remove|delete|rename|extract|support|render|design|continue|go\s+on)/i;
const CONTINUE_ONLY_RE = /^(继续|接着|go on|continue|继续吧|往下|下一步|然后呢|ok|好的|可以|行|嗯)$/i;

/** 括号/引号/围栏是否闭合，未闭合说明用户还没写完。 */
function balanceSignals(text) {
  const pairs = [['(', ')'], ['[', ']'], ['{', '}'], ['（', '）'], ['【', '】'], ['《', '》']];
  let unbalanced = false;
  for (const [l, r] of pairs) {
    const lc = (text.split(l).length - 1);
    const rc = (text.split(r).length - 1);
    if (lc > rc) unbalanced = true;
  }
  const ticks = (text.match(/```/g) ?? []).length;
  const fencesOpen = ticks % 2 === 1;
  const quote = (text.match(/"/g) ?? []).length;
  const single = (text.match(/'/g) ?? []).length;
  return { unbalanced, fencesOpen, oddQuote: quote % 2 === 1 || single % 2 === 1 };
}

/**
 * @param {string} text 当前输入框内容
 * @param {{idleMs?:number, prevText?:string}} [ctx]
 */
export function analyzeIntent(text, ctx = {}) {
  const t = String(text ?? '');
  const trimmed = t.trim();
  const idleMs = ctx.idleMs ?? 0;
  const reasons = [];
  const b = balanceSignals(t);
  const tailChar = trimmed.slice(-1);
  const tailWord = (trimmed.match(/[A-Za-z_$][\w$]*$/) ?? [''])[0];
  const endsConnector = CONTINUERS.includes(tailChar) || CONTINUERS.includes(tailWord.toLowerCase());
  const endsFinal = FINAL_RE.test(trimmed) || SOFT_FINAL_RE.test(trimmed);
  const endsComma = COMMA_RE.test(trimmed);
  const hasVerb = VERB_RE.test(trimmed);
  const isContinue = CONTINUE_ONLY_RE.test(trimmed);
  const lengthOk = trimmed.length >= 6;

  let score = 0;
  if (!trimmed) return { score: 0, complete: false, reasons: ['空输入'], signals: { length: 0 } };

  if (lengthOk) score += 0.3;
  if (trimmed.length >= 18) score += 0.12;
  if (trimmed.length >= 40) score += 0.06;
  if (endsFinal) { score += 0.34; reasons.push('以句末标点结束'); }
  if (hasVerb) { score += 0.16; reasons.push('包含动作意图'); }
  if (isContinue) { score += 0.55; reasons.push('短指令但语义完整'); }
  if (b.unbalanced) { score -= 0.35; reasons.push('括号未闭合'); }
  if (b.fencesOpen) { score -= 0.3; reasons.push('代码围栏未闭合'); }
  if (endsConnector) { score -= 0.38; reasons.push(`结尾是连接词「${tailChar || tailWord}」，句子未完`); }
  if (endsComma) { score -= 0.26; reasons.push('结尾是逗号/顿号'); }
  if (tailChar && /[A-Za-z]$/.test(tailChar) && tailWord.length <= 2 && !isContinue) { score -= 0.12; reasons.push('结尾像未打完的单词'); }
  // 打字停顿越多越可能写完了
  if (idleMs >= 1200) score += 0.12;
  else if (idleMs >= 700) score += 0.06;
  // 相比上一次输入仍在增长：说明还在写
  if (ctx.prevText && trimmed.startsWith(String(ctx.prevText).trim()) && trimmed.length > String(ctx.prevText).trim().length) {
    score -= 0.05;
  }
  if (ctx.grewAtTail === false && ctx.prevText) { score += 0.05; }

  score = clamp(Number(score.toFixed(3)), 0, 1);
  const complete = score >= (ctx.threshold ?? 0.6);
  if (!endsFinal && !reasons.some((r) => r.includes('未完'))) reasons.push('未见句末标点');
  return {
    score,
    complete,
    confidence: score,
    reasons,
    signals: { length: trimmed.length, endsFinal, endsConnector, endsComma, hasVerb, ...b, idleMs, tailChar },
  };
}

/* ------------------------------------------------------------------ *
 * 2) 漂移决策（想法 4 / 7 / 9）
 *    输入框被改写时：该增量补丁、续写，还是重头生成？
 * ------------------------------------------------------------------ */

export const HEAVY_CODE_BYTES = 24 * 1024; // 已有产出超过这个体量就尽量避免全量重生成

/**
 * @param {string} prevPrompt 上一轮已经据以生成的 prompt
 * @param {string} nextPrompt 当前输入框内容
 * @param {{hasCode?:boolean, codeBytes?:number, anchorFiles?:string[], adoptedCount?:number}} [state]
 */
export function decidePromptChange(prevPrompt, nextPrompt, state = {}) {
  const prev = String(prevPrompt ?? '');
  const next = String(nextPrompt ?? '');
  const heavy = (state.codeBytes ?? 0) >= HEAVY_CODE_BYTES;
  if (!prev.trim()) {
    return { mode: 'regenerate', ratio: 1, reason: '首次生成', span: changedSpan('', next) };
  }
  if (prev.trim() === next.trim()) return { mode: 'noop', ratio: 0, reason: '内容未变化' };

  const sim = similarity(prev, next);
  const ratio = Number((1 - sim).toFixed(4));
  const span = changedSpan(prev, next);
  const addedLen = span.added.trim().length;
  const removedLen = span.removed.trim().length;

  // 纯尾部追加 → 续写/增量
  if (span.isAppend) {
    if (state.hasCode && ratio < 0.8) {
      return {
        mode: 'continue',
        ratio,
        reason: `尾部追加 ${addedLen} 字，基于已有产出增量续写`,
        span,
        instruction: `用户在原有提示词末尾追加了内容，请**在已有代码基础上增量续写**，不要重写已经正确的部分。新增内容：「${span.added.trim()}」`,
      };
    }
    return { mode: 'incremental', ratio, reason: '追加需求，增量生成', span };
  }

  // 中间/前文被改写
  if (ratio < 0.06) return { mode: 'noop', ratio, reason: '微小改动，忽略', span };
  const threshold = heavy ? 0.42 : 0.55;
  if (ratio < threshold) {
    return {
      mode: 'incremental',
      ratio,
      reason: `改动集中在第 ${span.start} 字符附近（${removedLen}→${addedLen} 字），只做定点增量更新`,
      span,
      instruction:
        `用户修改了提示词的中间片段：\n- 删除/替换掉：「${span.removed.trim().slice(0, 120)}」\n- 新的要求：「${span.added.trim().slice(0, 120)}」\n` +
        `请**只针对受影响的部分做增量补丁**（使用 search/replace），不要全量重写整个项目。` +
        (state.anchorFiles?.length ? `\n重点检查这些文件：${state.anchorFiles.join(', ')}` : ''),
    };
  }
  return {
    mode: 'regenerate',
    ratio,
    reason: `提示词变动幅度 ${(ratio * 100).toFixed(0)}%，已超出增量阈值`,
    span,
    instruction: '提示词整体意图已变化，请重新生成本轮所需文件（可复用仍然有效的部分）。',
  };
}

/* ------------------------------------------------------------------ *
 * 3) 会话对象
 * ------------------------------------------------------------------ */

export class Session {
  constructor({ id, workspace, storeDir, config = {} }) {
    this.id = id ?? newId('sess');
    this.workspace = workspace;
    this.storeDir = storeDir ?? path.join(workspace.storeDir, 'sessions');
    ensureDir(this.storeDir);
    this.config = config;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;

    this.prompt = ''; // 输入框当前完整内容 = 编译后的 Prompt
    this.segments = []; // 上下文栈：每一次对 prompt 的贡献
    this.versions = []; // 版本链（完整历史，不因回退而删除）
    this.versionSeq = 0; // 版本号单调递增，回退后再提交也不会撞号
    this.activeIndex = 0; // 游标：当前处于哪个版本（支持回退/前进）
    this.notes = []; // 被采纳/忽略的建议记录
    this.stats = { runs: 0, commits: 0, rollbacks: 0, forwards: 0, charsGenerated: 0, adopted: 0, dismissed: 0, modelCalls: 0, estTokens: 0 };

    this.pendingIntent = null;
    this.lastDecision = null;
    this.status = 'idle'; // idle | speculating | generating | applying | error

    // v3：把"思考与建议"持久化，刷新页面不丢（想法 3）
    this.timeline = [];
    // v3：用户手动改过的文件，下一轮要告知模型别覆盖（想法 1/A）
    this.manualEdits = [];
    this.maxTimeline = 40;
    // v3.1（想法 11）：只有点「保存为版本」才产生版本。
    // 这里记录"还没保存的改动"，并提供撤销所需的回合前快照。
    this.pendingRound = null;
    // v3.3：每一轮**改了哪些文件、改之前长什么样**。
    // 之前时间线上只有"已保存版本"，⏪ 也只能退到上一个已保存版本 ——
    // 中间那些没保存的轮次既看不见也退不动。这里用"只存这一轮碰过的文件"的前像
    // 把它补上（一轮通常 1-3 个文件，比每轮打一个全量快照省得多）。
    this.roundJournal = [];
    this.maxJournal = 40;
    this.syncEnabled = true;

    // 想法 & 修复：暂存模式下"基线"就是项目原样，用一个空快照表示即可 ——
    // 千万别在这里对真实项目做全量快照（切到大目录会复制几百 MB 并卡死服务端）。
    const baseline = workspace.staging
      ? workspace.emptySnapshot({ label: '基线（项目原样，未暂存任何改动）' })
      : workspace.snapshot({ label: '基线', meta: { kind: 'baseline' } });
    this.versions.push({
      id: 'v0',
      seq: 0,
      snapshotId: baseline.id,
      promptBefore: '',
      promptAfter: '',
      segmentIds: [],
      files: [],
      createdAt: this.createdAt,
      summary: '空项目基线',
      runId: null,
      kind: 'baseline',
    });
  }

  get file() {
    return path.join(this.storeDir, `${this.id}.json`);
  }

  get currentVersion() {
    return this.versions[this.activeIndex];
  }

  get activeVersionId() {
    return this.currentVersion?.id ?? 'v0';
  }

  get canBack() {
    return this.activeIndex > 0;
  }

  get canForward() {
    return this.activeIndex < this.versions.length - 1;
  }

  /** 编译后的完整 Prompt（想法 8）：当前输入 + 已采纳建议（已写回输入框，故此处直接返回）。 */
  compilePrompt() {
    return this.prompt.trim();
  }

  /** 供 UI 展示的完整上下文栈。 */
  contextStack() {
    return {
      prompt: this.compilePrompt(),
      chars: this.prompt.length,
      segments: this.segments.slice(-60),
      adopted: this.segments.filter((s) => s.kind === 'adopt').map((s) => ({ id: s.id, text: s.text })),
    };
  }

  pushSegment(seg) {
    const item = {
      id: seg.id ?? newId('seg'),
      kind: seg.kind ?? 'typed',
      text: seg.text ?? '',
      delta: seg.delta ?? '',
      createdAt: nowIso(),
      runId: seg.runId ?? null,
      versionId: seg.versionId ?? null,
      files: seg.files ?? [],
      reverted: false,
      meta: seg.meta ?? {},
    };
    this.segments.push(item);
    this.touch();
    return item;
  }

  setPrompt(text, meta = {}) {
    const prev = this.prompt;
    const next = String(text ?? '');
    if (prev === next) return null;
    this.prompt = next;
    const span = changedSpan(prev, next);
    return this.pushSegment({
      kind: meta.kind ?? 'typed',
      text: next,
      delta: span.isAppend ? span.added : `${span.removed ? `-${span.removed}` : ''}${span.added ? `+${span.added}` : ''}`,
      meta: { ...meta, span: { start: span.start, isAppend: span.isAppend } },
    });
  }

  /** 采纳一条建议：写入 prompt，并记录在上下文栈里（想法 2/10）。 */
  adoptSuggestion(suggestion, { auto = true } = {}) {
    const insert = (suggestion.insert || suggestion.title || '').trim();
    const body = suggestion.body ? `\n（来自 SynthFlow 建议：${suggestion.body.split('\n')[0].slice(0, 80)}）` : '';
    const addition = insert ? `${insert}` : '';
    if (!addition) return { ok: false, error: '建议没有可写入的内容' };
    const prev = this.prompt;
    this.prompt = `${prev.trimEnd()}\n${addition}`.trim();
    const seg = this.pushSegment({
      kind: 'adopt',
      text: addition,
      delta: addition,
      meta: { suggestionId: suggestion.id, kind: suggestion.kind, title: suggestion.title, auto, body },
    });
    this.stats.adopted += 1;
    this.notes.push({ at: nowIso(), type: 'adopt', suggestion: { id: suggestion.id, kind: suggestion.kind, title: suggestion.title } });
    return { ok: true, segment: seg, prompt: this.prompt, previousPrompt: prev };
  }

  dismissSuggestion(suggestion) {
    this.stats.dismissed += 1;
    this.notes.push({ at: nowIso(), type: 'dismiss', suggestion: { id: suggestion?.id, kind: suggestion?.kind, title: suggestion?.title } });
    this.touch();
  }

  /** 记录一次生成运行的结果，并产生新版本。 */
  recordCommit({ runId, promptBefore, promptAfter, files, summary, kind = 'turn', snapshotId, confirmed = true }) {
    // 若游标停在历史版本上继续生成，右侧那条分支会被丢弃（与 git 在历史提交上继续提交一致）。
    let dropped = 0;
    if (this.activeIndex < this.versions.length - 1) {
      dropped = this.versions.length - 1 - this.activeIndex;
      this.versions = this.versions.slice(0, this.activeIndex + 1);
    }
    this.versionSeq += 1;
    const versionId = `v${this.versionSeq}`;
    const rec = {
      id: versionId,
      seq: this.versions.length,
      snapshotId,
      promptBefore,
      promptAfter,
      segmentIds: this.segments.filter((s) => s.runId === runId).map((s) => s.id),
      files,
      createdAt: nowIso(),
      summary,
      runId,
      kind,
      // 想法 2：saveMode 为 confirm 时，版本先标记"待确认"，界面上给保留/丢弃按钮
      confirmed,
      confirmedAt: confirmed ? nowIso() : null,
    };
    this.versions.push(rec);
    this.activeIndex = this.versions.length - 1;
    this.stats.commits += 1;
    for (const s of this.segments) if (s.runId === runId && !s.versionId) s.versionId = versionId;
    this.touch();
    rec.droppedBranches = dropped;
    return rec;
  }

  /**
   * 在版本链上移动游标（想法 9：回退之后还能前进回去）。
   * @param {'back'|'forward'} direction
   * @param {string} [versionId] 直接跳到指定版本
   */
  moveVersion(direction = 'back', versionId) {
    const cur = this.activeIndex;
    let target = cur;
    if (versionId) {
      const i = this.versions.findIndex((v) => v.id === versionId);
      if (i < 0) return { ok: false, error: `版本不存在: ${versionId}` };
      target = i;
    } else if (direction === 'forward') {
      target = cur + 1;
    } else {
      target = cur - 1;
    }
    if (target < 0) return { ok: false, error: '已经是最初版本，无法继续回退' };
    if (target > this.versions.length - 1) return { ok: false, error: '已经是最新版本，无法继续前进' };
    if (target === cur) return { ok: false, error: '已经位于该版本' };

    const v = this.versions[target];
    let restore;
    try {
      restore = this.workspace.restore(v.snapshotId);
    } catch (err) {
      return { ok: false, error: `恢复快照失败：${err.message}` };
    }
    this.activeIndex = target;
    this.prompt = v.promptAfter ?? '';
    this.pushSegment({
      kind: 'revert',
      text: this.prompt,
      delta: `${direction === 'forward' ? '前进' : '回退'}到 ${v.id}`,
      meta: { from: this.versions[cur]?.id, to: v.id, direction, restoredFiles: restore.restored },
    });
    if (direction === 'forward') this.stats.forwards = (this.stats.forwards ?? 0) + 1;
    else this.stats.rollbacks += 1;
    this.touch();
    return {
      ok: true,
      direction,
      activeVersionId: v.id,
      files: restore.files,
      restored: restore.restored,
      prompt: this.prompt,
      canBack: this.canBack,
      canForward: this.canForward,
      versions: this.versionList(),
    };
  }

  /** 兼容旧接口：回退一步。 */
  rollback(versionId) {
    if (versionId) {
      const i = this.versions.findIndex((v) => v.id === versionId);
      if (i < 0) return { ok: false, error: `版本不存在: ${versionId}` };
      if (i === this.activeIndex) return { ok: false, error: '已经位于该版本' };
      return this.moveVersion(i < this.activeIndex ? 'back' : 'forward', versionId);
    }
    return this.moveVersion('back');
  }

  /** 记录一轮生成（思考/建议/文件操作），用于刷新后回灌思考栏。 */
  recordRound(rec) {
    const item = {
      id: rec.id,
      kind: rec.kind ?? 'run',
      mode: rec.mode ?? 'regenerate',
      at: rec.at ?? nowIso(),
      ms: rec.ms ?? 0,
      files: rec.files ?? [],
      versionId: rec.versionId ?? null,
      thoughts: (rec.thoughts ?? []).slice(0, 6).map((t) => String(t).slice(0, 3000)),
      suggestions: (rec.suggestions ?? []).slice(0, 8),
      ops: (rec.ops ?? []).slice(0, 40),
      error: rec.error ?? null,
    };
    this.timeline.push(item);
    if (this.timeline.length > this.maxTimeline) this.timeline = this.timeline.slice(-this.maxTimeline);
    this.touch();
    return item;
  }

  /** 用户手动改了文件（想法 1/A）：记录下来，下一轮提示词里要告诉模型"这是人改的"。 */
  noteManualEdit({ path: rel, summary = '', chars = 0 }) {
    const exist = this.manualEdits.find((m) => m.path === rel);
    if (exist) {
      exist.at = nowIso();
      exist.count += 1;
      exist.summary = summary || exist.summary;
      exist.chars = chars || exist.chars;
    } else {
      this.manualEdits.push({ path: rel, at: nowIso(), count: 1, summary, chars });
    }
    if (this.manualEdits.length > 20) this.manualEdits = this.manualEdits.slice(-20);
    this.touch();
    return this.manualEdits;
  }

  clearManualEdits(paths) {
    if (!paths?.length) {
      this.manualEdits = [];
    } else {
      this.manualEdits = this.manualEdits.filter((m) => !paths.includes(m.path));
    }
    this.touch();
  }

  /** 记录"还没保存为版本"的改动（想法 11）。 */
  setPendingRound(rec) {
    this.pendingRound = { ...(this.pendingRound ?? {}), ...rec };
    this.touch();
    return this.pendingRound;
  }

  clearPendingRound() {
    this.pendingRound = null;
    this.touch();
  }

  /* ------------------------- 轮次前像日志（v3.3） ------------------------- */

  /**
   * 记一轮"改之前的文件内容"。必须在这一轮真正写盘**之前**调用。
   * @param {{id:string, prompt?:string, mode?:string, files:Object<string,{existed:boolean,content:string|null}>, skipped?:string[]}} entry
   */
  pushRoundJournal(entry) {
    this.roundJournal.push({
      id: entry.id,
      at: entry.at ?? nowIso(),
      prompt: String(entry.prompt ?? '').slice(0, 160),
      mode: entry.mode ?? '',
      files: entry.files ?? {},
      skipped: entry.skipped ?? [],
    });
    if (this.roundJournal.length > this.maxJournal) {
      this.roundJournal = this.roundJournal.slice(-this.maxJournal);
    }
    // 体积也要剪：会话文件每次 save() 都会整份写盘，不能让它无限膨胀
    let total = this.journalBytes();
    while (total > JOURNAL_MAX_BYTES && this.roundJournal.length > 1) {
      const dropped = this.roundJournal.shift();
      for (const f of Object.values(dropped.files ?? {})) total -= (f.content?.length ?? 0);
    }
    this.touch();
    return this.roundJournal.length;
  }

  journalBytes() {
    let total = 0;
    for (const e of this.roundJournal) {
      for (const f of Object.values(e.files ?? {})) total += (f.content?.length ?? 0) + 32;
    }
    return total;
  }

  /** 保存版本之后，这些"未保存的轮次"已经进了版本，前像就没用了。 */
  clearRoundJournal() {
    this.roundJournal = [];
    this.touch();
  }

  popRoundJournal() {
    const entry = this.roundJournal.pop() ?? null;
    if (entry) this.touch();
    return entry;
  }

  /** 给界面看的精简清单（不带文件内容，只带"这一轮动了哪些文件"）。 */
  roundJournalBrief() {
    return this.roundJournal.map((e, i) => ({
      n: i + 1,
      id: e.id,
      at: e.at,
      prompt: e.prompt,
      mode: e.mode,
      files: Object.keys(e.files ?? {}),
      skipped: e.skipped ?? [],
    }));
  }

  /** 确认一个"待确认"版本（想法 2）。 */
  confirmVersion(versionId) {
    const v = versionId ? this.versions.find((x) => x.id === versionId) : this.currentVersion;
    if (!v) return { ok: false, error: '版本不存在' };
    v.confirmed = true;
    v.confirmedAt = nowIso();
    this.touch();
    return { ok: true, versionId: v.id, versions: this.versionList() };
  }

  /** 丢弃一个"待确认"版本：等价于回退到它之前的那一版。 */
  discardVersion(versionId) {
    const idx = versionId ? this.versions.findIndex((v) => v.id === versionId) : this.activeIndex;
    if (idx < 0) return { ok: false, error: '版本不存在' };
    if (idx === 0) return { ok: false, error: '基线版本不能丢弃' };
    if (idx !== this.activeIndex) return { ok: false, error: '只能丢弃当前所在的版本（先回退到它）' };
    return this.moveVersion('back');
  }

  get pendingConfirm() {
    return this.versions.filter((v) => v.kind !== 'baseline' && v.confirmed === false).map((v) => v.id);
  }

  save() {
    this.updatedAt = nowIso();
    writeJsonAtomic(this.file, {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      prompt: this.prompt,
      segments: this.segments,
      versions: this.versions,
      notes: this.notes,
      stats: this.stats,
      timeline: this.timeline,
      manualEdits: this.manualEdits,
      pendingRound: this.pendingRound,
      roundJournal: this.roundJournal,
      syncEnabled: this.syncEnabled,
      versionSeq: this.versionSeq,
      activeIndex: this.activeIndex,
      promptHash: sha1(this.prompt),
    });
    this.appendHistory();
  }

  appendHistory() {
    const line = `${JSON.stringify({
      at: this.updatedAt,
      promptChars: this.prompt.length,
      segments: this.segments.length,
      versions: this.versions.length - 1,
      stats: this.stats,
    })}\n`;
    try {
      fs.appendFileSync(path.join(this.workspace.historyDir, 'sessions.jsonl'), line, 'utf8');
    } catch { /* ignore */ }
  }

  touch() {
    this.updatedAt = nowIso();
  }

  static load(file, { workspace, config } = {}) {
    const data = readJsonSafe(file, null);
    if (!data) return null;
    const s = Object.create(Session.prototype);
    Object.assign(s, data, { workspace, config: config ?? {}, storeDir: path.dirname(file), status: 'idle', pendingIntent: null, lastDecision: null });
    // 兼容旧存档：游标默认落在最后一个版本上
    if (typeof s.activeIndex !== 'number' || s.activeIndex < 0 || s.activeIndex >= s.versions.length) {
      s.activeIndex = Math.max(0, s.versions.length - 1);
    }
    if (typeof s.versionSeq !== 'number') {
      s.versionSeq = s.versions.reduce((max, v) => Math.max(max, Number(String(v.id).replace(/^v/, '')) || 0), 0);
    }
    s.stats = { runs: 0, commits: 0, rollbacks: 0, forwards: 0, charsGenerated: 0, adopted: 0, dismissed: 0, modelCalls: 0, estTokens: 0, ...(data.stats ?? {}) };
    if (!Array.isArray(s.timeline)) s.timeline = [];
    if (!Array.isArray(s.manualEdits)) s.manualEdits = [];
    if (!Array.isArray(s.roundJournal)) s.roundJournal = [];
    if (!s.pendingRound) s.pendingRound = null;
    if (typeof s.syncEnabled !== 'boolean') s.syncEnabled = true;
    s.maxTimeline = 40;
    s.maxJournal = 40;
    return s;
  }

  /** 清空思考栏（想法 8）。 */
  clearTimeline() {
    const n = this.timeline.length;
    this.timeline = [];
    this.touch();
    return { ok: true, cleared: n };
  }

  snapshotState() {
    return {
      id: this.id,
      status: this.status,
      prompt: this.prompt,
      stats: this.stats,
      versionCount: this.versions.length - 1,
      currentVersionId: this.activeVersionId,
      activeIndex: this.activeIndex,
      canBack: this.canBack,
      canForward: this.canForward,
      segments: this.segments.length,
    };
  }

  /** 精简版版本列表（给 UI 时间线）。 */
  versionList() {
    return {
      versions: this.versions.map((v, i) => ({
        id: v.id,
        seq: i,
        kind: v.kind,
        summary: v.summary,
        files: v.files,
        createdAt: v.createdAt,
        promptAfter: v.promptAfter,
        isCurrent: i === this.activeIndex,
        ahead: i > this.activeIndex,
        confirmed: v.confirmed !== false,
      })),
      activeVersionId: this.activeVersionId,
      activeIndex: this.activeIndex,
      canBack: this.canBack,
      canForward: this.canForward,
      pendingConfirm: this.pendingConfirm,
    };
  }
}
