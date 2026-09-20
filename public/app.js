// SynthFlow 前端：SSE 驱动的实时工作台。
// 设计要点：
//   · 输入不"发送"，只持续上报；服务端负责预演/意图判定/落盘，前端只负责呈现与干预
//   · 每一轮生成是一个可折叠、可跳转、带锚点的"轮次块"，思考默认折叠
//   · 差异不再占用底部空间，改为代码区一键切换「完整代码 ⇄ 本轮差异」

const $ = (sel) => document.querySelector(sel);

const el = {
  providerBadge: $('#provider-badge'),
  runBadge: $('#run-badge'),
  btnUndo: $('#btn-undo'),
  btnRedo: $('#btn-redo'),
  btnRegenerate: $('#btn-regenerate'),
  btnTheme: $('#btn-theme'),
  btnSettings: $('#btn-settings'),
  wsStats: $('#ws-stats'),
  fileTree: $('#file-tree'),
  timeline: $('#timeline'),
  versionHint: $('#version-hint'),
  tabs: $('#tabs'),
  currentPath: $('#current-path'),
  fileMeta: $('#file-meta'),
  btnSave: $('#btn-save'),
  viewToggle: $('#view-toggle'),
  diffCount: $('#diff-count'),
  code: $('#code'),
  codePre: $('#code-pre'),
  editorEmpty: $('#editor-empty'),
  streamBody: $('#stream-body'),
  unreadBadge: $('#unread-badge'),
  roundLabel: $('#round-label'),
  btnThinkMode: $('#btn-think-mode'),
  btnRoundPrev: $('#btn-round-prev'),
  btnRoundNext: $('#btn-round-next'),
  intentFill: $('#intent-fill'),
  intentText: $('#intent-text'),
  decisionText: $('#decision-text'),
  prompt: $('#prompt'),
  btnCommit: $('#btn-commit'),
  btnCancel: $('#btn-cancel'),
  chips: $('#chips'),
  statusDot: $('#status-dot'),
  statusText: $('#status-text'),
  statusDetail: $('#status-detail'),
  usage: $('#usage'),
  counter: $('#counter'),
  btnHelp: $('#btn-help'),
  toasts: $('#toasts'),
  palette: $('#palette'),
  paletteInput: $('#palette-input'),
  paletteList: $('#palette-list'),
  helpModal: $('#help-modal'),
  modal: $('#settings-modal'),
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
  files: {},          // 已落盘文件内容
  live: {},           // 生成中文件的实时缓冲 { content, diff, autoscroll }
  diffs: {},          // 每个文件"本轮"的差异 { compact, added:Set, round }
  openTabs: [],
  current: null,
  view: 'code',       // code | diff
  tree: null,
  versions: [],
  activeVersionId: 'v0',
  canBack: false,
  canForward: false,
  rounds: [],         // [{ id, kind, mode, el, idx, collapsed }]
  currentRound: null,
  suggestions: [],    // [{ sg, roundId, handled, el }]
  unread: 0,
  // 用量以服务端 session.stats 为准（单一数据源），last 是本轮的 token 数
  usage: { calls: 0, tokens: 0, last: 0 },
  statusKind: 'idle',
  statusAt: 0,
  busy: false,
  provider: null,
  thinkExpandAll: LS.get('thinkExpand', false),
  theme: LS.get('theme', 'system'),
};

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* ============================ 提示与请求 ============================ */

const recentToasts = new Map();
function toast(message, level = 'ok', ms = 4200) {
  const key = `${level}:${message}`;
  const now = Date.now();
  if (recentToasts.has(key) && now - recentToasts.get(key) < 4000) return; // 去重：同类提示 4 秒内只弹一次
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

const post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
};
const get = async (url) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
};

/* ======================== 状态栏（替代大部分 toast） ======================== */

function setStatus(kind, text, detail = '') {
  const dot = { idle: 'idle', typing: 'typing', spec: 'busy', gen: 'busy', apply: 'busy', retry: 'busy', done: 'ok', err: 'err' }[kind] ?? 'idle';
  el.statusDot.className = `status-dot ${dot}`;
  el.statusText.textContent = text;
  el.statusDetail.textContent = detail;
  S.statusKind = kind;
  S.statusAt = Date.now();
}

function renderUsage() {
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
  const parts = [];
  if (S.usage.last) parts.push(`本轮 ≈${fmt(S.usage.last)}`);
  parts.push(`累计 ${S.usage.calls} 次调用`);
  if (S.usage.tokens) parts.push(`${fmt(S.usage.tokens)} tokens`);
  el.usage.textContent = parts.join(' · ');
}

/* ======================== 代码高亮（内置，无依赖） ======================== */

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

/**
 * 逐行高亮：返回每一行的 HTML。
 * 必须逐行输出，否则没法给"本轮新增行"加标记，也会让跨行的注释/模板串把标签截断。
 */
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

/* ============================ 文件树 ============================ */

function renderTree(tree) {
  S.tree = tree;
  const container = el.fileTree;
  container.innerHTML = '';
  const walk = (node, depth, parent) => {
    for (const child of node.children ?? []) {
      const row = document.createElement('div');
      row.className = `tree-item ${child.type === 'dir' ? 'tree-dir' : 'tree-file'}`;
      row.style.paddingLeft = `${8 + depth * 12}px`;
      if (child.type === 'dir') {
        row.innerHTML = `<span class="name">${esc(child.name)}</span>`;
        parent.appendChild(row);
        const kids = document.createElement('div');
        kids.className = 'tree-children';
        parent.appendChild(kids);
        walk(child, depth + 1, kids);
      } else {
        const touched = S.diffs[child.path] ? '<span class="dot"></span>' : '';
        row.innerHTML = `<span class="name">${esc(child.name)}</span>${touched}`;
        row.dataset.path = child.path;
        row.title = child.path;
        if (S.current === child.path) row.classList.add('selected');
        row.addEventListener('click', () => openFile(child.path));
        parent.appendChild(row);
      }
    }
  };
  if (!(tree.children ?? []).length) {
    container.innerHTML = '<p class="empty">还没有文件。开始输入需求，我会自动建目录和文件。</p>';
    return;
  }
  walk(tree, 0, container);
}

