// SynthFlow 前端 · 核心：状态、DOM 引用、通用工具、语法高亮。
// 说明：这里刻意用"经典脚本 + 全局 const"而不是 ES Module，
// 这样冒烟测试可以把几个文件按顺序拼起来在最小 DOM 上真跑一遍（见 scripts/smoke.mjs）。

const $ = (sel) => document.querySelector(sel);

const el = {
  providerBadge: $('#provider-badge'),
  profileSelect: $('#profile-select'),
  runBadge: $('#run-badge'),
  projectChip: $('#project-chip'),
  btnUndo: $('#btn-undo'),
  btnRedo: $('#btn-redo'),
  btnRegenerate: $('#btn-regenerate'),
  btnSaveVersion: $('#btn-save-version'),
  unsavedBadge: $('#unsaved-badge'),
  btnLayout: $('#btn-layout'),
  btnTheme: $('#btn-theme'),
  btnSettings: $('#btn-settings'),
  btnHelp: $('#btn-help'),
  wsStats: $('#ws-stats'),
  fileTree: $('#file-tree'),
  btnTreeToggle: $('#btn-tree-toggle'),
  btnTreeRefresh: $('#btn-tree-refresh'),
  timeline: $('#timeline'),
  versionHint: $('#version-hint'),
  tabs: $('#tabs'),
  currentPath: $('#current-path'),
  fileMeta: $('#file-meta'),
  dirtyDot: $('#dirty-dot'),
  btnSave: $('#btn-save'),
  viewToggle: $('#view-toggle'),
  diffCount: $('#diff-count'),
  editorHost: $('#editor-host'),
  diffHost: $('#diff-host'),
  code: $('#code'),
  codePre: $('#code-pre'),
  diffPre: $('#diff-pre'),
  diffCode: $('#diff-code'),
  editorEmpty: $('#editor-empty'),
  pendingBar: $('#pending-bar'),
  pendingText: $('#pending-text'),
  btnApplyPending: $('#btn-apply-pending'),
  btnDiscardPending: $('#btn-discard-pending'),
  streamBody: $('#stream-body'),
  unreadBadge: $('#unread-badge'),
  roundLabel: $('#round-label'),
  btnThinkMode: $('#btn-think-mode'),
  btnRoundPrev: $('#btn-round-prev'),
  btnRoundNext: $('#btn-round-next'),
  streamLimit: $('#stream-limit'),
  streamLimitText: $('#stream-limit-text'),
  btnStreamCompress: $('#btn-stream-compress'),
  btnStreamClear: $('#btn-stream-clear'),
  intentFill: $('#intent-fill'),
  intentText: $('#intent-text'),
  decisionText: $('#decision-text'),
  prompt: $('#prompt'),
  selectionChip: $('#selection-chip'),
  selectionText: $('#selection-text'),
  selectionClear: $('#selection-clear'),
  btnStop: $('#btn-stop'),
  btnSync: $('#btn-sync'),
  btnCommit: $('#btn-commit'),
  btnCompact: $('#btn-compact'),
  compactStyle: $('#compact-style'),
  compactHint: $('#compact-hint'),
  btnImport: $('#btn-import'),
  btnExport: $('#btn-export'),
  fileInput: $('#file-input'),
  statusDot: $('#status-dot'),
  statusText: $('#status-text'),
  statusDetail: $('#status-detail'),
  usage: $('#usage'),
  counter: $('#counter'),
  toasts: $('#toasts'),
  palette: $('#palette'),
  paletteInput: $('#palette-input'),
  paletteList: $('#palette-list'),
  helpModal: $('#help-modal'),
  modal: $('#settings-modal'),
  pickerModal: $('#picker-modal'),
  pickerUp: $('#picker-up'),
  pickerPath: $('#picker-path'),
  pickerGo: $('#picker-go'),
  pickerDrives: $('#picker-drives'),
  pickerList: $('#picker-list'),
  pickerHint: $('#picker-hint'),
  pickerUse: $('#picker-use'),
  pickerDirect: $('#picker-direct'),
  pickerClose: $('#picker-close'),
  compactModal: $('#compact-modal'),
  compactStat: $('#compact-stat'),
  compactBefore: $('#compact-before'),
  compactAfter: $('#compact-after'),
  compactApply: $('#compact-apply'),
  compactUndo: $('#compact-undo'),
  compactClose: $('#compact-close'),
  layoutPanel: $('#layout-panel'),
};

