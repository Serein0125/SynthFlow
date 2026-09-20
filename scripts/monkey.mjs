#!/usr/bin/env node
// SynthFlow 猴子测试（破坏性自测）
// ---------------------------------------------------------------------------
// 用户的原话："你能不能自己进行测试，什么样的操作都试一试，然后自己找bug并且解决？"
// 这个脚本就是回答：用真实浏览器，按种子随机地**乱点、乱拖、乱拉滑块**，
// 每一步之后都去校验一组"界面不许坏"的不变量，一旦违反就记下是哪一串操作导致的。
//
//   node scripts/monkey.mjs                     默认 120 步，不触发真实模型（不花钱）
//   node scripts/monkey.mjs --rounds=300        加大剂量
//   node scripts/monkey.mjs --seed=1234         固定种子，便于复现
//   node scripts/monkey.mjs --with-model        允许触发真实生成（会消耗额度）
//   node scripts/monkey.mjs --headed            显示浏览器窗口
//
// 它会先把项目切到一个临时目录，结束时切回原来的项目与写入方式。
// 违反不变量时会截图到 .synthflow/monkey/shots/，并写报告到 .synthflow/monkey/report.json。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, sleep } from './lib/browser.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const num = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? Number(hit.split('=')[1]) : d;
};

const BASE = (args.find((a) => a.startsWith('--url='))?.split('=')[1] ?? 'http://127.0.0.1:7788').replace(/\/+$/, '');
const ROUNDS = num('rounds', 120);
const SEED = num('seed', Date.now() % 100000);
const WITH_MODEL = has('with-model');
const HEADED = has('headed');
const VERBOSE = has('verbose');
const OUT = path.join(ROOT, '.synthflow', 'monkey');
const SHOTS = path.join(OUT, 'shots');
const SCRATCH = path.join(OUT, 'scratchproj');