function updateWorkspaceStats() {
  const count = Object.keys(S.files).length;
  const bytes = Object.values(S.files).reduce((a, c) => a + (typeof c === 'string' ? c.length : 0), 0);
  el.wsStats.textContent = count ? ` ${count} 个 · ${(bytes / 1024).toFixed(1)} KB` : '';
}

/**
 * 把文件内容写进缓存。必须先校验类型：
 * 接口一旦返回了非预期结构（错误对象等），直接赋值会让 content 变成 undefined，
 * 随后任何 .length / split 都会把整个界面打崩。
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

/* ============================ 标签页 ============================ */

function renderTabs() {
  el.tabs.innerHTML = '';
  for (const path of S.openTabs) {
    const tab = document.createElement('div');
    tab.className = `tab${S.current === path ? ' active' : ''}${S.live[path] ? ' live' : ''}`;
    tab.innerHTML = `<span class="tab-name">${esc(path.split('/').pop())}</span><span class="tab-close">×</span>`;
    tab.title = path;
    tab.querySelector('.tab-name').addEventListener('click', () => openFile(path));
    tab.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      S.openTabs = S.openTabs.filter((p) => p !== path);
      if (S.current === path) S.current = S.openTabs[S.openTabs.length - 1] ?? null;
      renderTabs();
      renderCode();
    });
    el.tabs.appendChild(tab);
  }
}

/* ============================ 代码区 ============================ */

let rafPending = false;
function scheduleDraw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    drawCode();
  });
}

function currentDiff(path) {
  if (S.live[path]?.diff?.length) return { compact: S.live[path].diff, added: null, round: S.live[path].round };
  return S.diffs[path] ?? null;
}

function updateDiffBadge() {
  const d = S.current ? currentDiff(S.current) : null;
  const n = d ? (d.compact ?? []).filter((x) => x.type !== 'same').length : 0;
  el.diffCount.textContent = n ? String(n) : '';
  el.diffCount.classList.toggle('hidden', n === 0);
  el.viewToggle.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
}

function renderCode() {
  const path = S.current;
  if (!path) {
    el.editorEmpty.classList.remove('hidden');
    el.code.innerHTML = '';
    el.currentPath.textContent = '未选择文件';
    el.fileMeta.textContent = '';
    updateDiffBadge();
    return;
  }
  el.editorEmpty.classList.add('hidden');
  el.currentPath.textContent = path;
  const live = S.live[path];
  el.currentPath.classList.toggle('live-path', Boolean(live));
  scheduleDraw();
}

function drawCode() {
  const path = S.current;
  if (!path) return;
  const lang = (path.split('.').pop() || 'text').toLowerCase();
  const live = S.live[path];
  const content = live ? live.content : S.files[path] ?? '';
  const diff = currentDiff(path);

  if (S.view === 'diff') {
    if (!diff || !(diff.compact ?? []).length) {
      el.code.innerHTML = '<div class="no-diff">本轮没有改动这个文件。<br>按 Ctrl+D 或点上方「代码」看完整内容。</div>';
      el.code.classList.remove('with-lines');
      el.fileMeta.textContent = `${content.split('\n').length} 行`;
      updateDiffBadge();
      return;
    }
    el.code.classList.remove('with-lines');
    el.code.innerHTML = (diff.compact ?? [])
      .map((d) => {
        if (d.type === 'gap') return `<div class="d-same gap">⋯ 折叠 ${d.count} 行未改动</div>`;
        return `<div class="d-${d.type}">${highlightLines(d.text || ' ', lang)[0]}</div>`;
      })
      .join('');
    const ins = (diff.compact ?? []).filter((d) => d.type === 'ins').length;
    const del = (diff.compact ?? []).filter((d) => d.type === 'del').length;
    el.fileMeta.textContent = `本轮差异 +${ins} / -${del}${live ? ' · 正在写入' : ''}`;
    updateDiffBadge();
    return;
  }

  const lines = content.split('\n');
  const added = diff?.added ?? null;
  const showLn = lines.length <= 1500;
  el.code.classList.toggle('with-lines', showLn);
  const html = highlightLines(content, lang);
  el.code.innerHTML = html
    .map((h, i) => {
      const ln = i + 1;
      const mark = added && added.has(ln) ? ' mark-added' : '';
      return `<div class="line${mark}">${showLn ? `<span class="ln">${ln}</span>` : ''}${h || ' '}</div>`;
    })
    .join('');
  const markCount = added ? added.size : 0;
  el.fileMeta.textContent = `${lines.length} 行 · ${content.length} 字符${markCount ? ` · 本轮 +${markCount}` : ''}${live ? ' · 正在写入' : ''}`;
  if (live?.autoscroll) el.codePre.scrollTop = el.codePre.scrollHeight;
  updateDiffBadge();
}

function setView(view) {
  S.view = view;
  LS.set('view', view);
  updateDiffBadge();
  drawCode();
}

async function openFile(path, { autoscroll = false } = {}) {
  S.current = path;
  if (!S.openTabs.includes(path)) S.openTabs.push(path);
  if (S.openTabs.length > 8) S.openTabs.shift();
  if (!S.live[path] && typeof S.files[path] !== 'string') await pullFile(path);
  if (autoscroll && S.live[path]) S.live[path].autoscroll = true;
  renderTabs();
  renderCode();
  updateWorkspaceStats();
  document.querySelectorAll('.tree-item').forEach((r) => r.classList.toggle('selected', r.dataset.path === path));
}

