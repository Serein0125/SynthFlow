// SynthFlow 前端：SSE 驱动的实时工作台。
// 关键点：输入不"发送"，只持续上报；服务端负责预演/意图判定/落盘，前端只负责呈现与干预。

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const el = {
  providerBadge: $('#provider-badge'),
  runBadge: $('#run-badge'),
  draftBadge: $('#draft-badge'),
  btnRollback: $('#btn-rollback'),
  btnRegenerate: $('#btn-regenerate'),
  btnSettings: $('#btn-settings'),
  wsStats: $('#ws-stats'),
  fileTree: $('#file-tree'),
  timeline: $('#timeline'),
  tabs: $('#tabs'),
  currentPath: $('#current-path'),
  fileMeta: $('#file-meta'),
  btnSave: $('#btn-save'),
  code: $('#code'),
  codePre: $('#code-pre'),
  editorEmpty: $('#editor-empty'),
  diffStrip: $('#diff-strip'),
  streamBody: $('#stream-body'),
  streamMode: $('#stream-mode'),
  intentFill: $('#intent-fill'),
  intentText: $('#intent-text'),
  decisionText: $('#decision-text'),
  prompt: $('#prompt'),
  btnCommit: $('#btn-commit'),
  btnCancel: $('#btn-cancel'),
  chips: $('#chips'),
  hint: $('#hint'),
  counter: $('#counter'),
  toasts: $('#toasts'),
  modal: $('#settings-modal'),
};

const S = {
  files: {},          // 已落盘文件内容缓存
  live: {},           // 生成中文件的实时缓冲
  openTabs: [],
  current: null,
  tree: null,
  versions: [],
  draft: null,
  suggestions: [],
  busy: false,
  runKind: null,
  provider: null,
  memory: null,
  lastIntent: null,
  charCount: 0,
};

/* ============================ 工具函数 ============================ */

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function toast(message, level = 'ok', ms = 4200) {
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
  if (lang === 'html' || lang === 'xml' || lang === 'svg' || lang === 'vue') {
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
      R('tok-punc', /[{}\[\]:,]/y),
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

function highlight(code, lang) {
  const rules = rulesFor(lang);
  const out = [];
  let i = 0;
  const n = code.length;
  let plain = '';
  const flush = () => {
    if (plain) {
      out.push(esc(plain));
      plain = '';
    }
  };
  let guard = 0;
  while (i < n && guard++ < 400000) {
    let matched = false;
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(code);
      if (m && m.index === i && m[0].length > 0) {
        flush();
        out.push(`<span class="${r.name}">${esc(m[0])}</span>`);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      plain += code[i];
      i += 1;
      if (plain.length > 512) flush();
    }
  }
  flush();
  return out.join('');
}

/* ============================ 渲染：文件树 ============================ */

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
        const live = S.live[child.path] ? '<span class="dot"></span>' : '';
        row.innerHTML = `<span class="name">${esc(child.name)}</span>${live}`;
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
  const bytes = Object.values(S.files).reduce((a, c) => a + c.length, 0);
  el.wsStats.textContent = count ? ` ${count} 个 · ${(bytes / 1024).toFixed(1)} KB` : '';
}

/* ============================ 渲染：标签页 ============================ */

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

/* ============================ 渲染：代码区 ============================ */

let rafPending = false;
function scheduleHighlight() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    drawCode();
  });
}

let lastRendered = { path: null, content: '', diff: null };

function renderCode() {
  const path = S.current;
  if (!path) {
    el.editorEmpty.classList.remove('hidden');
    el.code.innerHTML = '';
    el.currentPath.textContent = '未选择文件';
    el.fileMeta.textContent = '';
    return;
  }
  el.editorEmpty.classList.add('hidden');
  el.currentPath.textContent = path;
  const liveEntry = S.live[path];
  const content = liveEntry ? liveEntry.content : S.files[path] ?? '';
  lastRendered = { path, content, diff: liveEntry?.diff ?? null };
  scheduleHighlight();
}

function drawCode() {
  const { path, content, diff } = lastRendered;
  if (!path) return;
  const lang = (path.split('.').pop() || 'text').toLowerCase();
  if (diff && diff.length) {
    el.code.innerHTML = diff
      .map((d) => `<div class="d-${d.type === 'ins' ? 'ins' : d.type === 'del' ? 'del' : 'same'}">${highlight(d.text || ' ', lang)}</div>`)
      .join('');
  } else {
    el.code.innerHTML = highlight(content, lang);
  }
  el.fileMeta.textContent = `${content.split('\n').length} 行 · ${content.length} 字符${S.live[path] ? ' · 正在写入' : ''}`;
  if (S.live[path]?.autoscroll) el.codePre.scrollTop = el.codePre.scrollHeight;
}