/* ------------------------------ 伪随机（可复现） ------------------------------ */
let seedState = SEED >>> 0;
function rnd() {
  // xorshift32：够随机，而且同一个种子必然复现同一条路径
  seedState ^= seedState << 13; seedState >>>= 0;
  seedState ^= seedState >>> 17;
  seedState ^= seedState << 5; seedState >>>= 0;
  return seedState / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/* ------------------------------ 记录 ------------------------------ */
const color = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const dim = (s) => color(90, s);
const violations = [];
const consoleErrors = [];
const history = [];

function note(action) {
  history.push(action);
  if (history.length > 12) history.shift();
}

function violate(kind, detail, extra = {}) {
  const rec = { kind, detail, extra, after: [...history] };
  violations.push(rec);
  console.log(`\n  ${color(31, '✗ 违反不变量')} [${kind}] ${detail}`);
  console.log(`    ${dim(`触发它的最近操作：${history.slice(-4).join(' → ')}`)}`);
}

/* ------------------------------ 不变量 ------------------------------ */
/**
 * 每一步之后都跑一遍。这些就是"界面有没有坏"的可判定定义：
 * 页面不能整体滚动、输入区不能和工具行重叠、控件不能被挤出视口、
 * 连接不能断、布局数值不能越界。
 */
const INVARIANTS = `
  const win = [window.innerWidth, window.innerHeight];
  const doc = document.documentElement;
  const rect = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, w: r.width, h: r.height }; };
  const out = { issues: [] };

  // 1. 页面整体不可滚动（能滚就意味着顶栏或输入框会被滚出去）
  out.scrollY = Math.round(window.scrollY);
  out.scrollH = doc.scrollHeight;
  out.win = win;
  if (doc.scrollHeight > win[1] + 2) {
    out.issues.push('文档高度 ' + doc.scrollHeight + ' > 视口 ' + win[1]);
    // 把"到底是谁把文档撑高的"直接找出来，省得每次靠猜
    const over = [];
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (s.position === 'fixed' || s.display === 'none' || s.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0 && r.width === 0) continue;
      if (r.bottom > win[1] + 1) {
        over.push((el.id ? '#' + el.id : el.className ? '.' + String(el.className).split(' ')[0] : el.tagName)
          + ' bottom=' + Math.round(r.bottom) + ' h=' + Math.round(r.height) + ' pos=' + s.position);
      }
    }
    out.docOverflowBy = over.slice(0, 6);
  }

  // 2. 输入区内部的真实重叠判定。
  //    这里刻意不用 scrollHeight —— 它会把文字的基线/行高溢出也算进去，
  //    实测在没有任何视觉遮挡时也会报 23px 的"溢出"（假阳性）。
  //    直接量每个可见后代的底边有没有超过输入区的底边，才是"控件挤在一起"的真判据。
  const prompt = rect('#prompt');
  const tools = rect('.prompt-tools');
  const composer = rect('.composer');
  const side = rect('.composer-side');
  out.composerH = composer ? Math.round(composer.h) : null;
  if (prompt && tools && prompt.b > tools.t + 1) out.issues.push('输入框底边(' + Math.round(prompt.b) + ') 压到了工具行顶边(' + Math.round(tools.t) + ')');
  if (prompt && side && side.b > composer.b + 1) out.issues.push('右侧按钮溢出了输入区');
  if (composer) {
    const box = document.querySelector('.composer');
    const cRect = box.getBoundingClientRect();
    let worst = null;
    for (const el of box.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      if (s.position === 'absolute' || s.position === 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0 && r.width === 0) continue;
      const over = Math.round(r.bottom - cRect.bottom);
      if (over > 1 && (!worst || over > worst.over)) worst = { over, el: el.className || el.id || el.tagName };
    }
    if (worst) {
      out.issues.push('输入区里有元素超出底边 ' + worst.over + 'px：' + worst.el);
      out.composerKids = [...box.children]
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => (el.className || el.id) + '=' + Math.round(el.getBoundingClientRect().height));
      out.composerBox = { clientH: box.clientHeight, scrollH: box.scrollHeight, minH: getComputedStyle(box).minHeight };
      out.editorRows = [...document.querySelector('main.editor').children]
        .map((el) => (el.className || el.id) + '=' + Math.round(el.getBoundingClientRect().height));
      out.bodyH = Math.round(document.querySelector('.body').getBoundingClientRect().height);
    }
  }

  // 3. 关键控件都得在视口里、且尺寸正常。
  //    注意：面板被"隐藏"时它下面的元素天然是 0 尺寸，那是正常的，不算违规 ——
  //    真正要抓的是"面板明明显示着，里面却是 0 宽/0 高"。
  for (const s of ['#prompt', '#btn-commit', '#btn-stop', '#btn-sync', '#btn-save-version', '#file-tree', '#timeline', '#stream-body', '#mode-chip']) {
    const r = rect(s);
    if (!r) { out.issues.push('缺少控件 ' + s); continue; }
    const panelHidden =
      (s === '#file-tree' || s === '#timeline') ? document.body.classList.contains('hide-sidebar')
        : s === '#stream-body' ? document.body.classList.contains('hide-stream')
          : s === '#prompt' || s === '#btn-commit' || s === '#btn-stop' || s === '#btn-sync' ? false
            : false;
    if (r.w < 8 || r.h < 8) {
      if (panelHidden) continue;
      out.issues.push(s + ' 尺寸异常 ' + Math.round(r.w) + 'x' + Math.round(r.h));
    } else if (r.b < 0 || r.r < 0 || r.l > win[0] || r.t > win[1]) out.issues.push(s + ' 跑出视口');
  }

  // 4. 布局数值必须在允许区间内
  const cs = getComputedStyle(doc);
  const px = (n) => parseInt(cs.getPropertyValue(n), 10);
  out.layout = { sidebar: px('--sidebar-w'), stream: px('--stream-w'), composer: px('--composer-h') };
  if (out.layout.composer < 160) out.issues.push('输入区高度被拉到 ' + out.layout.composer + 'px（低于内容下限）');
  if (out.layout.sidebar < 140 && !document.body.classList.contains('hide-sidebar')) out.issues.push('左侧栏宽度 ' + out.layout.sidebar + 'px（低于下限且没被隐藏）');
  if (out.layout.stream < 180 && !document.body.classList.contains('hide-stream')) out.issues.push('思考栏宽度 ' + out.layout.stream + 'px（低于下限且没被隐藏）');

  // 5. 连接不能断
  const badge = document.querySelector('#provider-badge');
  out.provider = badge ? badge.textContent : '';
  if (out.provider.includes('连接中断')) out.issues.push('SSE 连接中断');

  return out;
`;

/* ------------------------------ 动作池 ------------------------------ */

// 不花钱、不下载、不会卡住的动作。
// 注意：不要往这里加 #btn-compact（一键整合）和 #btn-regenerate —— 它们会真的调用模型；
// #btn-export 会触发浏览器下载。这些都放在 WITH_MODEL 分支里单独控制。
const CLICKABLE = [
  '#btn-theme', '#btn-layout', '#btn-help', '#btn-settings',
  '#btn-tree-toggle', '#btn-tree-refresh',
  '#btn-stream-clear', '#btn-stream-compress',
  '#btn-save-version', '#btn-undo', '#btn-redo',
  '#mode-chip', '#project-chip',
  '#ly-reset',
];

// #btn-stop / #btn-sync 会切换"同步生成"开关，属于状态类动作，单独放。
const CLICKABLE_SYNC = ['#btn-stop', '#btn-sync'];
const CLICKABLE_MODEL = ['#btn-compact', '#btn-regenerate'];

const PRESETS = ['default', 'code', 'chat', 'zen'];

async function actClick(cdp) {
  const pool = [...CLICKABLE, ...CLICKABLE_SYNC, ...(WITH_MODEL ? CLICKABLE_MODEL : [])];
  const sel = pick(pool);
  const ok = await cdp.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el || el.disabled) return false;
    if (el.getClientRects().length === 0) return false;
    el.click();
    return true;
  `);
  return ok ? `点击 ${sel}` : null;
}

async function actSlider(cdp) {
  const sliders = [
    ['#ly-sidebar', 100, 560],
    ['#ly-stream', 100, 700],
    ['#ly-composer', 100, 600],
    ['#ly-font-ui', 11, 17],
    ['#ly-font-code', 10, 20],
  ];
  const [sel, lo, hi] = pick(sliders);
  // 先把布局面板打开，否则滑块不可见
  await cdp.evaluate(`document.querySelector('#layout-panel')?.classList.remove('hidden'); return true;`);
  const v = between(lo, hi);
  const ok = await cdp.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.value = ${v};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  return ok ? `拉动滑块 ${sel} → ${v}` : null;
}

/** 真实鼠标拖动（走 Input.dispatchMouseEvent，和用户手动拖是同一条路径）。 */
async function dragBy(cdp, sel, dx, dy) {
  const box = await cdp.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `);
  if (!box) return null;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 4; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: box.x + (dx * i) / 4, y: box.y + (dy * i) / 4, button: 'left', buttons: 1,
    });
    await sleep(25);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + dx, y: box.y + dy, button: 'left', buttons: 0 });
  return true;
}