/* ============================ 版本时间线 ============================ */

function renderVersions(payload) {
  if (Array.isArray(payload)) payload = { versions: payload };
  if (payload.versions) S.versions = payload.versions;
  if (payload.activeVersionId) S.activeVersionId = payload.activeVersionId;
  if (typeof payload.canBack === 'boolean') S.canBack = payload.canBack;
  if (typeof payload.canForward === 'boolean') S.canForward = payload.canForward;
  el.btnUndo.disabled = !S.canBack;
  el.btnRedo.disabled = !S.canForward;
  el.timeline.innerHTML = '';
  for (const v of S.versions) {
    const li = document.createElement('li');
    const isActive = v.id === S.activeVersionId;
    const ahead = S.versions.indexOf(v) > S.versions.findIndex((x) => x.id === S.activeVersionId);
    li.className = `timeline-item${isActive ? ' current' : ''}${ahead ? ' reverted' : ''}`;
    const files = (v.files ?? []).length ? ` · ${(v.files ?? []).length} 个文件` : '';
    li.innerHTML = `<b>${esc(v.id)}</b><span>${esc(v.summary || (v.kind === 'baseline' ? '空项目基线' : v.id))}${v.kind === 'baseline' ? '' : esc(files)}</span>`;
    li.title = `提示词：${(v.promptAfter ?? '').slice(0, 120)}`;
    li.addEventListener('click', () => {
      if (isActive) return;
      const idx = S.versions.indexOf(v);
      const cur = S.versions.findIndex((x) => x.id === S.activeVersionId);
      doVersion(idx < cur ? 'back' : 'forward', v.id);
    });
    el.timeline.appendChild(li);
  }
  const cur = S.versions.findIndex((x) => x.id === S.activeVersionId);
  el.versionHint.textContent = S.versions.length > 1 ? ` ${cur}/${S.versions.length - 1}` : '';
  el.versionHint.title = S.canForward ? '你正处于历史版本，可以点 ⏩ 前进回去' : '';
}

/* ============================ 思考与建议流 ============================ */

function streamScroll() {
  el.streamBody.scrollTop = el.streamBody.scrollHeight;
}

function newRound(kind, mode, label) {
  const div = document.createElement('div');
  div.className = `stream-run${kind === 'spec' ? ' spec-run' : ''}`;
  div.dataset.kind = kind;
  div.dataset.mode = mode ?? '';
  const idx = S.rounds.length + 1;
  div.innerHTML =
    `<div class="run-head">` +
    `<span class="run-idx">第 ${idx} 轮</span>` +
    `<span class="run-mode">${esc(label ?? (kind === 'spec' ? '预演' : '生成'))}</span>` +
    `<span class="run-time">${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span>` +
    `<span class="run-files"></span>` +
    `<span class="spacer"></span>` +
    `<span class="run-collapse"></span>` +
    `</div><div class="run-body"></div>`;
  const round = { id: `r${idx}_${Date.now().toString(36)}`, kind, mode, el: div, idx, collapsed: false };
  div.querySelector('.run-head').addEventListener('click', () => toggleRound(round));
  el.streamBody.appendChild(div);
  el.streamBody.querySelector('.empty')?.remove();
  S.rounds.push(round);
  S.currentRound = round;
  // 只有当用户本来就在看最新内容时才自动跟随，否则保持他的阅读位置
  focusRound(round, { scroll: streamNearBottom() });
  updateRoundLabel();
  return round;
}

function toggleRound(round, force) {
  round.collapsed = force ?? !round.collapsed;
  round.el.classList.toggle('collapsed', round.collapsed);
}

function focusRound(round, { scroll = false, flash = false } = {}) {
  S.currentRound = round;
  if (scroll) round.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (flash) {
    round.el.classList.add('anchor-flash');
    setTimeout(() => round.el.classList.remove('anchor-flash'), 1300);
  }
  updateRoundLabel();
}

/** 用户正在往回翻看上下文时，不要强行把他拽到底部。 */
function streamNearBottom() {
  const b = el.streamBody;
  return b.scrollHeight - b.scrollTop - b.clientHeight < 140;
}

function updateRoundLabel() {
  const i = S.rounds.indexOf(S.currentRound);
  el.roundLabel.textContent = S.rounds.length ? `${i + 1}/${S.rounds.length}` : '';
}

function jumpRound(dir) {
  if (!S.rounds.length) return;
  const i = S.rounds.indexOf(S.currentRound);
  const next = Math.max(0, Math.min(S.rounds.length - 1, i + dir));
  focusRound(S.rounds[next], { scroll: true, flash: true });
}

function roundBody() {
  if (!S.currentRound) newRound('run', 'regenerate', '生成');
  return S.currentRound.el.querySelector('.run-body');
}

function appendThink(delta) {
  const body = roundBody();
  let think = body.querySelector('.think.streaming');
  if (!think) {
    think = document.createElement('div');
    think.className = 'think streaming';
    think.innerHTML = '<div class="think-head">思考<span class="think-summary"></span></div><div class="think-body"></div>';
    think.querySelector('.think-head').addEventListener('click', () => {
      if (think.classList.contains('streaming')) return; // 流式中不允许折叠
      think.classList.toggle('collapsed');
    });
    body.appendChild(think);
  }
  think.querySelector('.think-body').insertAdjacentHTML('beforeend', esc(delta).replace(/\n/g, '<br>'));
  streamScroll();
}

