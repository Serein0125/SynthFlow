// SynthFlow 前端 · 主逻辑：SSE 事件接线、文件树、轮次流、输入框、启动流程。
// 依赖加载顺序：core.js → editor.js → layout.js → panels.js → app.js

/* ============================ 文件树 ============================ */

function renderTree(tree) {
  if (tree) S.tree = tree;
  const container = el.fileTree;
  if (!container) return;
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
        const dots = [
          S.diffs[child.path] ? '<span class="dot" title="本轮有改动"></span>' : '',
          child.pending ? '<span class="dot pending" title="待应用到项目"></span>' : '',
          (S.manualEdits ?? []).some((m) => m.path === child.path) ? '<span class="dot manual" title="你手动改过"></span>' : '',
        ].join('');
        row.innerHTML = `<span class="name">${esc(child.name)}</span>${dots}`;
        row.dataset.path = child.path;
        row.title = child.path;
        if (S.current === child.path) row.classList.add('selected');
        row.addEventListener('click', () => openFile(child.path));
        parent.appendChild(row);
      }
    }
  };
  if (!(S.tree?.children ?? []).length) {
    container.innerHTML = '<p class="empty">还没有文件。开始输入需求，我会自动建目录和文件。</p>';
    return;
  }
  walk(S.tree, 0, container);
}

/* ============================ 标签页 ============================ */