async function openFile(path, { autoscroll = false } = {}) {
  S.current = path;
  if (!S.openTabs.includes(path)) S.openTabs.push(path);
  if (S.openTabs.length > 8) S.openTabs.shift();
  if (!S.live[path] && !(path in S.files)) {
    try {
      const f = await get(`/api/file?path=${encodeURIComponent(path)}`);
      S.files[path] = f.content;
    } catch {
      S.files[path] = '';
    }
  }
  if (autoscroll && S.live[path]) S.live[path].autoscroll = true;
  renderTabs();
  renderCode();
  updateWorkspaceStats();
  $$('.tree-item').forEach((r) => r.classList.toggle('selected', r.dataset.path === path));
}

function showDiffStrip(diff, title) {
  if (!diff || !diff.length) {
    el.diffStrip.classList.add('hidden');
    return;
  }
  const ins = diff.filter((d) => d.type === 'ins').length;
  const del = diff.filter((d) => d.type === 'del').length;
  if (ins === 0 && del === 0) {
    el.diffStrip.classList.add('hidden');
    return;
  }
  el.diffStrip.classList.remove('hidden');
  el.diffStrip.innerHTML =
    `<div class="line muted">${esc(title)}　+${ins} / -${del}</div>` +
    diff
      .filter((d) => d.type !== 'same')
      .slice(0, 80)
      .map((d) => `<div class="d-${d.type}">${esc(d.text || ' ')}</div>`)
      .join('') +
    `<div class="line"><button class="btn ghost small strip-close">收起差异</button></div>`;
  el.diffStrip.querySelector('.strip-close').addEventListener('click', () => el.diffStrip.classList.add('hidden'));
}

/* ============================ 渲染：版本时间线 ============================ */

function renderVersions(versions, current) {
  S.versions = versions ?? S.versions;
  el.timeline.innerHTML = '';
  for (const v of S.versions) {
    const li = document.createElement('li');
    li.className = `timeline-item${v.id === current ? ' current' : ''}`;
    const files = (v.files ?? []).length ? `${(v.files ?? []).length} 个文件` : '';
    li.innerHTML = `<b>${esc(v.id)}</b><span>${esc(v.summary || (v.kind === 'baseline' ? '空项目基线' : v.id))}${files && v.kind !== 'baseline' ? ` · ${esc(files)}` : ''}</span>`;
    if (v.kind !== 'baseline' && v.id === current) {
      const actions = document.createElement('div');
      actions.className = 'timeline-actions';
      const btn = document.createElement('button');
      btn.className = 'btn ghost small';
      btn.textContent = '⏪ 回退到此前';
      btn.title = '回到这句话还没输入时的版本';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        doRollback(v.id);
      });
      actions.appendChild(btn);
      li.appendChild(actions);
    }
    el.timeline.appendChild(li);
  }
}

/* ============================ 渲染：思考与建议流 ============================ */

let currentThink = null;
let currentRunBlock = null;

function streamScroll() {
  el.streamBody.scrollTop = el.streamBody.scrollHeight;
}

function ensureRunBlock(kind) {
  if (currentRunBlock && currentRunBlock.dataset.kind === kind) return currentRunBlock;
  const div = document.createElement('div');
  div.className = 'stream-run';
  div.dataset.kind = kind;
  const head = document.createElement('div');
  head.className = 'run-head';
  head.textContent = kind === 'spec' ? '预演 · 你还在打字' : '本轮生成';
  div.appendChild(head);
  el.streamBody.appendChild(div);
  const empty = el.streamBody.querySelector('.empty');
  if (empty) empty.remove();
  currentRunBlock = div;
  streamScroll();
  return div;
}

function appendThink(delta) {
  const block = ensureRunBlock(S.runKind ?? 'run');
  if (!currentThink) {
    currentThink = document.createElement('div');
    currentThink.className = 'think';
    currentThink.innerHTML = '<div class="think-head">思考</div><div class="think-body"></div>';
    block.appendChild(currentThink);
  }
  currentThink.querySelector('.think-body').insertAdjacentHTML('beforeend', esc(delta).replace(/\n/g, '<br>'));
  streamScroll();
}