function finishThink() {
  const body = S.currentRound?.el.querySelector('.run-body');
  const think = body?.querySelector('.think.streaming');
  if (!think) return;
  think.classList.remove('streaming');
  const text = think.querySelector('.think-body').textContent.replace(/\s+/g, ' ').trim();
  think.querySelector('.think-summary').textContent = text ? `· ${text.slice(0, 46)}${text.length > 46 ? '…' : ''}` : '';
  think.querySelector('.think-head').insertAdjacentHTML('beforeend', `<span class="muted tiny" style="margin-left:auto">${text.length} 字</span>`);
  if (!S.thinkExpandAll) think.classList.add('collapsed');
}

function addOpBlock(op) {
  const body = roundBody();
  const div = document.createElement('div');
  div.className = 'opblock';
  const actionText = { create: '新建', update: '增量修改', rewrite: '整体重写', delete: '删除' }[op.action] ?? op.action;
  div.innerHTML = `<div class="opblock-head"><span class="op">${esc(actionText)}</span><code>${esc(op.path)}</code>${
    op.mode === 'patch' ? `<span class="badge accent">补丁 ×${op.patches || op.patchList?.length || 0}</span>` : ''
  }</div>`;
  div.addEventListener('click', () => openFile(op.path));
  body.appendChild(div);
  streamScroll();
}

function addContextBlock(d) {
  const body = roundBody();
  const div = document.createElement('div');
  div.className = 'opblock';
  div.innerHTML = `<div class="opblock-head"><span class="op">上下文</span> 项目文件 ${d.files} 个 · 检索命中 ${d.ragHits} 段${
    d.skills?.length ? ` · 技能 ${esc(d.skills.join('/'))}` : ''
  } · 约 ${d.chars} 字符</div>`;
  body.appendChild(div);
}

const KIND_TEXT = { clarify: '需求补全', optimize: '优化方向', risk: '风险提示', test: '测试建议', a11y: '可访问性' };
const IMPACT_ORDER = { high: 0, medium: 1, low: 2 };

function addSuggestion(sg, { batch = false } = {}) {
  const round = S.currentRound;
  if (!round) return;
  const body = round.el.querySelector('.run-body');
  let box = body.querySelector('.suggestion-batch');
  if (!box) {
    box = document.createElement('div');
    box.className = 'suggestion-batch';
    box.innerHTML = `<div class="suggestion-batch-head"><span>本轮建议</span><span class="muted">点「采纳」会直接写进你的提示词</span></div>`;
    body.appendChild(box);
  }
  const n = S.suggestions.filter((x) => x.roundId === round.id).length + 1;
  const card = document.createElement('div');
  card.className = `suggestion kind-${sg.kind}`;
  card.innerHTML = `
    <div class="suggestion-head">
      <span class="tag">${esc(KIND_TEXT[sg.kind] ?? sg.kind)}</span>
      <span class="suggestion-title">${esc(sg.title)}</span>
      ${n <= 9 ? `<span class="kbd-hint">Alt+${n}</span>` : ''}
    </div>
    <div class="suggestion-body">${esc(sg.body).replace(/\n/g, '<br>')}</div>
    ${sg.insert ? `<div class="suggestion-insert">将写入提示词：${esc(sg.insert)}</div>` : ''}
    <div class="suggestion-actions">
      <button class="btn primary small act-adopt">采纳并继续</button>
      <button class="btn ghost small act-dismiss">忽略</button>
    </div>`;
  const entry = { sg, roundId: round.id, handled: false, el: card };
  S.suggestions.push(entry);
  card.querySelector('.act-adopt').addEventListener('click', () => adopt(entry));
  card.querySelector('.act-dismiss').addEventListener('click', async () => {
    entry.handled = true;
    card.classList.add('adopted');
    card.querySelector('.suggestion-actions').innerHTML = '<span class="muted">已忽略（会进入习惯记忆）</span>';
    updateUnread();
    await post('/api/dismiss', { suggestion: sg }).catch(() => {});
  });
  box.appendChild(card);
  if (!round.collapsed) streamScroll();
  updateUnread();
}

async function adopt(entry) {
  if (entry.handled) return;
  try {
    const res = await post('/api/adopt', { suggestion: entry.sg });
    if (res.prompt !== undefined) {
      el.prompt.value = res.prompt;
      updateCounter();
    }
    entry.handled = true;
    entry.el.classList.add('adopted');
    entry.el.querySelector('.suggestion-actions').innerHTML = '<span class="muted">已写入提示词 ✓</span>';
    updateUnread();
    setStatus('gen', '正在按新提示词增量生成…', '建议已并入提示词');
  } catch (err) {
    toast(`采纳失败：${err.message}`, 'err');
  }
}

function updateUnread() {
  S.unread = S.suggestions.filter((x) => !x.handled).length;
  el.unreadBadge.textContent = String(S.unread);
  el.unreadBadge.classList.toggle('hidden', S.unread === 0);
}

/* ============================ 意图与运行状态 ============================ */

function renderIntent(intent, decision) {
  if (!intent) return;
  const pct = Math.round((intent.score ?? 0) * 100);
  el.intentFill.style.width = `${pct}%`;
  el.intentFill.classList.remove('low', 'mid', 'high');
  el.intentFill.classList.add(pct >= 60 ? 'high' : pct >= 40 ? 'mid' : 'low');
  el.intentText.textContent = intent.complete ? `意图判定：已写完（${pct}%）` : `意图判定：还在写（${pct}%）`;
  el.decisionText.textContent = decision?.mode
    ? `策略：${MODE_TEXT[decision.mode] ?? decision.mode}${decision.ratio ? ` · 变动 ${(decision.ratio * 100).toFixed(0)}%` : ''}`
    : '';
  if (!S.busy) setStatus('typing', '输入中…', (intent.reasons ?? []).slice(0, 1).join(''));
}

const MODE_TEXT = { regenerate: '全新生成', continue: '增量续写', incremental: '定点增量补丁', noop: '忽略微小改动' };