function renderTabs() {
  if (!el.tabs) return;
  el.tabs.innerHTML = '';
  for (const path of S.openTabs) {
    const tab = document.createElement('div');
    const isDirty = S.current === path && Editor.dirty;
    tab.className = `tab${S.current === path ? ' active' : ''}${S.live[path] ? ' live' : ''}`;
    tab.innerHTML = `<span class="tab-name">${esc(path.split('/').pop())}${isDirty ? ' •' : ''}</span><span class="tab-close">×</span>`;
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

/* ============================ 代码与差异 ============================ */

let drawTimer = null;
function scheduleDraw() {
  if (drawTimer) return;
  drawTimer = setTimeout(() => {
    drawTimer = null;
    renderCode({ soft: true });
  }, 60);
}

function currentDiff(path) {
  if (S.live[path]?.diff?.length) return { compact: S.live[path].diff, added: null };
  return S.diffs[path] ?? null;
}

function updateDiffBadge() {
  const d = S.current ? currentDiff(S.current) : null;
  const n = d ? (d.compact ?? []).filter((x) => x.type !== 'same').length : 0;
  if (el.diffCount) {
    el.diffCount.textContent = n ? String(n) : '';
    el.diffCount.classList.toggle('hidden', n === 0);
  }
  el.viewToggle?.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
}

function renderCompareOptions() {
  if (!el.compareSelect) return;
  const curIdx = S.versions.findIndex((v) => v.id === S.activeVersionId);
  const options = S.versions
    .map((v, i) => ({ v, i }))
    .filter(({ i }) => i !== curIdx)
    .map(({ v }) => `<option value="${esc(v.id)}">${v.id === 'v0' ? '空项目基线' : esc(v.id)} · ${esc((v.summary ?? '').slice(0, 24))}</option>`)
    .join('');
  const prev = curIdx > 0 ? S.versions[curIdx - 1].id : 'v0';
  el.compareSelect.innerHTML = `<option value="">本轮差异（对 ${esc(prev)}）</option>${options}`;
  el.compareSelect.value = S.compareFrom;
}

async function openFile(path, { autoscroll = false } = {}) {
  S.current = path;
  if (!S.openTabs.includes(path)) S.openTabs.push(path);
  if (S.openTabs.length > 8) S.openTabs.shift();
  if (!S.live[path] && typeof S.files[path] !== 'string') await pullFile(path);
  if (autoscroll && S.live[path]) S.live[path].autoscroll = true;
  renderTabs();
  await renderCode();
  updateWorkspaceStats();
  document.querySelectorAll('.tree-item').forEach((r) => r.classList.toggle('selected', r.dataset.path === path));
}

async function renderCode({ soft = false } = {}) {
  const path = S.current;
  if (!path) {
    el.editorEmpty?.classList.remove('hidden');
    Editor.showHost?.('none');
    if (el.currentPath) el.currentPath.textContent = '未选择文件';
    if (el.fileMeta) el.fileMeta.textContent = '';
    updateDiffBadge();
    return;
  }
  el.editorEmpty?.classList.add('hidden');
  if (el.currentPath) {
    el.currentPath.textContent = path;
    el.currentPath.classList.toggle('live-path', Boolean(S.live[path]));
  }
  const live = S.live[path];
  const content = live ? live.content : S.files[path] ?? '';
  const added = [...(S.diffs[path]?.added ?? [])];

  if (S.view === 'diff') {
    await showDiffView(path);
  } else if (Editor.path === path) {
    await Editor.refresh(content, { added });
  } else {
    await Editor.open(path, content, { added });
  }
  if (el.fileMeta) {
    const lines = content.split('\n').length;
    const mark = added.length ? ` · 本轮 +${added.length}` : '';
    el.fileMeta.textContent = `${lines} 行 · ${content.length} 字符${mark}${live ? ' · 正在写入' : ''}${Editor.dirty ? ' · 未保存' : ''}`;
  }
  if (soft && !Editor.dirty) updateDiffBadge();
  else updateDiffBadge();
}

async function showDiffView(path) {
  const curIdx = S.versions.findIndex((v) => v.id === S.activeVersionId);
  const fromId = S.compareFrom || (curIdx > 0 ? S.versions[curIdx - 1].id : 'v0');
  const liveCompact = S.live[path]?.diff;
  let data = null;
  try {
    data = await get(`/api/compare?path=${encodeURIComponent(path)}&from=${encodeURIComponent(fromId)}`);
  } catch {
    data = null;
  }
  const modified = liveCompact ? (S.live[path].content ?? '') : S.files[path] ?? '';
  const original = data?.original ?? '';
  await Editor.showDiff({
    original,
    modified,
    compact: liveCompact ?? data?.compact ?? [],
    language: langOf(path),
  });
  if (el.fileMeta) {
    const stat = liveCompact
      ? { added: liveCompact.filter((d) => d.type === 'ins').length, removed: liveCompact.filter((d) => d.type === 'del').length }
      : data?.stat ?? { added: 0, removed: 0 };
    el.fileMeta.textContent = `与 ${S.compareFrom || fromId} 对比 · +${stat.added} / -${stat.removed}`;
  }
}

function setView(view) {
  S.view = view;
  LS.set('view', view);
  updateDiffBadge();
  renderCode();
}

/* ============================ 版本时间线 ============================ */

function renderVersions(payload) {
  if (Array.isArray(payload)) payload = { versions: payload };
  if (payload.versions) S.versions = payload.versions;
  if (payload.activeVersionId) S.activeVersionId = payload.activeVersionId;
  if (typeof payload.canBack === 'boolean') S.canBack = payload.canBack;
  if (typeof payload.canForward === 'boolean') S.canForward = payload.canForward;
  if (payload.pendingConfirm) S.pendingConfirm = payload.pendingConfirm;
  if (el.btnUndo) el.btnUndo.disabled = !S.canBack;
  if (el.btnRedo) el.btnRedo.disabled = !S.canForward;
  renderCompareOptions();
  if (!el.timeline) return;
  el.timeline.innerHTML = '';
  const curIdx = S.versions.findIndex((x) => x.id === S.activeVersionId);
  S.versions.forEach((v, i) => {
    const li = document.createElement('li');
    const isActive = i === curIdx;
    const ahead = i > curIdx;
    const unconfirmed = v.confirmed === false;
    li.className = `timeline-item${isActive ? ' current' : ''}${ahead ? ' reverted' : ''}${unconfirmed ? ' unconfirmed' : ''}`;
    const files = (v.files ?? []).length ? ` · ${(v.files ?? []).length} 个文件` : '';
    li.innerHTML =
      `<b>${esc(v.id)}</b><span>${esc(v.summary || (v.kind === 'baseline' ? '空项目基线' : v.id))}${v.kind === 'baseline' ? '' : esc(files)}</span>` +
      (unconfirmed ? '<i class="unconfirmed-tag">待确认</i>' : '');
    li.title = `提示词：${(v.promptAfter ?? '').slice(0, 140)}`;
    li.addEventListener('click', () => {
      if (isActive) return;
      doVersion(i < curIdx ? 'back' : 'forward', v.id);
    });
    el.timeline.appendChild(li);
  });
  if (el.versionHint) {
    el.versionHint.textContent = S.versions.length > 1 ? ` ${curIdx}/${S.versions.length - 1}` : '';
    el.versionHint.title = S.canForward ? '你正处于历史版本，可以点 ⏩ 前进回去' : '';
  }
}

/* ============================ 待应用改动（暂存模式） ============================ */

function renderPending(payload) {
  if (!payload) return;
  if (typeof payload.staging === 'boolean') S.staging = payload.staging;
  if (Array.isArray(payload.items)) S.pending = payload.items;
  const bar = el.pendingBar;
  if (!bar) return;
  if (!S.staging) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const n = S.pending.length;
  if (el.pendingText) {
    el.pendingText.textContent = n
      ? `暂存模式：${n} 个文件待应用到项目（${S.pending.slice(0, 3).map((p) => p.path).join('、')}${n > 3 ? '…' : ''}）`
      : '暂存模式：改动会先落在这里，确认后才写进你的项目';
  }
  if (el.btnApplyPending) el.btnApplyPending.disabled = n === 0;
  if (el.btnDiscardPending) el.btnDiscardPending.disabled = n === 0;
}

/* ============================ 思考与建议流 ============================ */

function streamScroll() {
  if (el.streamBody) el.streamBody.scrollTop = el.streamBody.scrollHeight;
}

function streamNearBottom() {
  const b = el.streamBody;
  if (!b) return true;
  return b.scrollHeight - b.scrollTop - b.clientHeight < 140;
}

function newRound(kind, mode, label, meta = {}) {
  const div = document.createElement('div');
  div.className = `stream-run${kind === 'spec' ? ' spec-run' : ''}`;
  div.dataset.kind = kind;
  div.dataset.mode = mode ?? '';
  const idx = S.rounds.length + 1;
  const time = meta.at ? new Date(meta.at).toLocaleTimeString('zh-CN', { hour12: false }) : new Date().toLocaleTimeString('zh-CN', { hour12: false });
  div.innerHTML =
    '<div class="run-head">' +
    `<span class="run-idx">第 ${idx} 轮</span>` +
    `<span class="run-mode">${esc(label ?? (kind === 'spec' ? '预演' : '生成'))}</span>` +
    `<span class="run-time">${esc(time)}</span>` +
    `<span class="run-files">${esc(meta.files ? `${meta.files.length} 个文件${meta.ms ? ` · ${meta.ms}ms` : ''}` : '')}</span>` +
    '<span class="spacer"></span>' +
    (meta.versionId && meta.unconfirmed ? '<button class="btn tiny run-confirm">保留此版本</button><button class="btn ghost tiny run-discard">丢弃</button>' : '') +
    '<span class="run-collapse"></span>' +
    '</div><div class="run-body"></div>';
  const round = { id: meta.id ?? `r${idx}_${Date.now().toString(36)}`, kind, mode, el: div, idx, collapsed: false, versionId: meta.versionId ?? null };
  div.querySelector('.run-head').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    toggleRound(round);
  });
  const confirmBtn = div.querySelector('.run-confirm');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      try {
        await post('/api/version/confirm', { versionId: meta.versionId });
        div.querySelector('.run-confirm')?.remove();
        div.querySelector('.run-discard')?.remove();
        setStatus('done', '已保留该版本', meta.versionId);
      } catch (err) {
        toast(`保留失败：${err.message}`, 'err');
      }
    });
  }
  const discardBtn = div.querySelector('.run-discard');
  if (discardBtn) {
    discardBtn.addEventListener('click', async () => {
      try {
        const res = await post('/api/version/discard', { versionId: meta.versionId });
        if (res.ok) {
          div.querySelector('.run-confirm')?.remove();
          div.querySelector('.run-discard')?.remove();
          toast(`已丢弃 ${meta.versionId}，代码回到上一版`, 'warn', 3600);
        }
      } catch (err) {
        toast(`丢弃失败：${err.message}`, 'err');
      }
    });
  }
  el.streamBody.appendChild(div);
  el.streamBody.querySelector('.empty')?.remove();
  S.rounds.push(round);
  S.currentRound = round;
  focusRound(round, { scroll: streamNearBottom() });
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