function addOpBlock(op) {
  const block = ensureRunBlock(S.runKind ?? 'run');
  const div = document.createElement('div');
  div.className = 'opblock';
  const actionText = { create: '新建', update: '增量修改', rewrite: '整体重写', delete: '删除' }[op.action] ?? op.action;
  div.innerHTML = `<div class="opblock-head"><span class="op">${esc(actionText)}</span><code>${esc(op.path)}</code>${
    op.mode === 'patch' ? `<span class="badge accent">补丁 ×${op.patches || op.patchList?.length || 0}</span>` : ''
  }</div>`;
  div.addEventListener('click', () => openFile(op.path));
  block.appendChild(div);
  streamScroll();
}

function addSuggestion(sg) {
  S.suggestions.push(sg);
  const kindText = { clarify: '需求补全', optimize: '优化方向', risk: '风险提示', test: '测试建议', a11y: '可访问性' }[sg.kind] ?? sg.kind;
  const block = ensureRunBlock(S.runKind ?? 'run');
  const card = document.createElement('div');
  card.className = `suggestion kind-${sg.kind}`;
  card.innerHTML = `
    <div class="suggestion-head">
      <span class="tag">${esc(kindText)}</span>
      <span class="suggestion-title">${esc(sg.title)}</span>
    </div>
    <div class="suggestion-body">${esc(sg.body).replace(/\n/g, '<br>')}</div>
    ${sg.insert ? `<div class="suggestion-insert">将写入提示词：${esc(sg.insert)}</div>` : ''}
    <div class="suggestion-actions">
      <button class="btn primary small act-adopt">采纳并继续</button>
      <button class="btn ghost small act-dismiss">忽略</button>
    </div>`;
  card.querySelector('.act-adopt').addEventListener('click', async () => {
    try {
      const res = await post('/api/adopt', { suggestion: sg });
      if (res.prompt !== undefined) el.prompt.value = res.prompt;
      updateCounter();
      card.classList.add('adopted');
      card.querySelector('.suggestion-actions').innerHTML = '<span class="muted">已写入提示词 ✓</span>';
      toast('建议已并入提示词，正在按新提示词增量生成…', 'ok');
    } catch (err) {
      toast(`采纳失败：${err.message}`, 'err');
    }
  });
  card.querySelector('.act-dismiss').addEventListener('click', async () => {
    card.classList.add('adopted');
    card.querySelector('.suggestion-actions').innerHTML = '<span class="muted">已忽略（会进入习惯记忆）</span>';
    await post('/api/dismiss', { suggestion: sg }).catch(() => {});
  });
  block.appendChild(card);
  streamScroll();
}

function resetStreamLive() {
  currentThink = null;
}

/* ============================ 意图与决策展示 ============================ */

function renderIntent(intent, decision) {
  if (!intent) return;
  const pct = Math.round((intent.score ?? 0) * 100);
  el.intentFill.style.width = `${pct}%`;
  el.intentFill.classList.remove('low', 'mid', 'high');
  el.intentFill.classList.add(pct >= 60 ? 'high' : pct >= 40 ? 'mid' : 'low');
  const reasons = (intent.reasons ?? []).slice(0, 2).join('；');
  el.intentText.textContent = intent.complete ? `意图判定：已写完（${pct}%）` : `意图判定：还在写（${pct}%）`;
  if (decision) {
    const modeText = { regenerate: '全新生成', continue: '增量续写', incremental: '定点增量补丁', noop: '忽略微小改动' }[decision.mode] ?? decision.mode;
    el.decisionText.textContent = `策略：${modeText}${decision.ratio ? ` · 变动 ${(decision.ratio * 100).toFixed(0)}%` : ''}${reasons ? ` · ${reasons}` : ''}`;
  }
}

function setRunBadge(status, kind) {
  const map = {
    idle: ['空闲', 'idle'],
    speculating: ['预演生成中…', 'warn'],
    generating: ['正在生成…', 'accent'],
    applying: ['正在写入文件…', 'accent'],
    error: ['出错了', 'err'],
  };
  const [text, cls] = map[status] ?? ['运行中', 'accent'];
  el.runBadge.textContent = kind ? `${text}` : text;
  el.runBadge.className = `badge ${cls}`;
}

/* ============================ 输入处理 ============================ */

let lastInputAt = 0;
let lastSentAt = 0;
let trailing = null;
let localSeq = 0;

function updateCounter() {
  const t = el.prompt.value;
  S.charCount = t.length;
  el.counter.textContent = `${t.length} 字`;
}