function setRunBadge(status) {
  const map = {
    idle: ['空闲', 'idle'],
    speculating: ['预演中…', 'warn'],
    generating: ['正在生成…', 'accent'],
    applying: ['正在写入…', 'accent'],
    error: ['出错了', 'err'],
  };
  const [text, cls] = map[status] ?? ['运行中', 'accent'];
  el.runBadge.textContent = text;
  el.runBadge.className = `badge ${cls}`;
}

/* ============================ 输入 ============================ */

let lastInputAt = 0;
let lastSentAt = 0;
let trailing = null;
let localSeq = 0;

function updateCounter() {
  el.counter.textContent = `${el.prompt.value.length} 字`;
}

function sendInput(force = false) {
  const now = Date.now();
  const idleMs = now - lastInputAt;
  if (!force && now - lastSentAt < 300) {
    if (trailing) clearTimeout(trailing);
    trailing = setTimeout(() => sendInput(true), 300 - (now - lastSentAt));
    return;
  }
  lastSentAt = now;
  const seq = ++localSeq;
  post('/api/input', { text: el.prompt.value, idleMs }).catch((err) => {
    if (seq === localSeq) toast(`上报输入失败：${err.message}`, 'err');
  });
}

el.prompt.addEventListener('input', () => {
  lastInputAt = Date.now();
  updateCounter();
  sendInput();
  const t = el.prompt.value.trim();
  if (t) setStatus('typing', '输入中…', '等你停下来我就开始预演');
});

/* ============================ SSE ============================ */

function renderProviderBadge() {
  const p = S.provider;
  if (!p) {
    el.providerBadge.textContent = '模型加载中…';
    el.providerBadge.className = 'badge';
    return;
  }
  el.providerBadge.textContent = `${p.label ?? p.name ?? '模型'}${p.ready ? '' : ' · 未就绪'}`;
  el.providerBadge.className = `badge ${p.ready ? 'ok' : 'err'}`;
  el.providerBadge.title = p.note ?? '';
}

function on(name, fn) {
  window.addEventListener(`sf:${name}`, (e) => fn(e.detail));
}

function connect() {
  const es = new EventSource('/api/events');
  const names = [
    'hello', 'state', 'intent', 'queued', 'run:start', 'run:context', 'think:start', 'think:delta', 'think:end',
    'suggest', 'suggest:adopted', 'file:start', 'file:delta', 'file:end', 'run:text', 'retry',
    'run:applied', 'run:done', 'run:error', 'run:cancelled', 'spec:done', 'run:promoted', 'tree', 'versions',
    'prompt', 'toast', 'rollback', 'file:saved',
  ];
  for (const n of names) {
    es.addEventListener(n, (ev) => {
      let detail = null;
      try {
        detail = JSON.parse(ev.data);
      } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent(`sf:${n}`, { detail }));
    });
  }
  es.onerror = () => {
    el.providerBadge.textContent = '连接中断，重连中…';
    el.providerBadge.className = 'badge warn';
  };
  es.onopen = () => renderProviderBadge();
}

/* ============================ 事件处理 ============================ */

on('hello', () => setStatus('idle', '已连接', ''));

on('state', (st) => {
  if (!st) return;
  S.provider = st.provider;
  S.busy = st.busy;
  renderProviderBadge();
  setRunBadge(st.session?.status ?? 'idle');
  if (st.versions) renderVersions(st.versions);
  if (st.memory?.chips) renderChips(st.memory.chips);
  // 用量以服务端为准，不要在这里做本地累加：否则每个 state 事件都会把本地计数覆盖掉
  const stats = st.session?.stats;
  if (stats) {
    if (typeof stats.modelCalls === 'number') S.usage.calls = stats.modelCalls;
    if (typeof stats.estTokens === 'number') S.usage.tokens = stats.estTokens;
  }
  renderUsage();
  if (st.config) window.__sfConfig = st.config;
  if (st.presets) window.__sfPresets = st.presets;
  // 刚跑完的"已写入 N 个文件"要让用户看得见，别被紧随其后的 state 立刻覆盖成"空闲"
  const keepDone = S.statusKind === 'done' && Date.now() - S.statusAt < 6000;
  if (!st.busy && !keepDone) setStatus('idle', '空闲', `${st.workspace?.files ?? 0} 个文件`);
});

on('intent', (d) => renderIntent(d.intent, d.decision));

on('queued', (d) => {
  setStatus('busy', '生成中…', d.reason ?? '');
});

on('run:start', (d) => {
  S.busy = true;
  setRunBadge(d.kind === 'spec' ? 'speculating' : 'generating');
  const label = d.kind === 'spec' ? '预演' : MODE_TEXT[d.mode] ?? '生成';
  S.diffs = {}; // 新一轮 → 「本轮差异」重新开始计
  newRound(d.kind, d.mode, label);
  setStatus(d.kind === 'spec' ? 'spec' : 'gen', d.kind === 'spec' ? '预演中（你还在打字）…' : '正在生成…', '');
});

on('run:context', (d) => d && addContextBlock(d));

on('think:start', () => {});
on('think:delta', (d) => appendThink(d.delta));
on('think:end', () => finishThink());

on('suggest', (d) => addSuggestion(d.suggestion, { batch: d.batch }));

on('file:start', (d) => {
  S.live[d.path] = { content: '', diff: null, action: d.action, lang: d.lang, autoscroll: true, round: S.currentRound?.id };
  addOpBlock({ path: d.path, action: d.action, mode: d.action === 'update' ? 'patch' : 'create', patches: 0 });
  openFile(d.path, { autoscroll: true });
  renderTree(S.tree);
});

on('file:delta', (d) => {
  const entry = S.live[d.path];
  if (!entry) return;
  entry.content += d.delta;
  if (S.current === d.path) scheduleDraw();
});