function updateRoundLabel() {
  const i = S.rounds.indexOf(S.currentRound);
  if (el.roundLabel) el.roundLabel.textContent = S.rounds.length ? `${i + 1}/${S.rounds.length}` : '';
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
      if (think.classList.contains('streaming')) return;
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

/** 把服务端持久化的轮次回灌到思考栏（想法 3）。 */
function rehydrateTimeline(timeline) {
  if (!el.streamBody || !Array.isArray(timeline) || !timeline.length) return;
  el.streamBody.querySelector('.empty')?.remove();
  el.streamBody.innerHTML = '';
  S.rounds = [];
  S.suggestions = [];
  for (const r of timeline) {
    const label = r.kind === 'spec' ? '预演' : MODE_TEXT[r.mode] ?? '生成';
    const round = newRound(r.kind, r.mode, label, { at: r.at, files: r.files, ms: r.ms, id: r.id, versionId: r.versionId, unconfirmed: false });
    const body = round.el.querySelector('.run-body');
    for (const t of r.thoughts ?? []) {
      const think = document.createElement('div');
      think.className = 'think collapsed';
      const head = document.createElement('div');
      head.className = 'think-head';
      head.textContent = '思考';
      const text = String(t).replace(/\s+/g, ' ').trim();
      head.insertAdjacentHTML('beforeend', `<span class="think-summary">· ${esc(text.slice(0, 46))}${text.length > 46 ? '…' : ''}</span><span class="muted tiny" style="margin-left:auto">${text.length} 字</span>`);
      const b = document.createElement('div');
      b.className = 'think-body';
      b.textContent = t;
      think.appendChild(head);
      think.appendChild(b);
      head.addEventListener('click', () => think.classList.toggle('collapsed'));
      body.appendChild(think);
    }
    for (const op of r.ops ?? []) {
      const div = document.createElement('div');
      div.className = 'opblock';
      const actionText = { create: '新建', update: '增量修改', rewrite: '整体重写', delete: '删除' }[op.action] ?? op.action;
      div.innerHTML = `<div class="opblock-head"><span class="op">${esc(actionText)}</span><code>${esc(op.path)}</code></div>`;
      div.addEventListener('click', () => openFile(op.path));
      body.appendChild(div);
    }
    for (const sg of r.suggestions ?? []) addSuggestion(sg, { restored: true });
    body.insertAdjacentHTML('beforeend', `<div class="opblock"><div class="opblock-head"><span class="op">历史</span> ${esc(MODE_TEXT[r.mode] ?? '生成')} · ${r.ms}ms${r.versionId ? ` · 版本 ${esc(r.versionId)}` : ''}</div></div>`);
  }
  S.currentRound = S.rounds[S.rounds.length - 1] ?? null;
  updateRoundLabel();
  updateUnread();
  if (el.streamBody) el.streamBody.scrollTop = el.streamBody.scrollHeight;
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
  }${d.styled ? ` · 已套用项目风格（扫了 ${d.styleScanned} 个文件）` : ''} · 约 ${d.chars} 字符</div>`;
  body.appendChild(div);
}

const KIND_TEXT = { clarify: '需求补全', optimize: '优化方向', risk: '风险提示', test: '测试建议', a11y: '可访问性' };

function addSuggestion(sg, { restored = false } = {}) {
  const round = S.currentRound;
  if (!round) return;
  const body = round.el.querySelector('.run-body');
  let box = body.querySelector('.suggestion-batch');
  if (!box) {
    box = document.createElement('div');
    box.className = 'suggestion-batch';
    box.innerHTML = '<div class="suggestion-batch-head"><span>本轮建议</span><span class="muted">点「采纳」会直接写进你的提示词</span></div>';
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
  const entry = { sg, roundId: round.id, handled: restored, el: card };
  S.suggestions.push(entry);
  card.querySelector('.act-adopt').addEventListener('click', () => adopt(entry));
  card.querySelector('.act-dismiss').addEventListener('click', async () => {
    entry.handled = true;
    card.classList.add('adopted');
    card.querySelector('.suggestion-actions').innerHTML = '<span class="muted">已忽略（会进入习惯记忆）</span>';
    updateUnread();
    await post('/api/dismiss', { suggestion: sg }).catch(() => {});
  });
  if (restored) card.classList.add('adopted');
  box.appendChild(card);
  if (!restored && !round.collapsed) streamScroll();
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
  if (el.unreadBadge) {
    el.unreadBadge.textContent = String(S.unread);
    el.unreadBadge.classList.toggle('hidden', S.unread === 0);
  }
}

/* ============================ 意图与状态 ============================ */

function renderIntent(intent, decision) {
  if (!intent) return;
  const pct = Math.round((intent.score ?? 0) * 100);
  if (el.intentFill) {
    el.intentFill.style.width = `${pct}%`;
    el.intentFill.classList.remove('low', 'mid', 'high');
    el.intentFill.classList.add(pct >= 60 ? 'high' : pct >= 40 ? 'mid' : 'low');
  }
  if (el.intentText) el.intentText.textContent = intent.complete ? `意图判定：已写完（${pct}%）` : `意图判定：还在写（${pct}%）`;
  if (el.decisionText) {
    el.decisionText.textContent = decision?.mode
      ? `策略：${MODE_TEXT[decision.mode] ?? decision.mode}${decision.ratio ? ` · 变动 ${(decision.ratio * 100).toFixed(0)}%` : ''}`
      : '';
  }
  if (!S.busy) setStatus('typing', '输入中…', (intent.reasons ?? []).slice(0, 1).join(''));
}

function setRunBadge(status) {
  const map = {
    idle: ['空闲', 'idle'],
    speculating: ['预演中…', 'warn'],
    generating: ['正在生成…', 'accent'],
    applying: ['正在写入…', 'accent'],
    error: ['出错了', 'err'],
  };
  const [text, cls] = map[status] ?? ['运行中', 'accent'];
  if (el.runBadge) {
    el.runBadge.textContent = text;
    el.runBadge.className = `badge ${cls}`;
  }
}

function renderProviderBadge() {
  const p = S.provider;
  if (!p) {
    if (el.providerBadge) {
      el.providerBadge.textContent = '模型加载中…';
      el.providerBadge.className = 'badge';
    }
    return;
  }
  if (el.providerBadge) {
    el.providerBadge.textContent = `${p.label ?? p.name ?? '模型'}${p.ready ? '' : ' · 未就绪'}`;
    el.providerBadge.className = `badge ${p.ready ? 'ok' : 'err'}`;
    el.providerBadge.title = p.note ?? '';
  }
}

function renderProfileSelect(profiles, activeId) {
  if (!el.profileSelect || !profiles?.length) return;
  el.profileSelect.innerHTML = profiles
    .map((p) => `<option value="${esc(p.id)}"${p.id === activeId ? ' selected' : ''}>${esc(p.name)}</option>`)
    .join('');
  el.profileSelect.classList.remove('hidden');
}

function renderProjectChip(state) {
  if (!el.projectChip) return;
  const dir = state.paths?.projectDir ?? '';
  S.projectDir = dir;
  S.staging = Boolean(state.workspace?.staging);
  const short = dir.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
  el.projectChip.textContent = `📁 ${short}${S.staging ? ' · 暂存' : ''}`;
  el.projectChip.title = `目标项目：${dir}\n${S.staging ? '暂存模式：AI 改动需你确认后才写入项目' : '直接写入模式'}`;
  el.projectChip.classList.toggle('warn', S.staging);
}

/* ============================ 输入 ============================ */

let lastInputAt = 0;
let lastSentAt = 0;
let trailing = null;
let localSeq = 0;

function updateCounter() {
  if (el.counter) el.counter.textContent = `${el.prompt.value.length} 字`;
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

function renderSelectionChip() {
  const chip = el.selectionChip;
  if (!chip) return;
  const sel = S.selection;
  if (!sel) {
    chip.classList.add('hidden');
    return;
  }
  chip.classList.remove('hidden');
  if (el.selectionText) {
    el.selectionText.textContent = `已选中 ${sel.path}:${sel.startLine}-${sel.endLine}（${sel.endLine - sel.startLine + 1} 行）`;
  }
}

/* ============================ SSE ============================ */

function on(name, fn) {
  window.addEventListener(`sf:${name}`, (e) => fn(e.detail));
}

function connect() {
  const es = new EventSource('/api/events');
  const names = [
    'hello', 'state', 'intent', 'queued', 'run:start', 'run:context', 'think:start', 'think:delta', 'think:end',
    'suggest', 'suggest:adopted', 'file:start', 'file:delta', 'file:end', 'run:text', 'retry',
    'run:applied', 'run:done', 'run:error', 'run:cancelled', 'spec:done', 'run:promoted', 'tree', 'versions',
    'timeline', 'pending', 'prompt', 'toast', 'rollback', 'file:saved',
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
    if (el.providerBadge) {
      el.providerBadge.textContent = '连接中断，重连中…';
      el.providerBadge.className = 'badge warn';
    }
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
  renderProjectChip(st);
  if (st.profiles) renderProfileSelect(st.profiles, st.activeProfileId);
  if (st.versions) renderVersions(st.versions);
  if (st.workspace?.staging !== undefined) renderPending({ items: S.pending, staging: st.workspace.staging });
  if (st.manualEdits) S.manualEdits = st.manualEdits;
  if (st.memory?.chips) renderChips(st.memory.chips);
  const stats = st.session?.stats;
  if (stats) {
    if (typeof stats.modelCalls === 'number') S.usage.calls = stats.modelCalls;
    if (typeof stats.estTokens === 'number') S.usage.tokens = stats.estTokens;
  }
  renderUsage();
  const keepDone = S.statusKind === 'done' && Date.now() - S.statusAt < 6000;
  if (!st.busy && !keepDone) setStatus('idle', '空闲', `${st.workspace?.files ?? 0} 个文件`);
});

on('timeline', (d) => d?.timeline && rehydrateTimeline(d.timeline));
on('pending', (d) => renderPending(d));

on('intent', (d) => renderIntent(d.intent, d.decision));

on('queued', (d) => setStatus('busy', '生成中…', d.reason ?? ''));

on('run:start', (d) => {
  S.busy = true;
  setRunBadge(d.kind === 'spec' ? 'speculating' : 'generating');
  const label = d.kind === 'spec' ? '预演' : MODE_TEXT[d.mode] ?? '生成';
  S.diffs = {};
  // 有未保存的手改就先自动保存，避免被 AI 的写入覆盖掉
  if (Editor.dirty && S.current) {
    saveCurrent({ silent: true, reason: '自动保存（生成前）' });
  }
  newRound(d.kind, d.mode, label);
  setStatus(d.kind === 'spec' ? 'spec' : 'gen', d.kind === 'spec' ? '预演中（你还在打字）…' : '正在生成…', '');
});

on('run:context', (d) => d && addContextBlock(d));
on('think:start', () => {});
on('think:delta', (d) => appendThink(d.delta));
on('think:end', () => finishThink());
on('suggest', (d) => addSuggestion(d.suggestion));

on('file:start', (d) => {
  S.live[d.path] = { content: '', diff: null, action: d.action, lang: d.lang, autoscroll: true };
  addOpBlock({ path: d.path, action: d.action, mode: d.action === 'update' ? 'patch' : 'create', patches: 0 });
  openFile(d.path, { autoscroll: true });
  renderTree();
});

on('file:delta', (d) => {
  const entry = S.live[d.path];
  if (!entry) return;
  entry.content += d.delta;
  if (S.current === d.path && S.view === 'code') scheduleDraw();
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
  if (S.current === op.path) renderCode();
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
        S.diffs[r.path] = { compact: r.compact ?? [], added: new Set(r.addedLines ?? []), round: S.currentRound?.id };
      }
    }
    delete S.live[r.path];
  }
  renderTree();
  if (S.current) await renderCode();
  updateWorkspaceStats();
  for (const b of (d.results ?? []).filter((r) => !r.ok)) toast(`补丁未命中：${b.path} — ${b.error}`, 'warn', 6000);
  if (d.staging) {
    const p = await get('/api/pending').catch(() => null);
    if (p) renderPending(p);
  }
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
    }${d.pendingConfirm ? ' · <span class="warn-text">待确认</span>' : ''}</div>`;
    round.el.querySelector('.run-body')?.appendChild(done);
    if (d.pendingConfirm && d.versionId) {
      const head = round.el.querySelector('.run-head');
      const bar = document.createElement('div');
      bar.className = 'save-confirm';
      bar.innerHTML = `<span>这轮的改动要保留为一个版本吗？</span><button class="btn primary small sv-save">保留 ${esc(d.versionId)}</button><button class="btn ghost small sv-drop">丢弃这轮改动</button>`;
      bar.querySelector('.sv-save').addEventListener('click', async () => {
        await post('/api/version/confirm', { versionId: d.versionId }).catch((e) => toast(e.message, 'err'));
        bar.remove();
        setStatus('done', `已保留 ${d.versionId}`, '');
      });
      bar.querySelector('.sv-drop').addEventListener('click', async () => {
        try {
          const res = await post('/api/version/discard', { versionId: d.versionId });
          if (res.ok) {
            bar.remove();
            toast(`已丢弃 ${d.versionId}，代码回到上一版`, 'warn', 3600);
          }
        } catch (err) {
          toast(`丢弃失败：${err.message}`, 'err');
        }
      });
      head.insertAdjacentElement('afterend', bar);
    }
    streamScroll();
  }
  if (d.usage) {
    S.usage.last = d.usage.tokens ?? 0;
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

on('tree', async (d) => {
  renderTree(d.tree);
  if (Editor.mode === 'monaco' && S.current && typeof S.files[S.current] !== 'string') await pullFile(S.current);
  if (!S.current) {
    const first = flattenFiles(d.tree ?? {})[0];
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
    await refreshAll();
  })();
});