function sendInput(force = false) {
  const now = Date.now();
  const idleMs = now - lastInputAt;
  if (!force && now - lastSentAt < 180) {
    if (trailing) clearTimeout(trailing);
    trailing = setTimeout(() => sendInput(true), 180 - (now - lastSentAt));
    return;
  }
  lastSentAt = now;
  const seq = ++localSeq;
  post('/api/input', { text: el.prompt.value, idleMs })
    .catch((err) => {
      if (seq === localSeq) toast(`上报输入失败：${err.message}`, 'err');
    });
}

el.prompt.addEventListener('input', () => {
  lastInputAt = Date.now();
  updateCounter();
  sendInput();
  // 本地即时反馈（服务端随后会覆盖为权威值）
  const t = el.prompt.value.trim();
  const rough = Math.min(1, t.length / 30 + (/[。！？!?；;]$/.test(t) ? 0.4 : 0));
  el.intentFill.style.width = `${Math.round(rough * 100)}%`;
});

/* ============================ SSE 接入 ============================ */

function on(name, fn) {
  window.addEventListener(`sf:${name}`, (e) => fn(e.detail));
}

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

function connect() {
  const es = new EventSource('/api/events');
  const names = [
    'hello', 'state', 'intent', 'queued', 'run:start', 'run:context', 'think:start', 'think:delta', 'think:end',
    'suggest:start', 'suggest', 'suggest:adopted', 'file:start', 'file:delta', 'file:end', 'run:text',
    'run:applied', 'run:done', 'run:error', 'run:cancelled', 'spec:done', 'run:promoted', 'tree', 'versions',
    'prompt', 'toast', 'rollback', 'file:saved',
  ];
  for (const n of names) es.addEventListener(n, (ev) => {
    let detail = null;
    try {
      detail = JSON.parse(ev.data);
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(`sf:${n}`, { detail }));
  });
  // EventSource 会自己重连；这里只是把状态显示成"重连中"而不是吓人的红字。
  es.onerror = () => {
    el.providerBadge.textContent = '连接中断，重连中…';
    el.providerBadge.className = 'badge warn';
  };
  es.onopen = () => renderProviderBadge();
}

/* ============================ 事件绑定 ============================ */

on('hello', () => {
  renderProviderBadge();
  toast('已连接 SynthFlow 服务', 'ok', 1800);
});

on('state', (st) => {
  if (!st) return;
  S.provider = st.provider;
  S.busy = st.busy;
  renderProviderBadge();
  setRunBadge(st.session?.status ?? 'idle');
  S.draft = st.draft;
  if (st.draft) {
    el.draftBadge.classList.remove('hidden');
    el.draftBadge.textContent = `预演就绪 · ${st.draft.files.length} 文件`;
  } else el.draftBadge.classList.add('hidden');
  if (st.versions) renderVersions(st.versions, st.session?.currentVersionId);
  if (st.workspace?.recent?.length) S.recent = st.workspace.recent;
  if (st.memory?.chips) renderChips(st.memory.chips);
  if (st.config) window.__sfConfig = st.config;
  if (st.presets) window.__sfPresets = st.presets;
});

on('intent', (d) => {
  S.lastIntent = d.intent;
  renderIntent(d.intent, d.decision);
});

on('queued', () => {
  toast('生成中：新输入已排队，会在本轮结束后增量续写', 'warn', 2600);
});

on('run:start', (d) => {
  S.busy = true;
  S.runKind = d.kind;
  setRunBadge(d.kind === 'spec' ? 'speculating' : 'generating');
  el.streamMode.textContent = d.kind === 'spec' ? '预演' : '正式生成';
  el.streamMode.className = `badge ${d.kind === 'spec' ? 'warn' : 'accent'}`;
  if (d.kind === 'spec') el.draftBadge.classList.remove('hidden');
  resetStreamLive();
  currentRunBlock = null;
});

on('run:context', (d) => {
  if (!d) return;
  const block = ensureRunBlock(S.runKind ?? 'run');
  const div = document.createElement('div');
  div.className = 'opblock';
  div.innerHTML = `<div class="opblock-head"><span class="op">上下文</span> 项目文件 ${d.files} 个 · RAG 命中 ${d.ragHits} 段${
    d.skills?.length ? ` · 技能 ${esc(d.skills.join('/'))}` : ''
  } · 约 ${d.chars} 字符</div>`;
  block.appendChild(div);
});

on('think:start', () => {
  currentThink = null;
});
on('think:delta', (d) => appendThink(d.delta));
on('think:end', () => {
  currentThink = null;
});