on('file:end', (d) => {
  const op = d.op;
  const entry = S.live[op.path];
  if (entry) {
    entry.action = op.action;
    if (op.mode === 'patch' && op.patchList) {
      entry.diff = [];
      for (const p of op.patchList) {
        for (const line of p.search.split('\n')) entry.diff.push({ type: 'del', text: line });
        for (const line of p.replace.split('\n')) entry.diff.push({ type: 'ins', text: line });
      }
    } else if (typeof op.content === 'string') {
      entry.content = op.content;
      entry.diff = null;
    }
  }
  if (S.current === op.path) {
    renderCode();
  }
});

on('run:text', (d) => {
  const body = roundBody();
  let pre = body.querySelector('.stray');
  if (!pre) {
    pre = document.createElement('pre');
    pre.className = 'stray';
    body.appendChild(pre);
  }
  pre.textContent += d.delta;
  streamScroll();
});

on('retry', (d) => {
  setStatus('retry', '补丁未命中，正在自动重试…', (d.files ?? []).join(', '));
  toast(`补丁未命中：${(d.files ?? []).join(', ')} — 正在自动重试一次`, 'warn', 5200);
});

on('run:applied', async (d) => {
  for (const r of d.results ?? []) {
    if (r.ok) {
      await pullFile(r.path);
      if (r.compact?.length || r.addedLines?.length) {
        S.diffs[r.path] = {
          compact: r.compact ?? [],
          added: new Set(r.addedLines ?? []),
          round: S.currentRound?.id,
        };
      }
    }
    delete S.live[r.path];
  }
  renderTree(S.tree);
  if (S.current) renderCode();
  updateWorkspaceStats();
  const bad = (d.results ?? []).filter((r) => !r.ok);
  for (const b of bad) toast(`补丁未命中：${b.path} — ${b.error}`, 'warn', 6000);
});

on('run:done', (d) => {
  S.busy = false;
  setRunBadge('idle');
  const round = S.currentRound;
  if (round) {
    round.el.dataset.mode = d.mode ?? round.mode;
    const modeEl = round.el.querySelector('.run-mode');
    if (modeEl) modeEl.textContent = MODE_TEXT[d.mode] ?? (round.kind === 'spec' ? '预演' : '生成');
    const filesEl = round.el.querySelector('.run-files');
    if (filesEl) filesEl.textContent = `${d.files?.length ?? 0} 个文件 · ${d.ms}ms`;
    const done = document.createElement('div');
    done.className = 'opblock';
    done.innerHTML = `<div class="opblock-head"><span class="op">完成</span> ${esc(MODE_TEXT[d.mode] ?? '生成')} · ${d.files?.length ?? 0} 个文件${
      d.versionId ? ` · 版本 ${esc(d.versionId)}` : ''
    }</div>`;
    round.el.querySelector('.run-body')?.appendChild(done);
    streamScroll();
  }
  if (d.usage) {
    S.usage.last = d.usage.tokens ?? 0;
    // 计数由随后的 state 事件用服务端 stats 校准，这里不自行累加（避免双重计数）
    renderUsage();
  }
  setStatus('done', `已写入 ${d.files?.length ?? 0} 个文件`, `${d.ms}ms · 版本 ${d.versionId ?? '-'}`);
});

on('run:promoted', (d) => setStatus('gen', '采纳预演结果', d.reason ?? ''));

on('spec:done', (d) => {
  S.busy = false;
  if (d?.files?.length) setStatus('idle', '预演就绪', `${d.files.length} 个文件待落盘`);
});

on('run:cancelled', () => {
  S.busy = false;
  setRunBadge('idle');
  setStatus('idle', '已停止生成', '');
});

on('run:error', (d) => {
  S.busy = false;
  setRunBadge('error');
  setStatus('err', '出错了', d.message ?? '');
  toast(d.message, 'err', 9000);
});

on('tree', (d) => {
  renderTree(d.tree);
  if (!S.current) {
    const first = (d.tree?.children ?? []).flatMap(function walk(n) {
      return n.type === 'file' ? [n.path] : (n.children ?? []).flatMap(walk);
    })[0];
    if (first) openFile(first);
  }
});

on('versions', (d) => renderVersions(d));

on('prompt', (d) => {
  el.prompt.value = d.text ?? '';
  updateCounter();
});

on('rollback', (d) => {
  el.prompt.value = d.prompt ?? '';
  updateCounter();
  S.live = {};
  S.diffs = {};
  setStatus('done', d.direction === 'forward' ? '已前进' : '已回退', `当前 ${d.activeVersionId} · 恢复 ${d.files?.length ?? 0} 个文件`);
  (async () => {
    const tree = await get('/api/tree');
    renderTree(tree.tree);
    for (const p of Object.keys(S.files)) await pullFile(p);
    for (const rel of tree.files ?? []) if (typeof S.files[rel] !== 'string') await pullFile(rel);
    updateWorkspaceStats();
    if (S.current) renderCode();
  })();
});

on('file:saved', (d) => setStatus('done', `已保存 ${d.path}`, ''));
on('toast', (d) => toast(d.message, d.level ?? 'ok'));

/* ============================ 主题 ============================ */

function applyTheme(mode = S.theme) {
  S.theme = mode;
  LS.set('theme', mode);
  const resolved = mode === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode;
  document.documentElement.dataset.theme = resolved;
  el.btnTheme.textContent = mode === 'system' ? '🌗' : mode === 'light' ? '☀️' : '🌙';
  el.btnTheme.title = `主题：${mode === 'system' ? '跟随系统' : mode === 'light' ? '亮色' : '暗色'}（点击切换）`;
}

el.btnTheme.addEventListener('click', () => {
  const order = ['system', 'light', 'dark'];
  applyTheme(order[(order.indexOf(S.theme) + 1) % order.length]);
});
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (S.theme === 'system') applyTheme('system');
});