on('file:saved', (d) => setStatus('done', `已保存 ${d.path}`, d.manual ? '已记入"手动改动"，AI 不会覆盖' : ''));
on('toast', (d) => toast(d.message, d.level ?? 'ok'));

/* ============================ 保存 ============================ */

async function saveCurrent({ silent = false, reason = '' } = {}) {
  if (!S.current) return;
  const content = Editor.getValue();
  if (content === S.files[S.current] && !Editor.dirty) {
    if (!silent) toast('没有变化需要保存', 'warn', 1600);
    return;
  }
  try {
    await post('/api/save', { path: S.current, content });
    S.files[S.current] = content;
    Editor.setDirty(false);
    renderTabs();
    if (!silent) setStatus('done', `已保存 ${S.current}`, reason || '已生成一个新版本，可随时回退');
    else toast(`已自动保存 ${S.current}（生成前保护你的手改）`, 'ok', 2600);
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

/* ============================ 主题 ============================ */

function applyTheme(mode = S.theme) {
  S.theme = mode;
  LS.set('theme', mode);
  const resolved = mode === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode;
  document.documentElement.dataset.theme = resolved;
  if (el.btnTheme) {
    el.btnTheme.textContent = mode === 'system' ? '🌗' : mode === 'light' ? '☀️' : '🌙';
    el.btnTheme.title = `主题：${mode === 'system' ? '跟随系统' : mode === 'light' ? '亮色' : '暗色'}（点击切换）`;
  }
  Editor.setTheme(resolved !== 'light');
}

/* ============================ 快捷键 ============================ */

document.addEventListener('keydown', (e) => {
  const mod = e.altKey || e.ctrlKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    doVersion('back');
    return;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'z') {
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
    Panels.openPalette();
    return;
  }
  if (e.key === 'Escape') {
    if (!el.palette.classList.contains('hidden')) return Panels.closePalette();
    if (!el.helpModal.classList.contains('hidden')) return el.helpModal.classList.add('hidden');
    if (el.skillsModal && !el.skillsModal.classList.contains('hidden')) return el.skillsModal.classList.add('hidden');
    if (!el.modal.classList.contains('hidden')) return el.modal.classList.add('hidden');
    if (!el.layoutPanel.classList.contains('hidden')) return el.layoutPanel.classList.add('hidden');
    if (S.busy) {
      e.preventDefault();
      post('/api/cancel').catch(() => {});
    }
    return;
  }
  if (e.altKey && /^[1-9]$/.test(e.key)) {
    const target = S.suggestions.filter((x) => !x.handled)[Number(e.key) - 1];
    if (target) {
      e.preventDefault();
      target.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      adopt(target);
    }
  }
});

/* ============================ 工具栏 ============================ */

async function doVersion(direction, versionId) {
  try {
    const res = await post('/api/rollback', { direction, versionId });
    if (!res.ok) toast(res.error ?? '无法切换版本', 'warn', 4000);
  } catch (err) {
    toast(`版本切换失败：${err.message}`, 'err');
  }
}

function renderChips(chips) {
  if (!el.chips) return;
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

function bindUi() {
  el.prompt?.addEventListener('input', () => {
    lastInputAt = Date.now();
    updateCounter();
    sendInput();
    if (el.prompt.value.trim()) setStatus('typing', '输入中…', '等你停下来我就开始预演');
  });

  el.btnTheme?.addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    applyTheme(order[(order.indexOf(S.theme) + 1) % order.length]);
  });
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (S.theme === 'system') applyTheme('system');
  });

  el.btnUndo?.addEventListener('click', () => doVersion('back'));
  el.btnRedo?.addEventListener('click', () => doVersion('forward'));
  el.viewToggle?.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setView(btn.dataset.view);
  });
  el.compareSelect?.addEventListener('change', () => {
    S.compareFrom = el.compareSelect.value;
    if (S.view !== 'diff') setView('diff');
    else renderCode();
  });
  el.btnSave?.addEventListener('click', () => saveCurrent());
  el.btnCommit?.addEventListener('click', async () => {
    try {
      const res = await post('/api/commit', { reason: 'manual' });
      if (!res.ok) toast(res.error ?? '启动失败', 'warn', 3000);
    } catch (err) {
      toast(`启动失败：${err.message}`, 'err');
    }
  });
  el.btnCancel?.addEventListener('click', () => post('/api/cancel').catch(() => {}));
  el.btnRegenerate?.addEventListener('click', async () => {
    try {
      const res = await post('/api/commit', { reason: 'force', force: true });
      if (!res.ok) toast(res.error ?? '启动失败', 'warn', 3000);
    } catch (err) {
      toast(`启动失败：${err.message}`, 'err');
    }
  });
  el.btnApplyPending?.addEventListener('click', async () => {
    if (!S.pending.length) return;
    const summary = S.pending.map((p) => `${p.status === 'added' ? '+' : p.status === 'deleted' ? '-' : '~'} ${p.path}`).join('\n');
    if (!window.confirm(`确认把这 ${S.pending.length} 个文件的改动写入项目吗？\n\n${summary}`)) return;
    try {
      const res = await post('/api/apply');
      toast(`已应用 ${res.applied.length} 个文件到项目`, 'ok', 4200);
      await refreshAll();
    } catch (err) {
      toast(`应用失败：${err.message}`, 'err');
    }
  });
  el.btnDiscardPending?.addEventListener('click', async () => {
    if (!S.pending.length) return;
    if (!window.confirm(`丢弃这 ${S.pending.length} 个文件的暂存改动？你的项目不会被修改。`)) return;
    try {
      await post('/api/discard');
      await refreshAll();
    } catch (err) {
      toast(`丢弃失败：${err.message}`, 'err');
    }
  });
  el.btnSettings?.addEventListener('click', () => Panels.openSettings());
  el.btnHelp?.addEventListener('click', () => el.helpModal.classList.remove('hidden'));
  $('#help-close')?.addEventListener('click', () => el.helpModal.classList.add('hidden'));
  el.helpModal?.addEventListener('click', (e) => {
    if (e.target === el.helpModal) el.helpModal.classList.add('hidden');
  });
  el.btnThinkMode?.addEventListener('click', () => {
    S.thinkExpandAll = !S.thinkExpandAll;
    LS.set('thinkExpand', S.thinkExpandAll);
    el.btnThinkMode.textContent = `思考：${S.thinkExpandAll ? '展开' : '折叠'}`;
    document.querySelectorAll('.think:not(.streaming)').forEach((t) => t.classList.toggle('collapsed', !S.thinkExpandAll));
  });
  el.btnRoundPrev?.addEventListener('click', () => jumpRound(-1));
  el.btnRoundNext?.addEventListener('click', () => jumpRound(1));
  el.selectionClear?.addEventListener('click', () => {
    S.selection = null;
    renderSelectionChip();
    post('/api/selection', { selection: null }).catch(() => {});
  });
  el.profileSelect?.addEventListener('change', async () => {
    try {
      await post('/api/profiles/activate', { id: el.profileSelect.value });
    } catch (err) {
      toast(`切换失败：${err.message}`, 'err');
    }
  });
}