on('suggest', (d) => addSuggestion(d.suggestion));
on('suggest:adopted', () => {});

on('file:start', (d) => {
  S.live[d.path] = { content: '', diff: null, action: d.action, lang: d.lang, autoscroll: true };
  addOpBlock({ path: d.path, action: d.action, mode: d.action === 'update' ? 'patch' : 'create', patches: 0 });
  openFile(d.path, { autoscroll: true });
  renderTree(S.tree);
});

on('file:delta', (d) => {
  const entry = S.live[d.path];
  if (!entry) return;
  entry.content += d.delta;
  if (S.current === d.path) scheduleHighlight();
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
    if (entry?.diff) showDiffStrip(entry.diff, `${op.path} · 即将应用的增量补丁`);
  }
});

on('run:text', (d) => {
  // 协议外的散文字（模型没按协议输出时兜底显示）
  const block = ensureRunBlock(S.runKind ?? 'run');
  let pre = block.querySelector('.stray');
  if (!pre) {
    pre = document.createElement('pre');
    pre.className = 'stray';
    block.appendChild(pre);
  }
  pre.textContent += d.delta;
  streamScroll();
});

on('run:applied', async (d) => {
  for (const r of d.results ?? []) {
    delete S.live[r.path];
    if (r.ok) {
      try {
        const f = await get(`/api/file?path=${encodeURIComponent(r.path)}`);
        S.files[r.path] = f.content;
      } catch { /* ignore */ }
    }
  }
  renderTree(S.tree);
  if (S.current) renderCode();
  updateWorkspaceStats();
  const ok = (d.results ?? []).filter((r) => r.ok).length;
  const bad = (d.results ?? []).filter((r) => !r.ok);
  if (ok) toast(`已写入 ${ok} 个文件（${d.files?.join(', ') ?? ''}）`, 'ok', 2600);
  for (const b of bad) toast(`补丁未命中：${b.path} — ${b.error}`, 'warn', 5200);
});

on('run:done', (d) => {
  S.busy = false;
  setRunBadge('idle');
  el.streamMode.textContent = '待命';
  el.streamMode.className = 'badge';
  if (d.mode) {
    const modeText = { regenerate: '全新生成', continue: '增量续写', incremental: '定点增量补丁' }[d.mode] ?? d.mode;
    const block = ensureRunBlock(S.runKind ?? 'run');
    const div = document.createElement('div');
    div.className = 'opblock';
    div.innerHTML = `<div class="opblock-head"><span class="op">完成</span> ${esc(modeText)} · ${d.ms}ms · ${d.files.length} 个文件${d.versionId ? ` · 版本 ${esc(d.versionId)}` : ''}</div>`;
    block.appendChild(div);
    streamScroll();
  }
});

on('run:promoted', (d) => toast(`⚡ ${d.reason}`, 'ok', 5000));

on('spec:done', (d) => {
  S.busy = false;
  el.draftBadge.classList.remove('hidden');
  el.draftBadge.textContent = `预演就绪 · ${d.files.length} 文件 · 可省一次调用`;
  el.btnCommit.textContent = '采纳预演结果';
});

on('run:cancelled', () => {
  S.busy = false;
  setRunBadge('idle');
  toast('已停止生成', 'warn', 2000);
});

on('run:error', (d) => {
  S.busy = false;
  setRunBadge('error');
  toast(d.message, 'err', 8000);
});

on('tree', (d) => {
  renderTree(d.tree);
  if (!S.current) {
    const first = (d.tree?.children ?? []).flatMap(function first2(n) {
      return n.type === 'file' ? [n.path] : (n.children ?? []).flatMap(first2);
    })[0];
    if (first) openFile(first);
  }
});

on('versions', (d) => renderVersions(d.versions, d.current));

on('prompt', (d) => {
  el.prompt.value = d.text ?? '';
  updateCounter();
  if (d.reason === 'adopt' || d.reason === 'auto-adopt') toast('提示词已更新', 'ok', 1800);
});

on('rollback', (d) => {
  el.prompt.value = d.prompt ?? '';
  updateCounter();
  S.live = {};
  toast(`已回退：恢复 ${d.files.length} 个文件到 ${d.restoredFrom}`, 'ok', 3600);
  (async () => {
    const tree = await get('/api/tree');
    renderTree(tree.tree);
    for (const p of Object.keys(S.files)) {
      try {
        const f = await get(`/api/file?path=${encodeURIComponent(p)}`);
        S.files[p] = f.content;
      } catch {
        delete S.files[p];
      }
    }
    updateWorkspaceStats();
    if (S.current) renderCode();
  })();
});