/* ============================ 快捷键 ============================ */

document.addEventListener('keydown', (e) => {
  const meta = e.altKey || e.ctrlKey;
  if (meta && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    doVersion('back');
    return;
  }
  if (meta && e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    doVersion('forward');
    return;
  }
  if (e.altKey && e.key === 'Enter') {
    e.preventDefault();
    el.btnCommit.click();
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    setView(S.view === 'code' ? 'diff' : 'code');
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    openPalette();
    return;
  }
  if (e.key === 'Escape') {
    if (!el.palette.classList.contains('hidden')) return closePalette();
    if (!el.helpModal.classList.contains('hidden')) return el.helpModal.classList.add('hidden');
    if (!el.modal.classList.contains('hidden')) return el.modal.classList.add('hidden');
    if (S.busy) {
      e.preventDefault();
      post('/api/cancel').catch(() => {});
    }
    return;
  }
  if (e.altKey && /^[1-9]$/.test(e.key)) {
    const n = Number(e.key);
    const pending = S.suggestions.filter((x) => !x.handled);
    const target = pending[n - 1];
    if (target) {
      e.preventDefault();
      target.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      adopt(target);
    }
  }
});

/* ============================ 命令面板 ============================ */

let paletteItems = [];
let paletteIndex = 0;

function openPalette() {
  const files = Object.keys(S.files).length ? Object.keys(S.files) : (S.tree ? flattenFiles(S.tree) : []);
  if (!files.length) {
    toast('还没有文件可以跳转', 'warn', 2000);
    return;
  }
  el.palette.classList.remove('hidden');
  el.paletteInput.value = '';
  paletteIndex = 0;
  renderPalette(files);
  el.paletteInput.focus();
}

function flattenFiles(node) {
  return (node.children ?? []).flatMap((c) => (c.type === 'file' ? [c.path] : flattenFiles(c)));
}

function closePalette() {
  el.palette.classList.add('hidden');
}

function renderPalette(files) {
  const q = el.paletteInput.value.trim().toLowerCase();
  paletteItems = files
    .filter((f) => !q || f.toLowerCase().includes(q))
    .sort((a, b) => {
      const ai = a.toLowerCase().indexOf(q);
      const bi = b.toLowerCase().indexOf(q);
      return ai === bi ? a.length - b.length : ai - bi;
    })
    .slice(0, 40);
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
  el.paletteList.innerHTML = paletteItems
    .map((p, i) => {
      const dir = p.split('/').slice(0, -1).join('/');
      return `<li class="palette-item${i === paletteIndex ? ' active' : ''}" data-path="${esc(p)}">${
        dir ? `<span class="p-dir">${esc(dir)}/</span>` : ''
      }<span>${esc(p.split('/').pop())}</span></li>`;
    })
    .join('');
  el.paletteList.querySelectorAll('.palette-item').forEach((li) => {
    li.addEventListener('click', () => {
      openFile(li.dataset.path);
      closePalette();
    });
  });
}

el.paletteInput.addEventListener('input', () => {
  paletteIndex = 0;
  renderPalette(paletteItems.length ? [...paletteItems, ...Object.keys(S.files)] : Object.keys(S.files));
});
el.paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1);
    renderPalette(paletteItems);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteIndex = Math.max(0, paletteIndex - 1);
    renderPalette(paletteItems);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const pick = paletteItems[paletteIndex];
    if (pick) {
      openFile(pick);
      closePalette();
    }
  }
});
el.palette.addEventListener('click', (e) => {
  if (e.target === el.palette) closePalette();
});

/* ============================ 设置面板 ============================ */