const LS = {
  get: (k, d) => {
    try {
      const v = localStorage.getItem(`sf.${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(`sf.${k}`, JSON.stringify(v));
    } catch { /* ignore */ }
  },
};

const S = {
  files: {},
  live: {},
  diffs: {},
  baseline: {},      // 本轮差异的原稿（切换差异视图时按需拉取）
  openTabs: [],
  current: null,
  view: 'code',      // code | diff
  compareFrom: '',   // 对比的历史版本 id，空 = 本轮差异
  tree: null,
  versions: [],
  activeVersionId: 'v0',
  canBack: false,
  canForward: false,
  pendingConfirm: [],
  rounds: [],
  currentRound: null,
  suggestions: [],
  unread: 0,
  usage: { calls: 0, tokens: 0, last: 0 },
  statusKind: 'idle',
  statusAt: 0,
  busy: false,
  provider: null,
  profile: null,
  staging: false,
  projectDir: '',
  pending: [],
  selection: null,
  manualEdits: [],
  style: null,
  thinkExpandAll: LS.get('thinkExpand', false),
  theme: LS.get('theme', 'system'),
  monacoReady: false,
  collapsedDirs: new Set(LS.get('collapsedDirs', [])),
  // 想法 11：只有点「保存为版本」才产生版本；这里跟踪"还没保存的改动"
  unsaved: null,
  syncEnabled: true,
  compactUndo: null,
  streamLimitKB: 1024,
};

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const MODE_TEXT = { regenerate: '全新生成', continue: '增量续写', incremental: '定点增量补丁', noop: '忽略微小改动' };

/* ============================ 提示与请求 ============================ */

const recentToasts = new Map();
function toast(message, level = 'ok', ms = 4200) {
  if (!el.toasts) return;
  const key = `${level}:${message}`;
  const now = Date.now();
  if (recentToasts.has(key) && now - recentToasts.get(key) < 4000) return;
  recentToasts.set(key, now);
  while (el.toasts.children.length >= 3) el.toasts.firstChild.remove();
  const div = document.createElement('div');
  div.className = `toast ${level}`;
  div.textContent = message;
  el.toasts.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transform = 'translateX(12px)';
    setTimeout(() => div.remove(), 260);
  }, ms);
}

/** 统一的请求封装：带超时，避免"界面看起来卡死"（网络层挂住时至少会报错）。 */
const post = async (url, body, { timeoutMs = 60000 } = {}) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
};
const get = async (url, { timeoutMs = 60000 } = {}) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
};

/* ============================ 状态栏 ============================ */

function setStatus(kind, text, detail = '') {
  const dot = { idle: 'idle', typing: 'typing', spec: 'busy', gen: 'busy', apply: 'busy', retry: 'busy', done: 'ok', err: 'err' }[kind] ?? 'idle';
  if (el.statusDot) el.statusDot.className = `status-dot ${dot}`;
  if (el.statusText) el.statusText.textContent = text;
  if (el.statusDetail) el.statusDetail.textContent = detail;
  S.statusKind = kind;
  S.statusAt = Date.now();
}

function renderUsage() {
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
  const parts = [];
  if (S.usage.last) parts.push(`本轮 ≈${fmt(S.usage.last)}`);
  parts.push(`累计 ${S.usage.calls} 次调用`);
  if (S.usage.tokens) parts.push(`${fmt(S.usage.tokens)} tokens`);
  if (el.usage) el.usage.textContent = parts.join(' · ');
}

/* ======================== 代码高亮（Monaco 不可用时的降级） ======================== */

const KEYWORDS =
  'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|class|extends|new|delete|typeof|instanceof|in|of|this|super|static|get|set|async|await|yield|try|catch|finally|throw|import|export|from|as|void|null|undefined|true|false|interface|type|implements|public|private|protected|readonly|enum|namespace|def|lambda|pass|raise|with|elif|None|True|False|self|struct|fn|impl|pub|use|mut|package|func|defer|go|chan|select';

function rulesFor(lang) {
  const R = (name, re) => ({ name, re });
  if (['javascript', 'typescript', 'js', 'ts', 'vue', 'svelte'].includes(lang)) {
    return [
      R('tok-com', /\/\/[^\n]*|\/\*[\s\S]*?\*\//y),
      R('tok-str', /`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/y),
      R('tok-num', /\b0[xX][\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y),
      R('tok-key', new RegExp(`\\b(?:${KEYWORDS})\\b`, 'y')),
      R('tok-fn', /\b[A-Za-z_$][\w$]*(?=\s*\()/y),
      R('tok-var', /\b[A-Za-z_$][\w$]*\b/y),
      R('tok-punc', /[{}()[\];,.=+\-*/%<>!&|?:]+/y),
    ];
  }
  if (lang === 'css' || lang === 'scss' || lang === 'less') {
    return [
      R('tok-com', /\/\*[\s\S]*?\*\//y),
      R('tok-str', /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/y),
      R('tok-key', /@[a-zA-Z-]+|--[\w-]+/y),
      R('tok-fn', /[-a-zA-Z]+(?=\s*:)/y),
      R('tok-num', /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b/y),
      R('tok-tag', /\.[-\w]+|#[-\w]+|::?[-\w()]+/y),
      R('tok-punc', /[{}();:,]/y),
      R('tok-var', /[-\w]+/y),
    ];
  }
  if (lang === 'html' || lang === 'xml' || lang === 'svg') {
    return [
      R('tok-com', /<!--[\s\S]*?-->/y),
      R('tok-str', /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/y),
      R('tok-tag', /<\/?[a-zA-Z][\w-]*|\/?>/y),
      R('tok-attr', /\b[a-zA-Z-]+(?==)/y),
      R('tok-punc', /[=<>/]/y),
    ];
  }
  if (lang === 'json') {
    return [
      R('tok-attr', /"(?:\\.|[^"\\])*"(?=\s*:)/y),
      R('tok-str', /"(?:\\.|[^"\\])*"/y),
      R('tok-num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y),
      R('tok-key', /\b(?:true|false|null)\b/y),
      R('tok-punc', /[{}[\]:,]/y),
    ];
  }
  if (lang === 'markdown') {
    return [
      R('tok-com', /^#{1,6}[^\n]*/my),
      R('tok-str', /`[^`\n]*`/y),
      R('tok-key', /\*\*[^*\n]+\*\*/y),
      R('tok-tag', /^\s*[-*+]\s/my),
      R('tok-punc', /^>\s?/my),
    ];
  }
  return [R('tok-com', /#[^\n]*/y), R('tok-str', /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/y), R('tok-num', /\b\d+(?:\.\d+)?\b/y)];
}

/** 逐行高亮：返回每一行的 HTML（必须逐行，否则没法标"本轮新增行"，跨行结构也会断标签）。 */
function highlightLines(code, lang) {
  const rules = rulesFor(lang);
  const lines = [];
  let cur = '';
  let openCls = null;
  const closeSpan = () => {
    if (openCls) {
      cur += '</span>';
      openCls = null;
    }
  };
  const openSpan = (cls) => {
    if (cls === openCls) return;
    closeSpan();
    if (cls) {
      cur += `<span class="${cls}">`;
      openCls = cls;
    }
  };
  const push = (cls, text) => {
    const parts = String(text).split('\n');
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        closeSpan();
        lines.push(cur);
        cur = '';
      }
      openSpan(cls);
      if (parts[i]) cur += esc(parts[i]);
    }
  };
  let i = 0;
  let plain = '';
  const flush = () => {
    if (plain) {
      push(null, plain);
      plain = '';
    }
  };
  const n = code.length;
  let guard = 0;
  while (i < n && guard++ < 500000) {
    let matched = false;
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(code);
      if (m && m.index === i && m[0].length > 0) {
        flush();
        push(r.name, m[0]);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      plain += code[i];
      i += 1;
      if (plain.length > 256) flush();
    }
  }
  flush();
  closeSpan();
  lines.push(cur);
  return lines;
}

const langOf = (p) => (p.split('.').pop() || 'text').toLowerCase();

/* ============================ 文件缓存 ============================ */

function updateWorkspaceStats() {
  const count = Object.keys(S.files).length;
  const bytes = Object.values(S.files).reduce((a, c) => a + (typeof c === 'string' ? c.length : 0), 0);
  if (el.wsStats) el.wsStats.textContent = count ? ` ${count} 个 · ${(bytes / 1024).toFixed(1)} KB` : '';
}

/**
 * 把文件内容写进缓存。必须先校验类型：接口一旦返回非预期结构，
 * 直接赋值会让 content 变成 undefined，随后任何 .length / split 都会把整个界面打崩。
 */
function cacheFile(path, data) {
  S.files[path] = typeof data?.content === 'string' ? data.content : S.files[path] ?? '';
  return S.files[path];
}

async function pullFile(path) {
  try {
    const f = await get(`/api/file?path=${encodeURIComponent(path)}`);
    return cacheFile(path, f);
  } catch {
    if (typeof S.files[path] !== 'string') S.files[path] = '';
    return S.files[path];
  }
}