async function actDrag(cdp) {
  const sel = pick(['#split-left', '#split-right', '#split-composer']);
  const dx = between(-220, 220);
  const dy = between(-140, 140);
  const before = await cdp.evaluate(INVARIANTS);
  const ok = await dragBy(cdp, sel, dx, dy);
  if (!ok) return null;
  await sleep(60);

  // ★ 拖动灵敏度的判定：拖了多少，就应该变化多少（允许边距/夹取带来的偏差）
  const after = await cdp.evaluate(INVARIANTS);
  const key = sel === '#split-left' ? 'sidebar' : sel === '#split-right' ? 'stream' : 'composer';
  const delta = sel === '#split-right' ? -dx : sel === '#split-composer' ? -dy : dx;
  const actual = (after.layout?.[key] ?? 0) - (before.layout?.[key] ?? 0);
  const expected = delta;
  const atEdge = after.layout?.[key] <= 142 || after.layout?.[key] >= 518 || actual === 0;
  if (!atEdge && Math.abs(actual - expected) > Math.abs(expected) * 0.5 + 24) {
    violate('拖动灵敏度', `${sel} 拖了 ${delta}px，实际变了 ${actual}px（应该大致相等）`, { before: before.layout, after: after.layout });
  }
  return `拖动 ${sel} (${dx},${dy}) → 实际变化 ${actual}px`;
}