function fillSettings(config, presets) {
  const sel = $('#cfg-provider');
  sel.innerHTML = '';
  for (const [key, p] of Object.entries(presets ?? {})) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${p.label}${p.model ? ` (${p.model})` : ''}`;
    sel.appendChild(opt);
  }
  sel.value = config.provider ?? '';
  $('#cfg-model').value = config.model ?? '';
  $('#cfg-baseUrl').value = config.baseUrl ?? '';
  $('#cfg-apiKey').value = '';
  $('#cfg-apiKey').placeholder = config.apiKeySet ? '已保存（留空则不修改）' : 'sk-...';
  $('#cfg-specDelayMs').value = config.specDelayMs ?? 1000;
  $('#cfg-commitIdleMs').value = config.commitIdleMs ?? 900;
  $('#cfg-settleMs').value = config.settleMs ?? 1600;
  $('#cfg-intentThreshold').value = config.intentThreshold ?? 0.6;
  $('#cfg-autoCommit').checked = config.autoCommit !== false;
  $('#cfg-autoAdoptHigh').checked = Boolean(config.autoAdoptHigh);
  $('#cfg-patchRetry').checked = config.patchRetry !== false;
}

$('#cfg-provider')?.addEventListener('change', (e) => {
  const p = window.__sfPresets?.[e.target.value];
  if (!p) return;
  if (p.baseUrl) $('#cfg-baseUrl').value = p.baseUrl;
  if (p.model) $('#cfg-model').value = p.model;
});

el.btnSettings.addEventListener('click', async () => {
  try {
    const st = await get('/api/state');
    fillSettings(st.config ?? window.__sfConfig ?? {}, st.presets ?? window.__sfPresets);
    el.modal.classList.remove('hidden');
  } catch (err) {
    toast(`读取设置失败：${err.message}`, 'err');
  }
});
$('#cfg-close').addEventListener('click', () => el.modal.classList.add('hidden'));
el.modal.addEventListener('click', (e) => {
  if (e.target === el.modal) el.modal.classList.add('hidden');
});
$('#cfg-save').addEventListener('click', async () => {
  const payload = {
    provider: $('#cfg-provider').value,
    model: $('#cfg-model').value.trim(),
    baseUrl: $('#cfg-baseUrl').value.trim(),
    specDelayMs: Number($('#cfg-specDelayMs').value),
    commitIdleMs: Number($('#cfg-commitIdleMs').value),
    settleMs: Number($('#cfg-settleMs').value),
    intentThreshold: Number($('#cfg-intentThreshold').value),
    autoCommit: $('#cfg-autoCommit').checked,
    autoAdoptHigh: $('#cfg-autoAdoptHigh').checked,
    patchRetry: $('#cfg-patchRetry').checked,
  };
  const key = $('#cfg-apiKey').value.trim();
  if (key) payload.apiKey = key;
  try {
    const res = await post('/api/config', payload);
    setStatus('done', '设置已保存', res.provider?.ready ? '模型就绪' : res.provider?.note ?? '');
    el.modal.classList.add('hidden');
    if (!res.provider?.ready) toast(`模型未就绪：${res.provider?.note}`, 'warn', 7000);
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
});

/* ============================ 快捷片段 ============================ */

function renderChips(chips) {
  el.chips.innerHTML = '';
  const base = (chips ?? []).slice(0, 6);
  const defaults = [
    { text: '用中文注释', count: 0 },
    { text: '加错误处理', count: 0 },
    { text: '拆成组件', count: 0 },
    { text: '补单元测试', count: 0 },
  ];
  const list = base.length >= 3 ? base : [...base, ...defaults].slice(0, 6);
  for (const c of list) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = c.count ? `${c.text} ×${c.count}` : c.text;
    btn.title = '追加到提示词';
    btn.addEventListener('click', () => {
      el.prompt.value = `${el.prompt.value.trimEnd()}${el.prompt.value.trim() ? '\n' : ''}${c.text}`;
      updateCounter();
      lastInputAt = Date.now();
      sendInput(true);
      el.prompt.focus();
    });
    el.chips.appendChild(btn);
  }
}

/* ============================ 工具栏动作 ============================ */

async function doVersion(direction, versionId) {
  try {
    const res = await post('/api/rollback', { direction, versionId });
    if (!res.ok) toast(res.error ?? '无法切换版本', 'warn', 4000);
  } catch (err) {
    toast(`版本切换失败：${err.message}`, 'err');
  }
}

el.btnUndo.addEventListener('click', () => doVersion('back'));
el.btnRedo.addEventListener('click', () => doVersion('forward'));

el.viewToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (btn) setView(btn.dataset.view);
});

el.btnCommit.addEventListener('click', async () => {
  try {
    const res = await post('/api/commit', { reason: 'manual' });
    if (!res.ok) toast(res.error ?? '启动失败', 'warn', 3000);
  } catch (err) {
    toast(`启动失败：${err.message}`, 'err');
  }
});
el.btnCancel.addEventListener('click', () => post('/api/cancel').catch(() => {}));
el.btnRegenerate.addEventListener('click', async () => {
  try {
    const res = await post('/api/commit', { reason: 'force', force: true });
    if (!res.ok) toast(res.error ?? '启动失败', 'warn', 3000);
  } catch (err) {
    toast(`启动失败：${err.message}`, 'err');
  }
});
el.btnSave.addEventListener('click', async () => {
  if (!S.current) {
    toast('先选一个文件', 'warn', 1600);
    return;
  }
  try {
    await post('/api/save', { path: S.current, content: S.files[S.current] ?? '' });
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
});

el.btnThinkMode.addEventListener('click', () => {
  S.thinkExpandAll = !S.thinkExpandAll;
  LS.set('thinkExpand', S.thinkExpandAll);
  el.btnThinkMode.textContent = `思考：${S.thinkExpandAll ? '展开' : '折叠'}`;
  document.querySelectorAll('.think:not(.streaming)').forEach((t) => t.classList.toggle('collapsed', !S.thinkExpandAll));
});
el.btnRoundPrev.addEventListener('click', () => jumpRound(-1));
el.btnRoundNext.addEventListener('click', () => jumpRound(1));
el.btnHelp.addEventListener('click', () => el.helpModal.classList.remove('hidden'));
$('#help-close').addEventListener('click', () => el.helpModal.classList.add('hidden'));
el.helpModal.addEventListener('click', (e) => {
  if (e.target === el.helpModal) el.helpModal.classList.add('hidden');
});

/* ============================ 启动 ============================ */

(async function boot() {
  applyTheme(S.theme);
  S.view = LS.get('view', 'code');
  el.btnThinkMode.textContent = `思考：${S.thinkExpandAll ? '展开' : '折叠'}`;
  connect();
  updateCounter();
  renderUsage();
  setStatus('idle', '正在连接…', '');
  try {
    const st = await get('/api/state');
    S.provider = st.provider;
    window.__sfPresets = st.presets;
    window.__sfConfig = st.config;
    renderProviderBadge();
    if (st.memory?.chips) renderChips(st.memory.chips);
    if (st.versions) renderVersions(st.versions);
    const tree = await get('/api/tree');
    for (const rel of tree.files ?? []) await pullFile(rel);
    renderTree(tree.tree);
    updateWorkspaceStats();
    if (st.session?.prompt) {
      el.prompt.value = st.session.prompt;
      updateCounter();
    }
    if (tree.files?.length) openFile(st.workspace?.recent?.[0] ?? tree.files[0]);
    setStatus('idle', '就绪', `${tree.files?.length ?? 0} 个文件 · 版本 ${st.session?.currentVersionId ?? 'v0'}`);
    if (st.provider && !st.provider.ready) {
      toast(`模型未就绪：${st.provider.note} — 右上角「设置」里填写 API Key`, 'warn', 9000);
    }
  } catch (err) {
    setStatus('err', '初始化失败', err.message);
    toast(`初始化失败：${err.message}`, 'err', 9000);
  }
})();