/* ============================ 启动 ============================ */

(async function boot() {
  try {
    Layout.init();
    applyTheme(S.theme);
    S.view = LS.get('view', 'code');
    if (el.btnThinkMode) el.btnThinkMode.textContent = `思考：${S.thinkExpandAll ? '展开' : '折叠'}`;
    Panels.bindPalette();
    bindUi();
    connect();
    updateCounter();
    renderUsage();
    setStatus('idle', '正在连接…', '');

    // Monaco 加载不阻塞首屏：先出界面，编辑器随后就绪
    Editor.onSelectionChange = (sel) => {
      S.selection = sel;
      renderSelectionChip();
      post('/api/selection', { selection: sel }).catch(() => {});
    };
    Editor.onDirtyChange = (v) => {
      renderTabs();
      if (el.btnSave) el.btnSave.classList.toggle('primary', v);
      if (S.current) renderCode();
    };
    Editor.onSaveRequest = () => saveCurrent();
    Editor.init().then((okM) => {
      S.monacoReady = okM;
      if (!okM) toast('Monaco 编辑器未加载，已降级为只读高亮（功能不受影响）', 'warn', 6000);
      if (S.current) renderCode();
    });

    const st = await get('/api/state');
    S.provider = st.provider;
    renderProviderBadge();
    renderProjectChip(st);
    renderProfileSelect(st.profiles, st.activeProfileId);
    if (st.memory?.chips) renderChips(st.memory.chips);
    if (st.versions) renderVersions(st.versions);
    if (st.manualEdits) S.manualEdits = st.manualEdits;

    const tree = await get('/api/tree');
    for (const rel of tree.files ?? []) await pullFile(rel);
    renderTree(tree.tree);
    updateWorkspaceStats();

    const pending = await get('/api/pending').catch(() => ({ items: [], staging: false }));
    renderPending(pending);

    const tl = await get('/api/timeline').catch(() => ({ timeline: [] }));
    if (tl.timeline?.length) rehydrateTimeline(tl.timeline);

    if (st.session?.prompt) {
      el.prompt.value = st.session.prompt;
      updateCounter();
    }
    if (tree.files?.length) await openFile(st.workspace?.recent?.[0] ?? tree.files[0]);
    setStatus('idle', '就绪', `${tree.files?.length ?? 0} 个文件 · 版本 ${st.session?.currentVersionId ?? 'v0'}`);
    if (st.provider && !st.provider.ready) toast(`模型未就绪：${st.provider.note} — 右上角「设置」里填写 API Key`, 'warn', 9000);
  } catch (err) {
    setStatus('err', '初始化失败', err.message);
    toast(`初始化失败：${err.message}`, 'err', 9000);
  }
})();