on('file:saved', (d) => toast(`已保存 ${d.path}`, 'ok', 1800));
on('toast', (d) => toast(d.message, d.level ?? 'ok'));

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
  sel.value = config.provider ?? 'mock';
  $('#cfg-model').value = config.model ?? '';
  $('#cfg-baseUrl').value = config.baseUrl ?? '';
  $('#cfg-apiKey').value = '';
  $('#cfg-apiKey').placeholder = config.apiKeySet ? '已保存（留空则不修改）' : 'sk-...';
  $('#cfg-specDelayMs').value = config.specDelayMs ?? 320;
  $('#cfg-commitIdleMs').value = config.commitIdleMs ?? 900;
  $('#cfg-settleMs').value = config.settleMs ?? 1600;
  $('#cfg-intentThreshold').value = config.intentThreshold ?? 0.6;
  $('#cfg-autoCommit').checked = config.autoCommit !== false;
  $('#cfg-autoAdoptHigh').checked = Boolean(config.autoAdoptHigh);
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
  };
  const key = $('#cfg-apiKey').value.trim();
  if (key) payload.apiKey = key;
  try {
    const res = await post('/api/config', payload);
    toast(`已切换模型：${res.provider.name}${res.provider.ready ? '' : `（${res.provider.note}）`}`, 'ok', 4200);
    el.modal.classList.add('hidden');
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

/* ============================ 操作按钮 ============================ */

async function doRollback(versionId) {
  try {
    const res = await post('/api/rollback', versionId ? { versionId } : {});
    if (!res.ok) toast(res.error ?? '无法回退', 'warn');
  } catch (err) {
    toast(`回退失败：${err.message}`, 'err');
  }
}

el.btnRollback.addEventListener('click', () => doRollback());
el.btnCommit.addEventListener('click', async () => {
  try {
    const res = await post('/api/commit', { reason: 'manual' });
    if (res.promoted) toast('已直接采纳预演结果（没有重复调用模型）', 'ok');
    else if (!res.ok) toast(res.error ?? '启动失败', 'warn');
  } catch (err) {
    toast(`启动失败：${err.message}`, 'err');
  }
});
el.btnCancel.addEventListener('click', () => post('/api/cancel').catch(() => {}));
el.btnRegenerate.addEventListener('click', async () => {
  try {
    const res = await post('/api/commit', { reason: 'force', force: true });
    if (res.ok) toast('已忽略预演结果，强制重新生成', 'warn');
    else toast(res.error ?? '启动失败', 'warn');
  } catch (err) {
    toast(`启动失败：${err.message}`, 'err');
  }
});
el.btnSave.addEventListener('click', async () => {
  if (!S.current) return toast('先选一个文件', 'warn', 1600);
  try {
    await post('/api/save', { path: S.current, content: S.files[S.current] ?? '' });
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    doRollback();
  } else if (e.altKey && e.key === 'Enter') {
    e.preventDefault();
    el.btnCommit.click();
  }
});

window.addEventListener('beforeunload', () => {});

/* ============================ 启动 ============================ */

(async function boot() {
  connect();
  updateCounter();
  try {
    const st = await get('/api/state');
    S.provider = st.provider;
    window.__sfPresets = st.presets;
    window.__sfConfig = st.config;
    renderProviderBadge();
    if (st.memory?.chips) renderChips(st.memory.chips);
    const tree = await get('/api/tree');
    for (const rel of tree.files ?? []) {
      try {
        const f = await get(`/api/file?path=${encodeURIComponent(rel)}`);
        S.files[rel] = f.content;
      } catch { /* ignore */ }
    }
    renderTree(tree.tree);
    updateWorkspaceStats();
    const versions = await get('/api/versions');
    renderVersions(versions.versions, versions.current);
    if (st.session?.prompt) {
      el.prompt.value = st.session.prompt;
      updateCounter();
    }
    if (tree.files?.length) openFile(S.recent?.[0] ?? tree.files[0]);
    if (st.provider && !st.provider.ready) {
      toast(`模型未就绪：${st.provider.note} — 右上角「设置」里配置即可`, 'warn', 9000);
    } else if (st.provider?.name === 'mock') {
      toast('当前是内置演示模型（不耗额度）。接真实模型请在右上角「设置」里填 API Key。', 'ok', 7000);
    }
  } catch (err) {
    toast(`初始化失败：${err.message}`, 'err', 9000);
  }
})();