async function actTree(cdp) {
  const ok = await cdp.evaluate(`
    const items = [...document.querySelectorAll('#file-tree .tree-item')];
    if (!items.length) return false;
    const el = items[Math.floor(Math.random() * items.length)];
    el.click();
    return true;
  `);
  return ok ? '点文件树里的一项' : null;
}

async function actType(cdp) {
  const texts = [
    '加一个导出按钮', '把列表改成卡片布局', '帮我写一个后台管理系统，包含',
    '删除掉没用的示例文件', '这段代码有 bug，帮我看看', '优化一下性能',
  ];
  const t = pick(texts);
  const ok = await cdp.evaluate(`
    const el = document.querySelector('#prompt');
    if (!el) return false;
    el.focus();
    el.value = ${JSON.stringify(t)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  return ok ? `在输入框里打字「${t}」` : null;
}

async function actModal(cdp) {
  const modal = pick(['#settings-modal', '#help-modal', '#picker-modal', '#compact-modal', '#palette']);
  const open = rnd() < 0.5;
  await cdp.evaluate(`
    const m = document.querySelector(${JSON.stringify(modal)});
    if (!m) return false;
    m.classList.toggle('hidden', ${open ? 'false' : 'true'});
    return true;
  `);
  return `${open ? '打开' : '关闭'} ${modal}`;
}

async function actPreset(cdp) {
  const p = pick(PRESETS);
  await cdp.evaluate(`document.querySelector('#layout-panel')?.classList.remove('hidden'); return true;`);
  const ok = await cdp.evaluate(`
    const b = document.querySelector('[data-preset=${JSON.stringify(p)}]');
    if (!b) return false;
    b.click();
    return true;
  `);
  return ok ? `应用布局预设 ${p}` : null;
}

async function actPanelToggle(cdp) {
  const which = pick(['#ly-show-sidebar', '#ly-show-stream']);
  await cdp.evaluate(`document.querySelector('#layout-panel')?.classList.remove('hidden'); return true;`);
  const ok = await cdp.evaluate(`
    const el = document.querySelector(${JSON.stringify(which)});
    if (!el) return false;
    el.checked = !el.checked;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  return ok ? `切换面板 ${which}` : null;
}

async function actGenerate(cdp) {
  const before = await cdp.evaluate(`return window.__sfMonkeyStarts ?? 0`);
  await cdp.evaluate(`
    const el = document.querySelector('#prompt');
    if (!el) return false;
    el.value = '加一个导出按钮，导出为 CSV。';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await cdp.evaluate(`document.querySelector('#btn-commit')?.click(); return true;`);
  await sleep(400);
  return `触发一次生成（此前 starts=${before}）`;
}

const ACTIONS = [
  { w: 26, fn: actClick },
  { w: 18, fn: actSlider },
  { w: 16, fn: actDrag },
  { w: 10, fn: actTree },
  { w: 10, fn: actModal },
  { w: 8, fn: actPreset },
  { w: 6, fn: actPanelToggle },
  { w: 12, fn: actType },
  ...(WITH_MODEL ? [{ w: 6, fn: actGenerate }] : []),
];

function chooseAction() {
  const total = ACTIONS.reduce((a, x) => a + x.w, 0);
  let r = rnd() * total;
  for (const a of ACTIONS) {
    r -= a.w;
    if (r <= 0) return a.fn;
  }
  return ACTIONS[0].fn;
}

/* ------------------------------ 主流程 ------------------------------ */

fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(path.join(SCRATCH, 'src', 'components'), { recursive: true });
fs.writeFileSync(path.join(SCRATCH, 'README.md'), '# 猴子测试用项目\n\n随便它怎么折腾。\n', 'utf8');
fs.writeFileSync(path.join(SCRATCH, 'src', 'index.js'), 'export const hello = () => "hi";\n', 'utf8');
fs.writeFileSync(path.join(SCRATCH, 'src', 'components', 'Card.js'), 'export function Card() {}\n', 'utf8');

console.log(`\n${color(36, '▌猴子测试')}  目标 ${BASE} · ${ROUNDS} 步 · 种子 ${SEED}${WITH_MODEL ? ' · 允许真实生成' : ' · 不触发模型'}`);

let browser = null;
let pass = 0;
let fail = 0;
const t0 = Date.now();

try {
  browser = await launchBrowser({
    profileDir: path.join(OUT, 'profile'),
    headed: HEADED,
    onConsoleError: (t) => {
      if (!/favicon|DevTools|Autofill/i.test(t)) consoleErrors.push(t);
    },
  });
  const { cdp } = browser;

  // ★ 必须处理 confirm/alert：点到 #mode-chip（切换写入方式）会弹 window.confirm，
  // 而 JS 弹窗会**阻塞渲染进程** —— 之后每一次 Runtime.evaluate 都会超时，
  // 看起来就像"页面卡死了"，其实只是有个对话框没人点。这里像真人一样点「确定」。
  let dialogs = 0;
  cdp.on('Page.javascriptDialogOpening', async (p) => {
    dialogs += 1;
    note(`（自动确认弹窗：${String(p.message ?? '').slice(0, 40)}）`);
    try {
      await cdp.send('Page.handleJavaScriptDialog', { accept: true });
    } catch { /* 已经关了 */ }
  });

  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor(`document.readyState === 'complete'`, { timeout: 20000, label: '页面加载' });
  await cdp.waitFor(`document.querySelector('#status-text') && document.querySelector('#status-text').textContent !== '正在连接…'`, { timeout: 20000, label: '前端启动' });

  // 记下原始项目与写入方式，结束时还原。
  // 备份写到 OUT **之外**：万一这次猴子中途崩了，下次启动能先把它恢复回去，
  // 不会出现"上一轮的临时目录被当成原始项目"这种越滚越偏的情况。
  const originFile = path.join(ROOT, '.synthflow', 'monkey-origin.json');
  const pre = await (await fetch(`${BASE}/api/state`)).json();
  let originalProject = pre.paths.projectDir;
  let originalMode = pre.paths.writeMode === 'direct' ? 'direct' : 'staging';

  // 恢复上一次没来得及还原的项目
  if (fs.existsSync(originFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(originFile, 'utf8'));
      if (prev.projectDir && prev.projectDir !== originalProject && fs.existsSync(prev.projectDir)) {
        console.log(dim(`  检测到上次猴子没还原干净，先把项目切回 ${prev.projectDir}`));
        await fetch(`${BASE}/api/project`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir: prev.projectDir, mode: prev.mode ?? 'staging' }),
        });
        await sleep(500);
        originalProject = prev.projectDir;
        originalMode = prev.mode ?? 'staging';
      }
    } catch { /* 备份坏了就忽略 */ }
  }
  // 兜底：如果当前项目就是猴子自己的临时目录，别把它当成"原始项目"
  if (originalProject && originalProject.startsWith(OUT)) {
    const fallback = path.join(ROOT, 'workspace');
    console.log(color(33, `  当前项目是猴子自己的临时目录，改用 ${fallback} 作为还原目标`));
    originalProject = fallback;
    originalMode = 'direct';
  }
  fs.writeFileSync(originFile, `${JSON.stringify({ projectDir: originalProject, mode: originalMode }, null, 2)}\n`, 'utf8');
  console.log(dim(`  当前项目 ${originalProject}（${originalMode}，结束会切回）`));

  await fetch(`${BASE}/api/project`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: SCRATCH, mode: 'direct' }),
  });
  await sleep(600);

  // 统计页面里发起过多少次生成，供乱点判断
  await cdp.evaluate(`
    window.__sfMonkeyStarts = 0;
    window.addEventListener('sf:run:start', () => { window.__sfMonkeyStarts += 1; });
    return true;
  `);

  // ★ 关键：默认把"同步生成"关掉。
  // 否则猴子往输入框里打字就会被当成真的在输入需求，停顿一秒后**真的调用模型** ——
  // 既花钱，又会把大量流式事件灌进页面，掩盖掉真正的界面问题。
  if (!WITH_MODEL) {
    await cdp.evaluate(`document.querySelector('#btn-stop')?.click(); return true;`);
    await sleep(500);
    const syncOff = await cdp.evaluate(`return document.querySelector('#btn-sync')?.textContent ?? ''`);
    console.log(dim(`  已暂停同步生成（按钮显示「${syncOff}」），这样乱打字不会触发真实模型调用`));
  }

  for (let i = 1; i <= ROUNDS; i += 1) {
    const fn = chooseAction();
    let desc = null;
    try {
      // 单步加超时：某个动作万一卡住（比如误触了会调用模型的按钮），
      // 不能让整只猴子挂在这儿 —— 记一笔然后继续。
      desc = await Promise.race([
        fn(cdp),
        sleep(25000).then(() => { throw new Error(`${fn.name} 单步超过 25s 未返回`); }),
      ]);
    } catch (err) {
      violate('动作超时或抛异常', `${fn.name}: ${err.message}`);
      try { await cdp.evaluate(`document.querySelectorAll('.modal:not(.hidden)').forEach((m) => m.classList.add('hidden')); return true;`); } catch { /* ignore */ }
    }
    if (desc) note(desc);
    await sleep(between(60, 180));

    let state = null;
    try {
      state = await cdp.evaluate(INVARIANTS);
    } catch (err) {
      violate('页面求值失败', err.message);
      continue;
    }
    if (state.issues.length) {
      for (const issue of state.issues) {
        violate('界面不变量', issue, {
          layout: state.layout,
          scrollY: state.scrollY,
          docOverflowBy: state.docOverflowBy,
          composerKids: state.composerKids,
          composerBox: state.composerBox,
          editorRows: state.editorRows,
          bodyH: state.bodyH,
          docH: state.scrollH,
          winH: state.win?.[1],
        });
      }
      try {
        const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(SHOTS, `violation-${violations.length}-step${i}.png`), Buffer.from(res.data, 'base64'));
      } catch { /* ignore */ }
      // 同一类问题刷屏没意义，修好一个再看下一个
      if (violations.length > 12) { console.log(dim('  违反次数过多，提前收工')); break; }
    }
    if (!state.issues.length) pass += 1;
    if (VERBOSE) console.log(`  ${dim(`第 ${i}/${ROUNDS} 步 · ${desc ?? '（空动作）'}`)}`);
    if (i % 20 === 0) {
      const health = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
      console.log(`  ${dim(`第 ${i}/${ROUNDS} 步 · 当前操作：${desc ?? '空'} · 服务健康 ${health ? '是' : '否'} · 违规 ${violations.length}`)}`);
      if (!health) violate('服务无响应', '/api/health 请求失败');
    }
  }

  // 收尾：把项目切回去，并清掉还原备份文件
  try {
    await fetch(`${BASE}/api/project`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: originalProject, mode: originalMode }),
    });
    fs.rmSync(originFile, { force: true });
  } catch { /* ignore */ }

  const finalState = await cdp.evaluate(INVARIANTS).catch(() => null);
  console.log(`\n${color(36, '▌结果')}`);
  console.log(`  成功步数 ${color(32, pass)} · 违反次数 ${violations.length ? color(31, violations.length) : 0} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  自动确认的弹窗 ${dialogs} 个 · 页面控制台报错 ${consoleErrors.length} 条`);
  if (consoleErrors.length) for (const e of consoleErrors.slice(0, 6)) console.log(`    · ${e}`);
  if (finalState) console.log(dim(`  收尾布局：${JSON.stringify(finalState.layout)}`));

  const kinds = {};
  for (const v of violations) kinds[v.kind] = (kinds[v.kind] ?? 0) + 1;
  if (violations.length) {
    console.log('\n  违规分类：');
    for (const [k, n] of Object.entries(kinds)) console.log(`    ${k} × ${n}`);
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify({
    at: new Date().toISOString(), url: BASE, seed: SEED, rounds: ROUNDS, withModel: WITH_MODEL,
    pass, dialogs, violations, consoleErrors, finalState,
  }, null, 2)}\n`, 'utf8');
  console.log(`  截图 ${SHOTS}`);
  console.log(`  报告 ${path.join(OUT, 'report.json')}`);

  fail = violations.length;
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.log(`\n${color(31, '猴子测试自身失败：')}${err.message}`);
  console.log(err.stack?.split('\n').slice(1, 5).join('\n'));
  process.exitCode = 2;
} finally {
  if (browser) await browser.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}
