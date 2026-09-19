// SynthFlow 会话：上下文栈、意图完整度判定、漂移决策、版本与回退。
// 这一层不碰网络，纯状态与判定逻辑，便于冒烟测试单独验证。
import fs from 'node:fs';
import path from 'node:path';
import { changedSpan, clamp, ensureDir, newId, nowIso, readJsonSafe, sha1, similarity, writeJsonAtomic } from './util.js';

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
    this.versions = []; // 版本链，index 0 是基线
    this.notes = []; // 被采纳/忽略的建议记录
    this.stats = { runs: 0, commits: 0, rollbacks: 0, charsGenerated: 0, adopted: 0, dismissed: 0 };

    this.pendingIntent = null;
    this.lastDecision = null;
    this.status = 'idle'; // idle | speculating | generating | applying | error

    const baseline = workspace.snapshot({ label: '基线', meta: { kind: 'baseline' } });
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
    return this.versions[this.versions.length - 1];
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
  recordCommit({ runId, promptBefore, promptAfter, files, summary, kind = 'turn', snapshotId }) {
    const versionId = `v${this.versions.length}`;
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
    };
    this.versions.push(rec);
    this.stats.commits += 1;
    for (const s of this.segments) if (s.runId === runId && !s.versionId) s.versionId = versionId;
    this.touch();
    return rec;
  }

  /**
   * 一键回退（想法 5）：回到"这句话还没输入时"的版本。
   * @param {string} [versionId] 默认回退最后一个版本
   */
  rollback(versionId) {
    const target = versionId
      ? this.versions.find((v) => v.id === versionId)
      : this.versions[this.versions.length - 1];
    if (!target || target.kind === 'baseline') return { ok: false, error: '已经位于最初版本，无法继续回退' };
    const idx = this.versions.indexOf(target);
    const prevVersion = this.versions[idx - 1];
    const restore = this.workspace.restore(prevVersion.snapshotId);
    const removed = this.versions.splice(idx);
    this.versions.forEach((v, i) => {
      v.seq = i;
    });
    const removedIds = new Set(removed.flatMap((v) => v.segmentIds));
    for (const s of this.segments) if (removedIds.has(s.id)) s.reverted = true;
    this.segments = this.segments.filter((s) => !s.reverted || s.kind !== 'adopt');
    this.prompt = target.promptBefore ?? '';
    this.pushSegment({
      kind: 'revert',
      text: this.prompt,
      delta: `回退到 ${prevVersion.id}`,
      meta: { from: target.id, to: prevVersion.id, restoredFiles: restore.restored },
    });
    this.stats.rollbacks += 1;
    this.touch();
    return {
      ok: true,
      restoredFrom: prevVersion.id,
      rolledBackVersion: target.id,
      files: restore.files,
      prompt: this.prompt,
    };
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
    return s;
  }

  snapshotState() {
    return {
      id: this.id,
      status: this.status,
      prompt: this.prompt,
      stats: this.stats,
      versionCount: this.versions.length - 1,
      currentVersionId: this.currentVersion?.id ?? 'v0',
      segments: this.segments.length,
    };
  }

  /** 精简版版本列表（给 UI 时间线）。 */
  versionList() {
    return this.versions.map((v) => ({
      id: v.id,
      seq: v.seq,
      kind: v.kind,
      summary: v.summary,
      files: v.files,
      createdAt: v.createdAt,
      promptAfter: v.promptAfter,
      isCurrent: v.id === this.currentVersion?.id,
    }));
  }
}
