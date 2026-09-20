#!/usr/bin/env node
// SynthFlow UI 自动化测试台
// ---------------------------------------------------------------------------
// 用 CDP（Chrome DevTools Protocol）驱动**真实浏览器**操作页面：
// 点按钮、往输入框打字、读 DOM、截图、抓控制台报错 —— 全部零依赖
// （WebSocket 是 Node 内置的，浏览器是本机已有的 Edge/Chrome）。
//
//   node scripts/uitest.mjs                     跑全套（不花钱，不调模型）
//   node scripts/uitest.mjs --with-model        额外跑需要真实模型的用例（会消耗额度）
//   node scripts/uitest.mjs --headed            显示浏览器窗口（默认无头）
//   node scripts/uitest.mjs --keep-profile      保留浏览器临时目录（排障用）
//   node scripts/uitest.mjs --url http://...    指定被测地址
//
// 截图会存到 .synthflow/uitest/shots/，报告写到 .synthflow/uitest/report.json。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha1 } from '../src/util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const BASE = getArg('url', 'http://127.0.0.1:7788').replace(/\/+$/, '');
const WITH_MODEL = has('with-model');
const HEADED = has('headed');
const KEEP_PROFILE = has('keep-profile');
const OUT = path.join(ROOT, '.synthflow', 'uitest');
const SHOTS = path.join(OUT, 'shots');

const color = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const dim = (s) => color(90, s);

let pass = 0;
let fail = 0;
const failures = [];
const consoleErrors = [];
const t0 = Date.now();

function section(title) {
  console.log(`\n${color(36, `▌${title}`)}`);
}

async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    pass += 1;
    console.log(`  ${color(32, '✓')} ${name} ${dim(`${Date.now() - start}ms`)}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, error: err.message, stack: err.stack });
    console.log(`  ${color(31, '✗')} ${name}\n      ${color(31, err.message)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ 找浏览器 ============================ */

function findBrowser() {
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    : process.platform === 'darwin'
      ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
      : [
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
      ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/* ============================ 极简 CDP 客户端 ============================ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  /** 在页面里求值（支持 await）。 */
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`页面执行出错: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  /** 等页面里的某个条件成立。 */
  async waitFor(expression, { timeout = 15000, label = expression, interval = 120 } = {}) {
    const start = Date.now();
    for (;;) {
      let ok = false;
      try {
        ok = await this.evaluate(`return Boolean(${expression})`);
      } catch { /* 页面还在切换，继续等 */ }
      if (ok) return true;
      if (Date.now() - start > timeout) throw new Error(`等待超时（${timeout}ms）：${label}`);
      await sleep(interval);
    }
  }

  async screenshot(name) {
    try {
      const res = await this.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(res.data, 'base64'));
    } catch { /* 截图失败不影响测试 */ }
  }
}

async function launchBrowser() {
  const exe = findBrowser();
  if (!exe) throw new Error('本机没找到 Edge/Chrome，无法做 UI 测试');
  const profile = path.join(OUT, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  const argv = [
    HEADED ? '--headless=false' : '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1600,1000',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ].filter(Boolean);

  const proc = spawn(exe, argv, { stdio: 'ignore', windowsHide: true });

  // 浏览器会把真实调试端口写进 DevToolsActivePort
  const portFile = path.join(profile, 'DevToolsActivePort');
  const start = Date.now();
  while (!fs.existsSync(portFile)) {
    if (Date.now() - start > 30000) {
      try { proc.kill(); } catch { /* ignore */ }
      throw new Error('浏览器启动超时（没等到 DevToolsActivePort）');
    }
    await sleep(150);
  }
  await sleep(300);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();

  let targets = [];
  for (let i = 0; i < 40; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    try { proc.kill(); } catch { /* ignore */ }
    throw new Error('没有拿到可用的页面 target');
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10000);
  });

  const cdp = new Cdp(ws);
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      consoleErrors.push(text.slice(0, 300));
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(`未捕获异常: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? ''}`.slice(0, 400));
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');

  return {
    cdp,
    async close() {
      try { ws.close(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
      await sleep(600);
      if (!KEEP_PROFILE) {
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  };
}

/* ============================ 页面操作helpers ============================ */

const $click = (sel) => `const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('找不到元素: ' + ${JSON.stringify(sel)}); el.click(); return true;`;

const $text = (sel) => `const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.textContent.trim() : null;`;

/**
 * 可见性判定必须是一个**表达式**（会被包进 Boolean(...) 里求值）。
 * 用 getClientRects() 而不是 offsetParent —— 后者对 position:fixed 的弹窗永远是 null。
 */
const $visible = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  return el.getClientRects().length > 0;
})()`;

/** 往 textarea 里打字（必须派发 input 事件，否则前端收不到）。 */
const $type = (sel, text) => `
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) throw new Error('找不到输入框');
  el.focus();
  el.value = ${JSON.stringify(text)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value.length;
`;

/* ============================ 主流程 ============================ */

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

section('启动浏览器');
const browser = await launchBrowser();
const { cdp } = browser;
console.log(`  ${color(32, '✓')} 已连接 CDP  ${dim(BASE)}`);

try {
  /* ------------------------------ A. 加载 ------------------------------ */
  section('A. 页面加载与渲染');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor(`document.readyState === 'complete'`, { timeout: 20000, label: '页面加载完成' });
  await cdp.waitFor(`document.querySelector('#status-text') && document.querySelector('#status-text').textContent !== '正在连接…'`, { timeout: 20000, label: '前端 boot 完成' });

  await test('页面标题正确', async () => {
    const title = await cdp.evaluate('return document.title');
    if (!/SynthFlow/.test(title)) throw new Error(`标题是「${title}」`);
  });

  await test('没有未捕获异常 / console.error', async () => {
    const bad = consoleErrors.filter((e) => !/favicon|DevTools|Autofill/i.test(e));
    if (bad.length) throw new Error(`控制台报错 ${bad.length} 条：\n      ${bad.slice(0, 3).join('\n      ')}`);
  });

  await test('模型与项目徽标已渲染', async () => {
    const provider = await cdp.evaluate($text('#provider-badge'));
    const project = await cdp.evaluate($text('#project-chip'));
    if (!provider || provider === '模型加载中…') throw new Error(`模型徽标异常：${provider}`);
    if (!project || !project.includes('📁')) throw new Error(`项目徽标异常：${project}`);
  });

  await test('Monaco 编辑器真的起来了', async () => {
    await cdp.waitFor(`document.querySelector('.monaco-editor')`, { timeout: 25000, label: 'Monaco 初始化' });
    const models = await cdp.evaluate('return window.monaco ? monaco.editor.getModels().length : -1');
    if (models < 1) throw new Error(`Monaco 模型数异常：${models}`);
  });

  await test('状态栏显示就绪', async () => {
    const st = await cdp.evaluate($text('#status-text'));
    if (st === '初始化失败') {
      const detail = await cdp.evaluate($text('#status-detail'));
      throw new Error(`初始化失败：${detail}`);
    }
  });
  // 记下进入测试前的项目，最后一定要切回去（否则会把用户的应用留在测试目录上）
  const preState = (await (await fetch(`${BASE}/api/state`)).json()).paths;
  const originalProject = preState.projectDir;
  const originalMode = preState.writeMode === 'direct' ? 'direct' : 'staging';
  console.log(`  ${dim(`当前项目：${originalProject}（${originalMode === 'direct' ? '直接写入' : '暂存确认'}，测试结束会切回）`)}`);

  /**
   * 整个页面不允许出现整体滚动条：一旦文档能滚，顶栏、输入框就可能被滚出视口，
   * 用户会看到"按钮点不到 / 输入框不见了"这种像坏掉的界面。
   * 顺带找出到底是谁把文档撑高的，省得每次靠猜。
   */
  const scrollProbe = async () => cdp.evaluate(`
    const win = [window.innerWidth, window.innerHeight];
    const doc = document.documentElement;
    const over = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.height === 0 && r.width === 0) continue;
      if (r.bottom > win[1] + 1 || r.right > win[0] + 1) {
        const cs = getComputedStyle(el);
        // 只报"真的把文档撑大"的（非 fixed / 非绝对定位脱离流）
        if (cs.position === 'fixed') continue;
        over.push((el.id ? '#' + el.id : el.className ? '.' + String(el.className).split(' ')[0] : el.tagName)
          + ' bottom=' + Math.round(r.bottom) + ' right=' + Math.round(r.right) + ' pos=' + cs.position);
      }
    }
    return { scrollY: Math.round(window.scrollY), win, scrollH: doc.scrollHeight, appH: Math.round(document.querySelector('#app').getBoundingClientRect().height), over: over.slice(0, 8) };
  `);

  await test('★ 页面整体不可滚动（否则顶栏/输入框会被滚出视口）', async () => {
    const p = await scrollProbe();
    if (p.scrollH > p.win[1] + 2) {
      throw new Error(
        `文档高度 ${p.scrollH}px 超过视口 ${p.win[1]}px，页面能整体滚动（当前 scrollY=${p.scrollY}）\n`
        + `      撑高文档的元素：${p.over.length ? p.over.join(' | ') : '（没找到，可能是 margin 塌陷或绝对定位）'}`,
      );
    }
    if (p.scrollY > 0) throw new Error(`页面在启动时就被滚动了：scrollY=${p.scrollY}`);
  });

  await cdp.screenshot('01-boot');

  /* ------------------------------ B. 布局 ------------------------------ */
  section('B. 布局（想法 2 / 14）');

  await test('输入框位于中间栏内部（左右两栏整列贯通）', async () => {
    const inside = await cdp.evaluate(`return Boolean(document.querySelector('main.editor > .composer'))`);
    if (!inside) throw new Error('输入区不在 main.editor 里');
    const { cw, bw } = await cdp.evaluate(`
      const c = document.querySelector('.composer').getBoundingClientRect();
      const b = document.querySelector('.body').getBoundingClientRect();
      return { cw: Math.round(c.width), bw: Math.round(b.width) };
    `);
    if (cw >= bw) throw new Error(`输入区宽度 ${cw} 没有小于整体宽度 ${bw}`);
  });

  await test('版本时间线没有被文件树挤扁（想法 14）', async () => {
    const h = await cdp.evaluate(`return Math.round(document.querySelector('.pane-timeline').getBoundingClientRect().height)`);
    if (h < 100) throw new Error(`时间线高度只有 ${h}px`);
  });

  /* ------------------------------ C. 文件树 ------------------------------ */
  section('C. 文件树（想法 12 / 15）');

  await test('目录可以折叠 / 展开', async () => {
    const hasDir = await cdp.evaluate(`return Boolean(document.querySelector('.tree-dir'))`);
    if (!hasDir) {
      console.log(`      ${dim('（当前工作区没有子目录，跳过）')}`);
      return;
    }
    await cdp.evaluate($click('.tree-dir'));
    const hidden = await cdp.evaluate(`return Boolean(document.querySelector('.tree-dir.collapsed'))`);
    if (!hidden) throw new Error('点击目录后没有进入折叠状态');
    await cdp.evaluate($click('.tree-dir'));
    const back = await cdp.evaluate(`return !document.querySelector('.tree-dir.collapsed')`);
    if (!back) throw new Error('再次点击没有展开');
  });

  await test('点文件能在编辑器里打开（想法 15 按需加载）', async () => {
    const count = await cdp.evaluate(`return document.querySelectorAll('.tree-file').length`);
    if (!count) {
      console.log(`      ${dim('（工作区没有文件，跳过）')}`);
      return;
    }
    // 挑一个"当前没打开"的文件，这样才会真的走一次加载
    const target = await cdp.evaluate(`
      const cur = S.current;
      const rows = [...document.querySelectorAll('.tree-file')];
      const pick = rows.find(r => r.dataset.path !== cur) ?? rows[0];
      return pick.dataset.path;
    `);
    await cdp.evaluate($click(`.tree-file[data-path="${target}"]`));
    await cdp.waitFor(`document.querySelector('#current-path').textContent.includes(${JSON.stringify(target.split('/').pop())})`, { timeout: 10000, label: '文件打开' });
    await cdp.waitFor(`S.current === ${JSON.stringify(target)}`, { timeout: 5000, label: '状态同步' });
    const diag = await cdp.evaluate(`
      const models = window.monaco ? monaco.editor.getModels().map(m => m.uri.path) : [];
      return { mode: Editor.mode, editorPath: Editor.path, models: models.slice(0, 5), modelCount: models.length, codeLen: (document.querySelector('#code')?.textContent ?? '').length };
    `);
    const inMonaco = diag.models.some((p) => p.includes(target));
    const inFallback = diag.mode !== 'monaco' && diag.codeLen > 0;
    if (!inMonaco && !inFallback) {
      throw new Error(`文件没能进编辑器：Editor.mode=${diag.mode} Editor.path=${diag.editorPath} models=[${diag.models.join(', ')}]`);
    }
  });

  /* ------------------------------ D. 焦点 ------------------------------ */
  section('D. 光标纪律（想法 10）');

  await test('自动打开文件后，焦点仍在输入框', async () => {
    // 真正的场景：生成过程中自动跳到某个文件（不是用户点的），焦点不能被抢走
    const other = await cdp.evaluate(`
      const rows = [...document.querySelectorAll('.tree-file')];
      const pick = rows.find(r => r.dataset.path !== S.current) ?? rows[0];
      return pick ? pick.dataset.path : null;
    `);
    if (!other) return;
    const step1 = await cdp.evaluate(`
      document.querySelector('#prompt').focus();
      return { id: document.activeElement.id, tag: document.activeElement.tagName };
    `);
    if (step1.id !== 'prompt') throw new Error(`输入框本身就无法聚焦（activeElement=${step1.tag}）`);
    await cdp.evaluate(`window.__focusTrace = []; document.addEventListener('focusin', e => window.__focusTrace.push((e.target.id || e.target.className || e.target.tagName).toString().slice(0, 40)), true); return true;`);
    await cdp.evaluate(`openFile(${JSON.stringify(other)}, { focus: false }); return true;`);
    await sleep(600);
    const after = await cdp.evaluate(`return { id: document.activeElement.id, tag: document.activeElement.tagName, cls: String(document.activeElement.className || '').slice(0, 60), trace: window.__focusTrace.slice(0, 6) };`);
    if (after.id !== 'prompt') {
      throw new Error(`自动打开后焦点跑到了 <${after.tag}>「${after.cls}」（焦点变化轨迹: ${after.trace.join(' → ')}）`);
    }
  });

  await test('主动点文件时焦点才进入编辑器', async () => {
    const target = await cdp.evaluate(`
      const rows = [...document.querySelectorAll('.tree-file')];
      const pick = rows.find(r => r.dataset.path !== S.current) ?? rows[0];
      return pick ? pick.dataset.path : null;
    `);
    if (!target) return;
    await cdp.evaluate($click(`.tree-file[data-path="${target}"]`));
    await sleep(600);
    const active = await cdp.evaluate('return document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : null');
    const inEditor = await cdp.evaluate(`return Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('.monaco-editor'))`);
    if (!inEditor) throw new Error(`主动点文件后焦点在「${active}」，没有进入编辑器`);
  });

  /* ------------------------------ E. 视图切换 ------------------------------ */
  section('E. 差异 ↔ 代码（想法 9 的回归测试）');

  await cdp.screenshot('02-code-view');

  await test('切到差异视图', async () => {
    const target = await cdp.evaluate(`return document.querySelector('.tree-file')?.dataset.path ?? null`);
    if (!target) return;
    await cdp.evaluate($click('.tree-file[data-path="' + target + '"]'));
    await sleep(400);
    // 直接调用并捕获异常，这样报错里带的是真正的堆栈而不是"等超时"
    const direct = await cdp.evaluate(`
      try { await showDiffView(S.current); return { ok: true }; }
      catch (e) { return { ok: false, err: String(e && e.message || e), stack: String(e && e.stack || '').slice(0, 500) }; }
    `);
    if (!direct.ok) throw new Error(`showDiffView 抛错: ${direct.err}\n      ${direct.stack}`);
    await cdp.waitFor(`(${$visible('#diff-host')}) || (${$visible('#diff-pre')})`, { timeout: 12000, label: '差异视图出现' });
  });

  await test('★ 能切回代码视图（曾经点回去没反应）', async () => {
    await cdp.evaluate(`setView('code'); return true;`);
    await cdp.waitFor(`(${$visible('#editor-host')}) || (${$visible('#code-pre')})`, { timeout: 12000, label: '代码视图恢复' });
    const diffVisible = await cdp.evaluate(`return (${$visible('#diff-host')}) || (${$visible('#diff-pre')})`);
    if (diffVisible) throw new Error('切回代码后差异视图仍然可见');
    const tooltip = await cdp.evaluate($text('#file-meta'));
    if (tooltip && tooltip.includes('对比')) throw new Error(`文件信息还停留在对比文案：${tooltip}`);
  });
  await cdp.screenshot('03-back-to-code');

  /* ------------------------------ F. 同步开关 ------------------------------ */
  section('F. 同步生成开关（想法 1）');

  let genStarts = 0;
  cdp.on('Runtime.consoleAPICalled', () => {});
  await cdp.evaluate(`
    if (!window.__sfProbe) {
      window.__sfProbe = { starts: 0 };
      const es = new EventSource('/api/events');
      es.addEventListener('run:start', () => { window.__sfProbe.starts += 1; });
    }
    return true;
  `);

  await test('点「停止生成」后按钮状态与服务端一致', async () => {
    const before = await (await fetch(`${BASE}/api/state`)).json();
    await cdp.evaluate($click('#btn-stop'));
    await cdp.waitFor(`document.querySelector('#btn-sync').textContent.includes('关')`, { timeout: 8000, label: '按钮切到"关"' });
    let after = null;
    for (let i = 0; i < 20; i += 1) {
      after = await (await fetch(`${BASE}/api/state`)).json();
      if (after.syncEnabled === false) break;
      await sleep(200);
    }
    if (after?.syncEnabled !== false) {
      const texts = await cdp.evaluate(`return { stop: document.querySelector('#btn-stop').textContent.trim(), sync: document.querySelector('#btn-sync').textContent.trim() }`);
      throw new Error(`服务端 syncEnabled 仍为 ${after?.syncEnabled}（按钮：${texts.stop} / ${texts.sync}，点击前 ${before.syncEnabled}）`);
    }
  });

  await test('★ 关闭状态下打字不会触发任何生成', async () => {
    const before = await cdp.evaluate('return window.__sfProbe.starts');
    await cdp.evaluate($type('#prompt', '把首页的标题改成"我的简历"，并加上一句副标题。'));
    await sleep(3200); // 远超过预演延迟(1000ms)+提交延迟(900ms)
    const after = await cdp.evaluate('return window.__sfProbe.starts');
    if (after > before) throw new Error(`关闭后仍然触发了 ${after - before} 次生成`);
    const st = await (await fetch(`${BASE}/api/state`)).json();
    if (st.busy) throw new Error('服务端仍在忙碌');
  });

  await test('点「同步生成」后恢复开启', async () => {
    await cdp.evaluate($click('#btn-sync'));
    await cdp.waitFor(`document.querySelector('#btn-sync').textContent.includes('开')`, { timeout: 8000, label: '按钮切到"开"' });
    const st = await (await fetch(`${BASE}/api/state`)).json();
    if (st.syncEnabled !== true) throw new Error('服务端 syncEnabled 没有被打开');
    // 注意：这里必须保持"开着"，否则后面的生成用例会被自己关掉
  });
  await cdp.screenshot('04-sync-off');

  /* ------------------------------ G. 版本保存 ------------------------------ */
  section('G. 手动保存版本（想法 11）');

  await test('「保存为版本」按钮显眼且可点', async () => {
    const info = await cdp.evaluate(`
      const b = document.querySelector('#btn-save-version');
      const cs = getComputedStyle(b);
      return { text: b.textContent.trim(), visible: b.offsetParent !== null, width: Math.round(b.getBoundingClientRect().width) };
    `);
    if (!info.visible) throw new Error('按钮不可见');
    if (info.width < 90) throw new Error(`按钮太窄（${info.width}px），不够显眼`);
  });

  let versionCountBefore = 0;
  await test('点保存后时间线出现新版本', async () => {
    versionCountBefore = (await (await fetch(`${BASE}/api/versions`)).json()).versions.length;
    await cdp.evaluate($click('#btn-save-version'));
    await sleep(1800);
    const after = (await (await fetch(`${BASE}/api/versions`)).json()).versions.length;
    if (after <= versionCountBefore) throw new Error(`版本数没变（${versionCountBefore} → ${after}）`);
  });

  await test('回退按钮状态正确', async () => {
    const disabled = await cdp.evaluate(`return document.querySelector('#btn-undo').disabled`);
    if (disabled) throw new Error('已经有多个版本了，回退按钮却是禁用状态');
  });

  /* ------------------------------ H. 项目选择 ------------------------------ */
  section('H. 目录选择弹窗（想法 7）');

  await test('点项目名会打开目录浏览器', async () => {
    await cdp.evaluate($click('#project-chip'));
    await cdp.waitFor($visible('#picker-modal'), { timeout: 8000, label: '选择器出现' });
    await cdp.waitFor(`document.querySelector('#picker-path').value.length > 0`, { timeout: 8000, label: '路径已加载' });
    const info = await cdp.evaluate(`return { path: document.querySelector('#picker-path').value, dirs: document.querySelectorAll('#picker-list .picker-item').length, hint: document.querySelector('#picker-hint').textContent };`);
    if (!info.path) throw new Error('路径输入框是空的');
    if (info.dirs === 0) throw new Error('没有列出任何子目录');
  });

  await test('★ 选择器按钮可用（曾因绑定时机问题全是死的）', async () => {
    const first = await cdp.evaluate(`return document.querySelector('#picker-list .picker-item')?.dataset.dir ?? null`);
    if (!first) return;
    await cdp.evaluate(`document.querySelector('#picker-list .picker-item').click(); return true;`);
    await cdp.waitFor(`document.querySelector('#picker-path').value === ${JSON.stringify(first)}`, { timeout: 8000, label: '进入子目录' });
    // 「上一级」必须真的能回去
    await cdp.evaluate($click('#picker-up'));
    await cdp.waitFor(`document.querySelector('#picker-path').value !== ${JSON.stringify(first)}`, { timeout: 8000, label: '返回上一级' });
  });

  await cdp.screenshot('05-picker');
  await test('关闭选择器', async () => {
    await cdp.evaluate($click('#picker-close'));
    await cdp.waitFor(`!(${$visible('#picker-modal')})`, { timeout: 5000, label: '选择器关闭' });
  });

  /* ------------------------------ I. 提示词工具 ------------------------------ */
  section('I. 提示词整合 / 导入 / 导出（想法 5 / 6）');

  await test('导出会生成 .md 下载', async () => {
    const dl = path.join(OUT, 'downloads');
    fs.mkdirSync(dl, { recursive: true });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true }).catch(() => {});
    await cdp.evaluate($type('#prompt', '导出测试：把首页标题改成"我的简历"。'));
    await cdp.evaluate($click('#btn-export'));
    await sleep(1500);
    const files = fs.existsSync(dl) ? fs.readdirSync(dl) : [];
    if (!files.some((f) => f.endsWith('.md'))) throw new Error(`下载目录里没有 .md：${files.join(', ') || '(空)'}`);
    const content = fs.readFileSync(path.join(dl, files.find((f) => f.endsWith('.md'))), 'utf8');
    if (!content.includes('导出测试')) throw new Error('导出的文件里没有提示词内容');
  });

  await test('导入 .md 会追加到输入框', async () => {
    const src = path.join(OUT, 'import-test.md');
    fs.writeFileSync(src, '---\ntitle: 测试\n---\n\n把项目里的联系方式换成我的新邮箱。\n', 'utf8');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
    if (!nodeId) throw new Error('找不到文件输入元素');
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [src] });
    await cdp.waitFor(`document.querySelector('#prompt').value.includes('新邮箱')`, { timeout: 8000, label: '导入内容出现' });
    const value = await cdp.evaluate(`return document.querySelector('#prompt').value`);
    if (value.includes('title: 测试')) throw new Error('frontmatter 没有被剥掉');
  });

  /* ------------------------------ J. 思考栏上限 ------------------------------ */
  section('J. 思考栏长度上限（想法 8）');

  await test('超过上限时出现提示条与两个按钮', async () => {
    const origin = await (await fetch(`${BASE}/api/config`)).json();
    const old = origin.config.streamLimitKB ?? 1024;
    // 直接伪造"已经很大"，避免真的塞 1MB 文本进 DOM
    await cdp.evaluate(`
      window.__sfRealBytes = streamBytes;
      window.streamBytes = () => 4 * 1024 * 1024;
      checkStreamLimit();
      return true;
    `);
    await cdp.waitFor($visible('#stream-limit'), { timeout: 6000, label: '上限提示条出现' });
    const info = await cdp.evaluate(`return { text: document.querySelector('#stream-limit-text').textContent, hasCompress: Boolean(document.querySelector('#btn-stream-compress')), hasClear: Boolean(document.querySelector('#btn-stream-clear')) }`);
    if (!info.hasCompress || !info.hasClear) throw new Error('缺少压缩/清空按钮');
    if (!/MB/.test(info.text)) throw new Error(`提示文案异常：${info.text}`);
    await cdp.evaluate(`
      window.streamBytes = window.__sfRealBytes;
      checkStreamLimit();
      return true;
    `);
    await cdp.waitFor(`!(${$visible('#stream-limit')})`, { timeout: 5000, label: '提示条收起' });
  });

  await test('压缩历史能把老轮次折叠起来', async () => {
    const rounds = await cdp.evaluate(`return document.querySelectorAll('#stream-body .stream-run').length`);
    if (rounds < 4) {
      console.log(`      ${dim(`（当前只有 ${rounds} 轮，压缩只对第 4 轮以前生效，跳过）`)}`);
      return;
    }
    await cdp.evaluate(`compressStream(); return true;`);
    await sleep(300);
    const compressed = await cdp.evaluate(`return document.querySelectorAll('#stream-body .opblock.compressed').length`);
    if (compressed === 0) throw new Error('没有轮次被压缩');
  });

  /* ------------------------------ K. 定位索引 ------------------------------ */
  section('K. 页面/组件定位（想法 4）');

  await test('定位接口能给出候选文件', async () => {
    const q = await cdp.evaluate(`return document.querySelector('#current-path')?.textContent ?? ''`);
    const word = String(q).split('/').pop().replace(/\.\w+$/, '');
    if (!word) {
      console.log(`      ${dim('（没有打开的文件，跳过）')}`);
      return;
    }
    const res = await (await fetch(`${BASE}/api/locate?q=${encodeURIComponent(word)}`)).json();
    if (!res.hits?.length) {
      console.log(`      ${dim(`（「${word}」没命中任何文件，属于正常情况，跳过）`)}`);
      return;
    }
    if (!res.hits[0].file) throw new Error('定位结果缺少文件路径');
  });

  /* ------------------------------ L. 设置面板 ------------------------------ */
  section('L. 设置面板与配置档（想法 5/6/8）');

  await test('设置面板能打开且五个分页都在', async () => {
    await cdp.evaluate($click('#btn-settings'));
    await cdp.waitFor($visible('#settings-modal'), { timeout: 8000, label: '设置面板打开' });
    const tabs = await cdp.evaluate(`return document.querySelectorAll('#settings-modal [data-tab]').length`);
    if (tabs < 5) throw new Error(`只有 ${tabs} 个分页`);
  });

  await test('配置档列表已渲染', async () => {
    const rows = await cdp.evaluate(`return document.querySelectorAll('#pf-list .pf-row').length`);
    if (rows < 1) throw new Error('没有渲染出任何配置档');
  });

  await test('★ 模型可选（下拉清单）+ 可手填，并有推理强度选择', async () => {
    await cdp.evaluate(`document.querySelector('#settings-modal [data-tab="model"]').click(); return true;`);
    await sleep(300);
    const info = await cdp.evaluate(`
      const row = document.querySelector('#pf-list .pf-row');
      if (!row) return { error: '没有配置档行' };
      const model = row.querySelector('.pf-model');
      const dl = model ? document.querySelector('#' + model.getAttribute('list')) : null;
      const effort = row.querySelector('.pf-effort');
      return {
        hasModelInput: Boolean(model),
        modelValue: model?.value ?? '',
        datalistId: model?.getAttribute('list') ?? null,
        options: dl ? [...dl.querySelectorAll('option')].map((o) => o.value) : [],
        hasEffort: Boolean(effort),
        effortValue: effort?.value ?? null,
        effortOptions: effort ? [...effort.options].map((o) => o.value) : [],
        hint: row.querySelector('.pf-hint')?.textContent?.trim() ?? '',
      };
    `);
    if (info.error) throw new Error(info.error);
    if (!info.hasModelInput) throw new Error('没有模型输入框');
    if (!info.datalistId) throw new Error('模型输入框没挂 datalist —— 那样就只能手打，选不了');
    // 当前生效的服务商是 deepseek，清单里必须给出实测存在的那两个模型
    if (info.options.length) {
      if (!info.options.includes('deepseek-flash')) throw new Error(`模型清单里没有 deepseek-flash：${info.options.join(',')}`);
      if (!info.options.includes('deepseek-v4-pro')) throw new Error(`模型清单里没有 deepseek-v4-pro：${info.options.join(',')}`);
    } else {
      throw new Error('模型清单是空的 —— 用户没法在 flash / pro 之间选');
    }
    if (!info.hasEffort) throw new Error('没有推理强度选择框');
    const need = ['none', 'low', 'medium', 'high', 'max'];
    if (JSON.stringify(info.effortOptions) !== JSON.stringify(need)) {
      throw new Error(`强度选项不对：${info.effortOptions.join(',')}（应为 ${need.join(',')}）`);
    }
    console.log(`      ${dim(`模型清单 ${info.options.join('/')} · 当前 ${info.modelValue} · 强度 ${info.effortOptions.join('/')} · 现值 ${info.effortValue}`)}`);
  });

  await test('★ 顶栏显示当前模型与推理强度（这两件事决定速度和质量，不该藏起来）', async () => {
    const badge = await cdp.evaluate(`return { text: document.querySelector('#provider-badge')?.textContent?.trim() ?? '', title: document.querySelector('#provider-badge')?.title ?? '' };`);
    if (!/deepseek/i.test(badge.text)) throw new Error(`顶栏没显示模型：${badge.text}`);
    if (!/思考|不思考/.test(badge.text)) throw new Error(`顶栏没显示推理强度：${badge.text}`);
    if (!badge.title) throw new Error('徽标没有 title 说明');
    console.log(`      ${dim(`顶栏徽标：${badge.text}`)}`);
  });

  await test('改推理强度会真的写进配置（切回原值）', async () => {
    const before = await (await fetch(`${BASE}/api/state`)).json();
    const origEffort = before.provider.reasoningEffort;
    const next = origEffort === 'high' ? 'low' : 'high';
    await cdp.evaluate(`
      const row = document.querySelector('#pf-list .pf-row');
      const eff = row.querySelector('.pf-effort');
      eff.value = ${JSON.stringify(next)};
      eff.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);
    await sleep(900);
    const after = await (await fetch(`${BASE}/api/state`)).json();
    if (after.provider.reasoningEffort !== next) {
      throw new Error(`选了 ${next}，服务端却是 ${after.provider.reasoningEffort}`);
    }
    if (!after.provider.note.includes(next === 'high' ? '高' : '低')) {
      throw new Error(`provider.note 没跟着更新：${after.provider.note}`);
    }
    // 还原
    await cdp.evaluate(`
      const row = document.querySelector('#pf-list .pf-row');
      const eff = row.querySelector('.pf-effort');
      eff.value = ${JSON.stringify(origEffort)};
      eff.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);
    await sleep(800);
    console.log(`      ${dim(`强度 ${origEffort} → ${next} → ${origEffort}，服务端每次都跟上`)}`);
  });

  await test('技能面板可打开编辑器', async () => {
    await cdp.evaluate(`document.querySelector('#settings-modal [data-tab="skills"]').click(); return true;`);
    await sleep(350);
    const diag1 = await cdp.evaluate(`
      const pane = document.querySelector('[data-pane="skills"]');
      const activeTab = document.querySelector('#settings-modal .tab-btn.active');
      return { paneCls: pane ? pane.className : 'MISSING', rects: pane ? pane.getClientRects().length : -1, activeTab: activeTab ? activeTab.dataset.tab : null, display: pane ? getComputedStyle(pane).display : null };
    `);
    if (diag1.rects === 0 || diag1.display === 'none') {
      throw new Error(`技能分页没有显示（activeTab=${diag1.activeTab} class=${diag1.paneCls} display=${diag1.display}）`);
    }
    await cdp.evaluate($click('#sk-new'));
    await sleep(350);
    const diag = await cdp.evaluate(`return { cls: document.querySelector('#sk-editor').className, rects: document.querySelector('#sk-editor').getClientRects().length }`);
    if (diag.cls.includes('hidden') || diag.rects === 0) throw new Error(`技能编辑器没有出现（class=${diag.cls} rects=${diag.rects}）`);
  });

  await cdp.screenshot('06-settings');
  await test('关闭设置面板', async () => {
    await cdp.evaluate($click('#cfg-close'));
    await cdp.waitFor(`!(${$visible('#settings-modal')})`, { timeout: 5000, label: '设置关闭' });
  });

  /* ------------------------------ M. 主题与布局 ------------------------------ */
  section('M. 主题与布局自定义（想法 7 第三轮）');

  await test('主题可以在 亮/暗 之间切换', async () => {
    await cdp.evaluate($click('#btn-theme'));
    await sleep(400);
    const t1 = await cdp.evaluate(`return document.documentElement.dataset.theme`);
    await cdp.evaluate($click('#btn-theme'));
    await sleep(400);
    const t2 = await cdp.evaluate(`return document.documentElement.dataset.theme`);
    if (t1 === t2) throw new Error(`切换主题没有生效（都是 ${t1}）`);
    await cdp.evaluate(`applyTheme('dark'); return true;`);
  });

  await test('布局面板可改字号并生效', async () => {
    await cdp.evaluate($click('#btn-layout'));
    await cdp.waitFor($visible('#layout-panel'), { timeout: 6000, label: '布局面板打开' });
    await cdp.evaluate(`
      const el = document.querySelector('#ly-font-code');
      el.value = '15';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(300);
    const fs2 = await cdp.evaluate(`return getComputedStyle(document.documentElement).getPropertyValue('--font-size-code').trim()`);
    if (fs2 !== '15px') throw new Error(`代码字号没有生效：${fs2}`);
    await cdp.evaluate($click('#ly-reset'));
    await cdp.evaluate($click('#btn-layout'));
  });

  /* ------------------------------ N. 面板隐藏 ------------------------------ */
  section('N. 面板显示/隐藏');

  await test('可以隐藏左侧栏并恢复', async () => {
    await cdp.evaluate(`Layout.set('showSidebar', false); return true;`);
    await sleep(200);
    const hidden = await cdp.evaluate(`return getComputedStyle(document.querySelector('.sidebar')).display === 'none'`);
    if (!hidden) throw new Error('左侧栏没有隐藏');
    await cdp.evaluate(`Layout.set('showSidebar', true); return true;`);
    await sleep(200);
    const back = await cdp.evaluate(`return getComputedStyle(document.querySelector('.sidebar')).display !== 'none'`);
    if (!back) throw new Error('左侧栏没有恢复');
  });

  /* ------------------------------ P. 视觉合理性 ------------------------------ */
  section('P. 视觉合理性（不需要人眼，防布局回归）');

  await test('没有横向溢出（不会出现奇怪的横向滚动条）', async () => {
    const info = await cdp.evaluate(`
      return {
        docW: document.documentElement.scrollWidth,
        winW: window.innerWidth,
        bodyW: Math.round(document.body.scrollWidth),
      };
    `);
    if (info.docW > info.winW + 2) throw new Error(`页面横向溢出：内容 ${info.docW}px > 视口 ${info.winW}px`);
  });

  await test('三栏宽度都为正且加起来不超过视口', async () => {
    const info = await cdp.evaluate(`
      const w = (s) => { const el = document.querySelector(s); return el ? Math.round(el.getBoundingClientRect().width) : 0; };
      return { sidebar: w('.sidebar'), editor: w('.editor'), stream: w('.stream'), win: window.innerWidth };
    `);
    if (info.editor <= 0) throw new Error(`编辑区宽度为 0：${JSON.stringify(info)}`);
    if (info.sidebar + info.editor + info.stream > info.win + 12) throw new Error(`三栏加起来超出视口：${JSON.stringify(info)}`);
  });

  await test('关键控件都在视口内（没有被挤出去）', async () => {
    const probe = await cdp.evaluate(`
      const sels = ['#prompt', '#btn-commit', '#btn-stop', '#btn-sync', '#btn-save-version', '#file-tree', '#timeline', '#stream-body'];
      const out = [];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) { out.push(s + ':缺失'); continue; }
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) out.push(s + ':尺寸异常 ' + Math.round(r.width) + 'x' + Math.round(r.height));
        else if (r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight) out.push(s + ':跑出视口');
      }
      const rect = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom), Math.round(r.height)]; };
      return {
        out,
        win: [window.innerWidth, window.innerHeight],
        scroll: [Math.round(window.scrollY), document.documentElement.scrollTop, document.body.scrollTop],
        docH: [document.documentElement.scrollHeight, Math.round(document.querySelector('#app').getBoundingClientRect().height)],
        topbar: rect('.topbar'),
        body: rect('.body'),
        editor: rect('main.editor'),
        codeWrap: rect('.code-wrap'),
        composer: rect('.composer'),
        modeChip: rect('#mode-chip'),
      };
    `);
    if (probe.out.length) throw new Error(`${probe.out.join('；')}\n      现场：${JSON.stringify(probe)}`);
  });

  await test('输入区高度符合布局变量（设定值是下限，内容更高时盒子自己长）', async () => {
    const info = await cdp.evaluate(`
      const box = document.querySelector('.composer');
      const h = Math.round(box.getBoundingClientRect().height);
      const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--composer-h'), 10);
      return { h, v, scrollH: box.scrollHeight, clientH: box.clientHeight };
    `);
    // 设定值是"至少这么高"：内容更高时盒子必须长起来，否则工具行会被压到输入框上
    if (info.h < info.v - 6) throw new Error(`输入区高度 ${info.h}px 低于设定值 ${info.v}px`);
    if (info.scrollH > info.clientH + 2) {
      throw new Error(`输入区内容溢出了 ${info.scrollH - info.clientH}px（控件会互相重叠）`);
    }
  });

  /* ------------------------------ O. 需要模型的用例 ------------------------------ */
  if (WITH_MODEL) {
    section('O. 真实生成链路（会消耗额度）');
    await test('打字停顿 → 预演 → 落盘 → 建议', async () => {
      // 保险：确保同步生成是开着的（前面的用例可能把它关过）
      const st0 = await (await fetch(`${BASE}/api/state`)).json();
      if (st0.syncEnabled === false) {
        await cdp.evaluate($click('#btn-sync'));
        await sleep(400);
      }
      const before = await cdp.evaluate('return window.__sfProbe.starts');
      await cdp.evaluate($type('#prompt', '在 frontend/src/utils 下新建一个 sayHello.ts，导出一个 sayHello(name) 函数，返回中文问候语。'));
      await cdp.waitFor(`window.__sfProbe.starts > ${before}`, { timeout: 40000, label: '生成启动' });
      await cdp.waitFor(`!document.querySelector('#run-badge').textContent.includes('正在')`, { timeout: 180000, label: '生成结束' });
      const rounds = await cdp.evaluate(`return document.querySelectorAll('#stream-body .stream-run').length`);
      if (rounds < 1) throw new Error('思考栏里没有轮次块');
      const suggestions = await cdp.evaluate(`return document.querySelectorAll('#stream-body .suggestion').length`);
      if (suggestions < 1) throw new Error('本轮没有产生任何建议卡片');
      const after = await (await fetch(`${BASE}/api/state`)).json();
      if (!after.unsaved) throw new Error('生成完了却没有出现"未保存的改动"（想法 11 的手动模型）');
    });
    await cdp.screenshot('07-generated');
  } else {
    section('O. 真实生成链路');
    console.log(`  ${dim('已跳过（加 --with-model 才会真实调用模型）')}`);
  }

  /* ------------------------------ Q. 切换项目全流程 ------------------------------ */
  section('Q. 切换项目全流程（用户报的"卡在选择目录页面"）');

  await test('点项目名打开选择器，上下级导航正常', async () => {
    await cdp.evaluate($click('#project-chip'));
    await cdp.waitFor($visible('#picker-modal'), { timeout: 8000, label: '选择器出现' });
    await cdp.waitFor(`document.querySelector('#picker-path').value.length > 0`, { timeout: 8000, label: '路径加载' });
    const start = await cdp.evaluate(`return { path: document.querySelector('#picker-path').value, items: document.querySelectorAll('#picker-list .picker-item').length }`);
    if (start.items === 0) throw new Error(`选择器里没有列出任何子目录（当前 ${start.path}）`);
    await cdp.evaluate(`document.querySelector('#picker-list .picker-item').click(); return true;`);
    await cdp.waitFor(`document.querySelector('#picker-path').value !== ${JSON.stringify(start.path)}`, { timeout: 8000, label: '进入子目录' });
    const inside = await cdp.evaluate(`return document.querySelector('#picker-path').value`);
    if (inside === start.path) throw new Error('点目录没有进入下一级');
    await cdp.evaluate($click('#picker-up'));
    await cdp.waitFor(`document.querySelector('#picker-path').value === ${JSON.stringify(start.path)}`, { timeout: 8000, label: '返回上一级' });
  });

  await test('★ 输入路径 → 切换项目（必须秒回、弹窗自动关闭、界面重置）', async () => {
    // 用一个"文件很多但不是项目"的目录来验切换速度。取本仓库的上一级 ——
    // 它是跨平台的，不写死盘符。
    const target = path.dirname(ROOT);
    await cdp.evaluate(`
      const el = document.querySelector('#picker-path');
      el.value = ${JSON.stringify(target)};
      return true;
    `);
    // 先往输入框和思考栏里塞点东西，验证切换后会被清掉（想法 13）
    await cdp.evaluate($type('#prompt', '这是切换前残留的提示词'));
    const t0 = Date.now();
    await cdp.evaluate($click('#picker-use'));
    await cdp.waitFor(`document.querySelector('#picker-modal').classList.contains('hidden')`, { timeout: 30000, label: '选择器自动关闭' });
    const ms = Date.now() - t0;
    if (ms > 15000) throw new Error(`切换用了 ${ms}ms，太久（用户会以为卡死）`);

    try {
      const wantName = path.basename(target);
      await cdp.waitFor(`document.querySelector('#project-chip').textContent.includes(${JSON.stringify(wantName)})`, { timeout: 15000, label: '项目徽标更新' });
    } catch (err) {
      const diag = await cdp.evaluate(`
        return {
          chip: document.querySelector('#project-chip').textContent,
          clientDir: S.projectDir,
          status: document.querySelector('#status-text').textContent + ' / ' + document.querySelector('#status-detail').textContent,
          streamLen: document.querySelector('#stream-body').textContent.length,
        };
      `);
      throw new Error(`${err.message}｜诊断: ${JSON.stringify(diag)}｜控制台: ${consoleErrors.slice(-2).join(' | ') || '无'}`);
    }
    const st = await (await fetch(`${BASE}/api/state`)).json();
    if (st.paths.projectDir !== target) throw new Error(`服务端项目没切过去：${st.paths.projectDir}`);

    const after = await cdp.evaluate(`
      return {
        prompt: document.querySelector('#prompt').value,
        stream: document.querySelector('#stream-body').textContent.trim().slice(0, 40),
        files: document.querySelectorAll('.tree-file').length,
        status: document.querySelector('#status-text').textContent,
      };
    `);
    if (after.prompt.includes('残留')) throw new Error('切换后输入框还留着上一个项目的内容');
    if (after.stream.includes('残留')) throw new Error('切换后思考栏还留着上一个项目的内容');
    if (after.files === 0) throw new Error('切换后文件树是空的');
    console.log(`      ${dim(`切换耗时 ${ms}ms，新项目 ${after.files} 个文件，状态栏「${after.status}」`)}`);
  });
  await cdp.screenshot('08-switched');

  await test('★ 切到盘符根目录会给出警告而不是报错', async () => {
    // 盘符根目录：Windows 是 D:\，类 Unix 是 /。用 path.parse 推出来，不写死。
    const rootDir = path.parse(ROOT).root;
    await cdp.evaluate($click('#project-chip'));
    await cdp.waitFor($visible('#picker-modal'), { timeout: 8000, label: '选择器出现' });
    await cdp.evaluate(`document.querySelector('#picker-path').value = ${JSON.stringify(rootDir)}; return true;`);
    // 会弹 confirm，先自动点掉
    await cdp.evaluate(`window.__sfOrigConfirm = window.confirm; window.confirm = () => true; return true;`);
    const t0 = Date.now();
    await cdp.evaluate($click('#picker-use'));
    await cdp.waitFor(`document.querySelector('#picker-modal').classList.contains('hidden')`, { timeout: 40000, label: '选择器关闭' });
    const ms = Date.now() - t0;
    await cdp.evaluate(`window.confirm = window.__sfOrigConfirm; return true;`);
    const st = await (await fetch(`${BASE}/api/state`)).json();
    if (st.paths.projectDir !== rootDir) throw new Error(`没切到 ${rootDir}（实际 ${st.paths.projectDir}）`);
    if (ms > 20000) throw new Error(`切根目录用了 ${ms}ms`);
    console.log(`      ${dim(`${rootDir} 切换耗时 ${ms}ms，${st.workspace.files} 个文件`)}`);
  });

  await test('切回原项目', async () => {
    const r = await fetch(`${BASE}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: originalProject, mode: 'staging' }),
    });
    const res = await r.json();
    if (!res.ok) throw new Error(`切回失败：${res.error ?? ''}`);
    await cdp.waitFor(`document.querySelector('#company-chip') === null`, { timeout: 3000, label: 'x' }).catch(() => {});
    await cdp.waitFor(`document.querySelector('#project-chip').textContent.length > 0`, { timeout: 10000, label: '界面恢复' });
    console.log(`      ${dim(`已切回 ${res.projectDir}（${res.fileCount} 个文件）`)}`);
  });

  /* --------------------- R. 直接写入模式（用户报"为什么还要我点应用"） --------------------- */
  section('R. 直接写入模式（用户报"代码生成后还要我点应用到项目"）');

  const directProj = path.join(OUT, 'directproj');
  fs.rmSync(directProj, { recursive: true, force: true });
  fs.mkdirSync(directProj, { recursive: true });

  await test('★ 切到直接写入：状态位显示"直接写入"，待应用条完全消失', async () => {
    const r = await fetch(`${BASE}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: directProj, mode: 'direct' }),
    });
    const res = await r.json();
    if (!res.ok) throw new Error(`切换到直接写入失败：${res.error ?? ''}`);
    // 这一段正是用户踩的坑：配置里写了 direct，服务端却仍是 staging
    if (res.writeMode !== 'direct') throw new Error(`服务端写入方式没有生效：${res.writeMode}`);
    if (res.staging) throw new Error('直接写入模式下 workspace.staging 仍为 true —— 改动又会进暂存层');
    await cdp.waitFor(`document.querySelector('#mode-chip').textContent.includes('直接写入')`, {
      timeout: 10000,
      label: '写入方式状态位更新',
    });
    const hidden = await cdp.evaluate($visible('#pending-bar'));
    if (hidden) throw new Error('直接写入模式下仍然显示了"应用到项目"那条栏 —— 用户会以为还得自己点一下');
  });

  await test('★ 直接写入模式下点状态位可切回暂存，再点回来（不用去设置页）', async () => {
    await cdp.evaluate(`window.__sfOrigConfirm = window.confirm; window.confirm = () => true; return true;`);
    try {
      await cdp.evaluate($click('#mode-chip'));
      await cdp.waitFor(`document.querySelector('#mode-chip').textContent.includes('暂存')`, { timeout: 10000, label: '切到暂存确认' });
      await cdp.waitFor($visible('#pending-bar'), { timeout: 8000, label: '暂存模式下出现待应用栏' });
      await cdp.evaluate($click('#mode-chip'));
      await cdp.waitFor(`document.querySelector('#mode-chip').textContent.includes('直接写入')`, { timeout: 10000, label: '切回直接写入' });
      await cdp.waitFor(`!(${$visible('#pending-bar')})`, { timeout: 8000, label: '待应用栏重新隐藏' });
    } finally {
      await cdp.evaluate(`window.confirm = window.__sfOrigConfirm; return true;`);
    }
  });

  await test('★ 直接写入模式：生成完文件立刻在项目目录里，没有待应用', async () => {
    // 这一条不依赖模型也能验：直接调用一次真实的写入接口，
    // 确认落盘位置就是项目目录，而不是暂存层。
    const res = await (await fetch(`${BASE}/api/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'direct-probe.txt', content: 'direct mode probe\n' }),
    })).json();
    if (!res.ok) throw new Error(`保存失败：${res.error ?? ''}`);
    const onDisk = path.join(directProj, 'direct-probe.txt');
    if (!fs.existsSync(onDisk)) throw new Error(`文件没有出现在项目目录：${onDisk}`);
    const pending = await (await fetch(`${BASE}/api/pending`)).json();
    if (pending.items.length) throw new Error(`直接写入模式下不该有待应用改动，实际 ${pending.items.length} 个`);
    if (pending.staging) throw new Error('/api/pending 仍报告 staging=true');
    const hidden = await cdp.evaluate($visible('#pending-bar'));
    if (hidden) throw new Error('生成后"应用到项目"栏又冒出来了');
  });

  if (WITH_MODEL) {
    await test('★ 真实生成：直接写入模式下代码同步进项目目录，无需点击（消耗额度）', async () => {
      const before = await cdp.evaluate('return window.__sfProbe.starts');
      await cdp.evaluate($type('#prompt', '在当前目录新建一个 direct-check.md，里面只写一行：直接写入模式生效。'));
      await cdp.waitFor(`window.__sfProbe.starts > ${before}`, { timeout: 45000, label: '生成启动' });
      await cdp.waitFor(`!document.querySelector('#run-badge').textContent.includes('正在')`, { timeout: 180000, label: '生成结束' });
      const st = await (await fetch(`${BASE}/api/state`)).json();
      if (st.paths.writeMode !== 'direct') throw new Error('生成过程中写入方式被改掉了');
      const files = fs.readdirSync(directProj);
      if (!files.length) throw new Error('生成完之后项目目录里一个文件都没有 —— 又写进暂存层了');
      const hidden = await cdp.evaluate($visible('#pending-bar'));
      if (hidden) throw new Error('生成后出现了"应用到项目"，与直接写入模式矛盾');
      const status = await cdp.evaluate($text('#status-text'));
      const detail = await cdp.evaluate($text('#status-detail'));
      // 用户现场就是这里踩的：文件明明写对了，状态栏却红着「出错了」
      if (status === '出错了') throw new Error(`生成成功但状态栏报错：${detail}`);
      const badge = await cdp.evaluate($text('#run-badge'));
      if (badge.includes('出错')) throw new Error(`运行徽标显示「${badge}」，说明这轮抛了异常`);
      console.log(`      ${dim(`项目目录：${files.join('、')} · 状态栏「${status}」`)}`);
    });

    await test('★ 时间线里出现"未保存的每一轮"，⏪ 可以按轮回退（想法 4 的补充）', async () => {
      const st = await (await fetch(`${BASE}/api/state`)).json();
      const rounds = st.unsaved?.rounds ?? [];
      if (!rounds.length) throw new Error('生成了一轮，但 unsaved.rounds 是空的 —— 时间线又只显示已保存版本了');
      // 时间线上应该画出来
      await cdp.waitFor(`document.querySelectorAll('#timeline .timeline-item.unsaved').length > 0`, {
        timeout: 8000,
        label: '时间线出现未保存轮次',
      });
      const info = await cdp.evaluate(`
        return {
          sep: document.querySelector('#timeline .timeline-sep')?.textContent?.trim() ?? '',
          unsaved: document.querySelectorAll('#timeline .timeline-item.unsaved').length,
          undoDisabled: document.querySelector('#btn-undo')?.disabled,
        };
      `);
      if (!info.sep.includes('未保存')) throw new Error(`时间线分隔标签不对：${info.sep}`);
      if (info.undoDisabled) throw new Error('有未保存轮次时 ⏪ 不该被禁用（它现在能按轮回退）');
      console.log(`      ${dim(`时间线：${info.sep} · ${info.unsaved} 个可回退轮次 · ⏪ 可用`)}`);

      // 真的按一次，验证它退的是"一轮"而不是整个版本
      const before = (await (await fetch(`${BASE}/api/state`)).json()).unsaved?.rounds?.length ?? 0;
      await cdp.evaluate($click('#btn-undo'));
      await sleep(900);
      const after = (await (await fetch(`${BASE}/api/state`)).json()).unsaved?.rounds?.length ?? 0;
      if (after >= before) throw new Error(`点了 ⏪ 之后未保存轮次从 ${before} 变成 ${after}，没有回退`);
      console.log(`      ${dim(`点一次 ⏪：未保存轮次 ${before} → ${after}`)}`);
    });
    await cdp.screenshot('09-direct-write');
  }

  /* ---------- S. 布局手感（用户第四轮反馈的 1/2/3 条） ---------- */
  section('S. 布局手感：文件树缩进 / 拖动灵敏度 / 滑块下限');

  const layoutProj = path.join(OUT, 'layoutproj');
  fs.rmSync(layoutProj, { recursive: true, force: true });
  // 造一个 8 层深的目录，专门用来验"深目录会不会把侧栏撑爆"
  const deepRel = 'a/b/c/d/e/f/g/h/deep-file.js';
  fs.mkdirSync(path.join(layoutProj, path.dirname(deepRel)), { recursive: true });
  fs.writeFileSync(path.join(layoutProj, deepRel), 'export const deep = 1;\n', 'utf8');
  fs.writeFileSync(path.join(layoutProj, 'top.js'), 'export const top = 1;\n', 'utf8');

  await test('切到布局测试项目', async () => {
    const r = await fetch(`${BASE}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: layoutProj, mode: 'direct' }),
    });
    const res = await r.json();
    if (!res.ok) throw new Error(`切换失败：${res.error ?? ''}`);
    await sleep(600);
  });

  await test('★ 8 层深目录不会把文件树撑爆（缩进每级只算一次）', async () => {
    // 先把左侧栏恢复成默认宽度，别受前面用例影响
    await cdp.evaluate(`
      document.querySelector('#layout-panel')?.classList.remove('hidden');
      const el = document.querySelector('#ly-sidebar');
      el.value = 260; el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#layout-panel').classList.add('hidden');
      return true;
    `);
    await sleep(400);
    // 把所有折叠的目录逐轮点开，直到没有新的展开为止
    for (let pass = 0; pass < 12; pass += 1) {
      const clicked = await cdp.evaluate(`
        let n = 0;
        for (const d of document.querySelectorAll('#file-tree .tree-dir.collapsed')) { d.click(); n += 1; }
        return n;
      `);
      if (!clicked) break;
      await sleep(160);
    }
    const info = await cdp.evaluate(`
      const tree = document.querySelector('#file-tree');
      const items = [...tree.querySelectorAll('.tree-item')];
      const deepest = items.map((el) => ({ left: Math.round(el.getBoundingClientRect().left), name: el.querySelector('.name')?.textContent ?? '', nameW: Math.round((el.querySelector('.name')?.getBoundingClientRect().width) ?? 0) }))
        .sort((a, b) => b.left - a.left)[0];
      return { treeW: Math.round(tree.getBoundingClientRect().width), deepest, count: items.length, scrollW: tree.scrollWidth, clientW: tree.clientWidth };
    `);
    if (info.count < 9) throw new Error(`目录没有展开完整，只有 ${info.count} 项（期望 ≥9）`);
    // 最深一行的左边缘不能吃掉大半侧栏
    if (info.deepest.left > info.treeW * 0.55) {
      throw new Error(`8 层深目录的左边缘到了 ${info.deepest.left}px（文件树只有 ${info.treeW}px），文件名会被挤没`);
    }
    if (info.treeW - info.deepest.left < 60) {
      throw new Error(`最深一行只剩 ${info.treeW - info.deepest.left}px 放文件名，太窄`);
    }
    if (info.scrollW > info.clientW + 4) throw new Error(`文件树出现了横向滚动（${info.scrollW} > ${info.clientW}）`);
    console.log(`      ${dim(`树宽 ${info.treeW}px · 最深项 left=${info.deepest.left}px · 名字「${info.deepest.name}」`)}`);
  });

  await test('★ 拖动分栏线：拖多少就变多少（不是平方级放大）', async () => {
    const dragBy = async (sel, dx) => {
      const box = await cdp.evaluate(`
        const el = document.querySelector(${JSON.stringify(sel)});
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      `);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
      for (let i = 1; i <= 5; i += 1) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + (dx * i) / 5, y: box.y, button: 'left', buttons: 1 });
        await sleep(20);
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + dx, y: box.y, button: 'left', buttons: 0 });
      await sleep(120);
    };
    const width = () => cdp.evaluate(`return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10)`);

    const before = await width();
    await dragBy('#split-left', 40);
    const after40 = await width();
    const delta1 = after40 - before;
    if (Math.abs(delta1 - 40) > 14) {
      throw new Error(`拖 40px，左侧栏实际变了 ${delta1}px —— 拖动应该是 1:1 的（以前每帧都把累计位移再加一遍，会越拖越快）`);
    }
    // 再拖一次，验证不会"越拖越快"
    await dragBy('#split-left', 40);
    const after80 = await width();
    const delta2 = after80 - after40;
    if (Math.abs(delta2 - 40) > 14) throw new Error(`第二次拖 40px 实际变了 ${delta2}px，说明位移在累加`);
    console.log(`      ${dim(`左侧栏 ${before} → ${after40} → ${after80}（两次各拖 40px）`)}`);

    // 输入区的分界线：往下拖 = 输入区变矮
    const h = () => cdp.evaluate(`return Math.round(document.querySelector('.composer').getBoundingClientRect().height)`);
    const h0 = await h();
    const box = await cdp.evaluate(`
      const r = document.querySelector('#split-composer').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    `);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 5; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y - (30 * i) / 5, button: 'left', buttons: 1 });
      await sleep(20);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y - 30, button: 'left', buttons: 0 });
    await sleep(150);
    const h1 = await h();
    if (h1 - h0 < 15) throw new Error(`把输入区分界线往上拖 30px，输入区只从 ${h0} 变成 ${h1}（往上拖应该变高）`);
    console.log(`      ${dim(`输入区 ${h0} → ${h1}（分界线往上拖 30px）`)}`);
  });

  await test('★ 输入区拉到最小时，工具行不会和输入框重叠', async () => {
    await cdp.evaluate(`
      document.querySelector('#layout-panel')?.classList.remove('hidden');
      const el = document.querySelector('#ly-composer');
      el.value = el.min; el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(300);
    const geo = await cdp.evaluate(`
      const p = document.querySelector('#prompt').getBoundingClientRect();
      const t = document.querySelector('.prompt-tools').getBoundingClientRect();
      const c = document.querySelector('.composer');
      const box = c.getBoundingClientRect();
      const cs = getComputedStyle(document.documentElement).getPropertyValue('--composer-h');
      let over = 0; let who = '';
      for (const el of c.querySelectorAll('*')) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.position === 'absolute') continue;
        const r = el.getBoundingClientRect();
        if (r.height === 0) continue;
        const d = Math.round(r.bottom - box.bottom);
        if (d > over) { over = d; who = el.className || el.id; }
      }
      return { overlap: Math.round(p.bottom - t.top), composerVar: cs, composerH: Math.round(box.height), over, who };
    `);
    if (geo.overlap > 1) throw new Error(`输入框和工具行重叠了 ${geo.overlap}px（输入区 ${geo.composerVar}）`);
    if (geo.over > 1) throw new Error(`输入区里有元素（${geo.who}）超出底边 ${geo.over}px`);
    console.log(`      ${dim(`输入区设为 ${geo.composerVar} 时实际高 ${geo.composerH}px，无重叠`)}`);
  });

  await test('滑块下限本身就是安全的（不用靠 CSS 兜底）', async () => {
    const mins = await cdp.evaluate(`
      return {
        sidebar: Number(document.querySelector('#ly-sidebar').min),
        stream: Number(document.querySelector('#ly-stream').min),
        composer: Number(document.querySelector('#ly-composer').min),
      };
    `);
    if (mins.composer < 200) throw new Error(`输入区滑块的 min=${mins.composer}，内容需要 201px，拉到底就会挤在一起`);
    if (mins.sidebar < 100) throw new Error(`左侧栏滑块 min=${mins.sidebar} 太小`);
    if (mins.stream < 120) throw new Error(`思考栏滑块 min=${mins.stream} 太小`);
    console.log(`      ${dim(`滑块下限：左侧栏 ${mins.sidebar} / 思考栏 ${mins.stream} / 输入区 ${mins.composer}`)}`);
  });

  /* --------------------- S2. 文件树/时间线分界线 + 滚轮调尺寸 --------------------- */

  const panes = () => cdp.evaluate(`
    const h = (s) => Math.round(document.querySelector(s).getBoundingClientRect().height);
    return {
      tree: h('.pane-tree'),
      timeline: h('.pane-timeline'),
      split: h('#split-tree'),
      sidebar: h('.sidebar'),
    };
  `);

  await test('★ 文件树与版本时间线之间的分界线可以拖动（且是 1:1，不是越拖越快）', async () => {
    // 先把布局恢复默认，别受前面用例影响
    await cdp.evaluate(`Layout.reset(); return true;`);
    await sleep(400);
    const before = await panes();
    if (before.split <= 0) throw new Error('找不到那条分界线（#split-tree 高度为 0）');
    if (before.tree < 100) throw new Error(`文件树初始高度异常：${before.tree}px`);

    const box = await cdp.evaluate(`
      const r = document.querySelector('#split-tree').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    `);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 5; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y + (80 * i) / 5, button: 'left', buttons: 1 });
      await sleep(20);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y + 80, button: 'left', buttons: 0 });
    await sleep(300);

    const after = await panes();
    const delta = after.tree - before.tree;
    if (Math.abs(delta - 80) > 14) {
      throw new Error(`往下拖 80px，文件树实际变了 ${delta}px —— 拖动应该是 1:1 的`);
    }
    // 时间线要让出空间，而不是两栏互不相关
    if (Math.abs((before.timeline - after.timeline) - 80) > 20) {
      throw new Error(`文件树长了 ${delta}px，时间线只让出 ${before.timeline - after.timeline}px`);
    }
    console.log(`      ${dim(`文件树 ${before.tree} → ${after.tree}（拖 80px）· 时间线 ${before.timeline} → ${after.timeline}`)}`);
  });

  await test('★ 分界线上可以直接滚轮调（连滚多格都要有效）', async () => {
    // 这里有个固有矛盾：滚一格，分界线自己就移动了，光标立刻不在它上面了。
    // 所以实现里做了"短暂接管窗口滚轮"（leash），这条用例专门守住它 —— 只响应第一格是不合格的。
    const before = await panes();
    const box = await cdp.evaluate(`
      const r = document.querySelector('#split-tree').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    `);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(150);
    for (let i = 0; i < 3; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -120 });
      await sleep(160);
    }
    const after = await panes();
    const grew = after.tree - before.tree;
    if (grew < 20) throw new Error(`连滚 3 格，文件树只长了 ${grew}px —— 多半只响应了第一格`);
    // 往下滚应该收回去
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 120 });
    await sleep(300);
    const back = await panes();
    if (back.tree >= after.tree) throw new Error('往下滚没有把文件树改小');
    console.log(`      ${dim(`滚轮：${before.tree} →（上滚 3 格）${after.tree} →（下滚 1 格）${back.tree}`)}`);
  });

  await test('★ 布局面板的滑块支持滚轮（不用先精确点中圆点）', async () => {
    await cdp.evaluate(`document.querySelector('#layout-panel')?.classList.remove('hidden'); return true;`);
    await sleep(300);
    const before = await cdp.evaluate(`
      const el = document.querySelector('#ly-tree');
      const r = el.getBoundingClientRect();
      return { value: Number(el.value), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    `);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y });
    await sleep(120);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0, deltaY: -120 });
    await sleep(350);
    const after = await cdp.evaluate(`
      const el = document.querySelector('#ly-tree');
      return {
        value: Number(el.value),
        label: document.querySelector('#ly-tree-val')?.textContent?.trim() ?? '',
        cssVar: getComputedStyle(document.documentElement).getPropertyValue('--tree-h').trim(),
        paneTree: Math.round(document.querySelector('.pane-tree').getBoundingClientRect().height),
      };
    `);
    if (after.value <= before.value) throw new Error(`滚轮没有改变滑块值：${before.value} → ${after.value}`);
    if (!after.label.startsWith(String(after.value))) throw new Error(`数值标签没跟着更新：滑块=${after.value} 标签=${after.label}`);
    // 不能只是滑块动了，实际布局也要跟着动
    if (Math.abs(after.paneTree - after.value) > 4) {
      throw new Error(`滑块=${after.value} 但文件树实际高度=${after.paneTree}，布局没跟上`);
    }
    console.log(`      ${dim(`滑块滚轮 ${before.value} → ${after.value}，文件树实际 ${after.paneTree}px（--tree-h=${after.cssVar}）`)}`);
  });

  await test('★ 把分界线拖到极限时，时间线不会被挤没', async () => {
    const r = await cdp.evaluate(`
      const keep = Layout.s.treePane;
      Layout.set('treePane', 100000);
      const out = {
        stored: Layout.s.treePane,
        cssVar: getComputedStyle(document.documentElement).getPropertyValue('--tree-h').trim(),
        paneTree: Math.round(document.querySelector('.pane-tree').getBoundingClientRect().height),
        paneTimeline: Math.round(document.querySelector('.pane-timeline').getBoundingClientRect().height),
        sidebar: Math.round(document.querySelector('.sidebar').getBoundingClientRect().height),
      };
      Layout.set('treePane', keep);
      return out;
    `);
    if (r.paneTimeline < 100) throw new Error(`文件树拉到极限后时间线只剩 ${r.paneTimeline}px，等于被挤没了`);
    if (r.paneTree + r.paneTimeline > r.sidebar + 8) {
      throw new Error(`两栏加起来 ${r.paneTree + r.paneTimeline}px 超过了侧栏 ${r.sidebar}px —— 说明溢出了`);
    }
    console.log(`      ${dim(`拉到极限：文件树 ${r.paneTree}px + 时间线 ${r.paneTimeline}px = ${r.paneTree + r.paneTimeline}px（侧栏 ${r.sidebar}px）`)}`);
  });

  await test('清理布局测试项目并切回', async () => {
    const r = await fetch(`${BASE}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: originalProject, mode: originalMode }),
    });
    const res = await r.json();
    if (!res.ok) throw new Error(`切回失败：${res.error ?? ''}`);
    fs.rmSync(layoutProj, { recursive: true, force: true });
    const slug = `${path.basename(layoutProj).replace(/[^\w-]/g, '') || 'project'}-${sha1(layoutProj).slice(0, 8)}`;
    fs.rmSync(path.join(ROOT, '.synthflow', 'projects', slug), { recursive: true, force: true });
    await cdp.waitFor(`document.querySelector('#project-chip').textContent.length > 0`, { timeout: 10000, label: '界面恢复' });
  });

  await test('切回原项目并恢复原来的写入方式', async () => {
    const r = await fetch(`${BASE}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: originalProject, mode: originalMode }),
    });
    const res = await r.json();
    if (!res.ok) throw new Error(`切回失败：${res.error ?? ''}`);
    if (res.writeMode !== originalMode) throw new Error(`写入方式没有恢复：期望 ${originalMode}，实际 ${res.writeMode}`);
    await cdp.waitFor(`document.querySelector('#project-chip').textContent.length > 0`, { timeout: 10000, label: '界面恢复' });
    // 测试目录和它的项目数据（快照/会话/暂存）都要清掉，不能留在用户磁盘上
    fs.rmSync(directProj, { recursive: true, force: true });
    const slug = `${path.basename(directProj).replace(/[^\w-]/g, '') || 'project'}-${sha1(directProj).slice(0, 8)}`;
    fs.rmSync(path.join(ROOT, '.synthflow', 'projects', slug), { recursive: true, force: true });
    console.log(`      ${dim(`已切回 ${res.projectDir}（${res.writeMode === 'direct' ? '直接写入' : '暂存确认'}）`)}`);
  });

  /* ---------- T. 版本链：删除 / 切项目时不被旧项目污染 ---------- */
  section('T. 版本链：删除版本 / 切项目后时间线必须跟着走');

  const verProj = path.join(OUT, 'verproj');
  const verProj2 = path.join(OUT, 'verproj2');
  for (const d of [verProj, verProj2]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'seed.js'), 'export const seed = 1;\n', 'utf8');
  }

  await test('切到版本测试项目并造出 3 个版本', async () => {
    const r = await fetch(`${BASE}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: verProj, mode: 'direct' }),
    });
    const res = await r.json();
    if (!res.ok) throw new Error(`切换失败：${res.error ?? ''}`);
    for (let i = 1; i <= 3; i += 1) {
      await fetch(`${BASE}/api/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: `v${i}.js`, content: `export const v${i} = ${i};\n` }),
      });
    }
    await sleep(800);
    const ids = await cdp.evaluate(`return [...document.querySelectorAll('#timeline .timeline-item')].map((li) => (li.textContent.trim().match(/^v\\d+/) ?? [''])[0]).filter(Boolean)`);
    if (ids.length < 4) throw new Error(`时间线只有 ${ids.length} 个版本：${ids.join(',')}`);
    console.log(`      ${dim(`造出 ${ids.join(', ')}`)}`);
  });

  await test('★ 每个版本都有删除按钮，基线没有', async () => {
    const info = await cdp.evaluate(`
      const items = [...document.querySelectorAll('#timeline .timeline-item')];
      return items.map((li) => ({
        text: li.querySelector('b')?.textContent?.trim() ?? '',
        hasDel: Boolean(li.querySelector('.tl-del')),
      }));
    `);
    const baseline = info.find((x) => x.text === 'v0');
    const others = info.filter((x) => x.text !== 'v0' && /^v\d+$/.test(x.text));
    if (!baseline) throw new Error('时间线里没有 v0 基线');
    if (baseline.hasDel) throw new Error('基线版本不该有删除按钮（删了就没有退回起点了）');
    if (!others.length) throw new Error('没有可删除的版本');
    if (others.some((x) => !x.hasDel)) throw new Error(`这些版本缺删除按钮：${others.filter((x) => !x.hasDel).map((x) => x.text).join(',')}`);
    console.log(`      ${dim(`${others.length} 个版本有删除按钮，基线没有`)}`);

    // 删除按钮默认淡显（0.35），悬停/聚焦时变实。
    // 注意：无头浏览器里用 Input.dispatchMouseEvent 移动鼠标**不一定**能触发 :hover，
    // 所以这里用 CDP 的 CSS.forcePseudoState 强制 :hover —— 验证的是 CSS 规则本身，
    // 而不是"CDP 能不能模拟鼠标"。
    const box = await cdp.evaluate(`
      const items = [...document.querySelectorAll('#timeline .timeline-item')];
      const hit = items.find((li) => /^v\\d+$/.test(li.querySelector('b')?.textContent?.trim() ?? ''));
      if (!hit) return null;
      hit.scrollIntoView({ block: 'center' });
      const r = hit.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    `);
    if (box) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await sleep(200);
      const before = await cdp.evaluate(`
        const btns = [...document.querySelectorAll('#timeline .tl-del')];
        const visible = btns.filter((b) => b.getClientRects().length > 0);
        return { total: btns.length, visible: visible.length, opacity: visible.length ? Number(getComputedStyle(visible[0]).opacity) : null };
      `);
      if (!before.visible) throw new Error('删除按钮一个都看不见（应该常驻淡显，否则用户发现不了这个功能）');

      // 强制 :hover，确认淡显会变实
      await cdp.send('CSS.enable').catch(() => {});
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '#timeline .timeline-item' });
      for (const nodeId of nodeIds) {
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] }).catch(() => {});
      }
      await sleep(250);
      const after = await cdp.evaluate(`
        const btn = [...document.querySelectorAll('#timeline .tl-del')].find((b) => b.getClientRects().length > 0);
        return btn ? Number(getComputedStyle(btn).opacity) : null;
      `);
      await cdp.screenshot('10-version-delete');
      if (after !== null && after <= before.opacity) {
        throw new Error(`悬停后删除按钮没有变实：${before.opacity} → ${after}`);
      }
    }
  });

  await test('★ 删掉一个版本：时间线上消失，服务端也少了它', async () => {
    const before = await (await fetch(`${BASE}/api/versions`)).json();
    const target = before.versions[before.versions.length - 1].id; // 删最后一个（就是当前版本）
    const beforeCount = before.versions.length;

    await cdp.evaluate(`
      window.__sfOrigConfirm2 = window.confirm; window.confirm = () => true;
      const items = [...document.querySelectorAll('#timeline .timeline-item')];
      const hit = items.find((li) => li.querySelector('b')?.textContent?.trim() === ${JSON.stringify(target)});
      if (!hit) throw new Error('时间线上找不到 ' + ${JSON.stringify(target)});
      hit.querySelector('.tl-del').click();
      return true;
    `);
    await sleep(1200);
    await cdp.evaluate(`window.confirm = window.__sfOrigConfirm2; return true;`);

    const after = await (await fetch(`${BASE}/api/versions`)).json();
    if (after.versions.length !== beforeCount - 1) {
      throw new Error(`服务端版本数没减：${beforeCount} → ${after.versions.length}`);
    }
    if (after.versions.some((v) => v.id === target)) throw new Error(`${target} 还在服务端的版本链里`);
    const domIds = await cdp.evaluate(`return [...document.querySelectorAll('#timeline .timeline-item')].map((li) => (li.textContent.trim().match(/^v\\d+/) ?? [''])[0]).filter(Boolean)`);
    const serverIds = after.versions.map((v) => v.id);
    if (JSON.stringify(domIds) !== JSON.stringify(serverIds)) {
      throw new Error(`删完之后时间线和服务端对不上：DOM ${domIds.join(',')} vs 服务端 ${serverIds.join(',')}`);
    }
    if (domIds.includes(target)) throw new Error(`${target} 还留在时间线上`);
    console.log(`      ${dim(`删掉 ${target}：${beforeCount} → ${after.versions.length} 个版本，界面一致`)}`);
  });

  await test('基线仍然删不掉（服务端会拒绝）', async () => {
    const r = await fetch(`${BASE}/api/version/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'v0' }),
    });
    const res = await r.json();
    if (res.ok) throw new Error('基线版本竟然被删掉了');
    if (!/基线/.test(res.error ?? '')) throw new Error(`拒绝理由不明确：${res.error}`);
  });

  if (WITH_MODEL) {
    await test('★ 生成途中切项目：界面必须停在新项目（用户报"时间线还是旧的"）', async () => {
      // 这正是用户踩的坑：切项目时旧的 Runner 没被停，它跑完那一轮后
      // 把旧项目的 state/tree/versions 又广播一遍，把刚重置好的界面整个覆盖回去。
      const r = await fetch(`${BASE}/api/project`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: verProj, mode: 'direct' }),
      });
      if (!(await r.json()).ok) throw new Error('切到 verProj 失败');
      await sleep(900);
      const verVersions = (await (await fetch(`${BASE}/api/versions`)).json()).versions.map((v) => v.id);

      // 在 verProj 里发起一轮真实生成
      await cdp.evaluate($type('#prompt', '在项目里新建一个 switching.md，写一行"切换测试"。'));
      await sleep(1200);
      await cdp.evaluate($click('#btn-commit'));
      await sleep(700);
      const busy = (await (await fetch(`${BASE}/api/state`)).json()).busy;

      // ★ 生成还没结束就切到另一个项目
      const r2 = await fetch(`${BASE}/api/project`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: verProj2, mode: 'direct' }),
      });
      if (!(await r2.json()).ok) throw new Error('切到 verProj2 失败');
      await sleep(1200);

      const check = async (tag) => {
        const st = await (await fetch(`${BASE}/api/state`)).json();
        const dom = await cdp.evaluate(`
          return {
            title: document.querySelector('#project-chip')?.textContent?.trim() ?? '',
            ids: [...document.querySelectorAll('#timeline .timeline-item')].map((li) => (li.textContent.trim().match(/^v\\d+/) ?? [''])[0]).filter(Boolean),
            tree: [...document.querySelectorAll('#file-tree .tree-file .name')].map((n) => n.textContent.trim()),
          };
        `);
        const serverIds = st.versions.versions.map((v) => v.id);
        if (JSON.stringify(dom.ids) !== JSON.stringify(serverIds)) {
          throw new Error(`[${tag}] 时间线没跟着项目走：DOM ${dom.ids.join(',')} vs 服务端 ${serverIds.join(',')}`);
        }
        if (!dom.title.includes('verproj2')) throw new Error(`[${tag}] 项目徽标还是旧的：${dom.title}`);
        if (dom.tree.some((n) => n.includes('switching.md'))) {
          throw new Error(`[${tag}] 文件树里混进了旧项目刚生成的文件：${dom.tree.join(',')}`);
        }
        return { ids: dom.ids, title: dom.title };
      };

      const t0 = Date.now();
      let last = null;
      // 持续盯 12 秒：覆盖"旧项目那一轮跑完"的时间点
      while (Date.now() - t0 < 12000) {
        last = await check(`切后 ${Date.now() - t0}ms`);
        await sleep(1500);
      }
      console.log(`      ${dim(`busy=${busy} · 全程稳定在 ${last.title}（${last.ids.length} 个版本）`)}`);
    });
  }

  await test('清理版本测试项目并切回', async () => {
    const r = await fetch(`${BASE}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: originalProject, mode: originalMode }),
    });
    const res = await r.json();
    if (!res.ok) throw new Error(`切回失败：${res.error ?? ''}`);
    for (const d of [verProj, verProj2]) {
      fs.rmSync(d, { recursive: true, force: true });
      const slug = `${path.basename(d).replace(/[^\w-]/g, '') || 'project'}-${sha1(d).slice(0, 8)}`;
      fs.rmSync(path.join(ROOT, '.synthflow', 'projects', slug), { recursive: true, force: true });
    }
    await cdp.waitFor(`document.querySelector('#project-chip').textContent.length > 0`, { timeout: 10000, label: '界面恢复' });
  });

  /* ---------- U. 切到空白项目：工作区必须真的清空（用户报"代码区不刷新"） ---------- */
  section('U. 切到空白项目后工作区必须真的清空');

  const fullProj = path.join(OUT, 'fullproj');
  const blankProj = path.join(OUT, 'blankproj');
  fs.rmSync(fullProj, { recursive: true, force: true });
  fs.rmSync(blankProj, { recursive: true, force: true });
  fs.mkdirSync(path.join(fullProj, 'src'), { recursive: true });
  fs.mkdirSync(blankProj, { recursive: true });
  fs.writeFileSync(path.join(fullProj, 'src', 'kept.js'), 'export const kept = "旧项目的文件";\n', 'utf8');
  fs.writeFileSync(path.join(fullProj, 'README.md'), '# 旧项目\n', 'utf8');

  const switchTo = async (dir) => {
    const r = await fetch(`${BASE}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, mode: 'direct' }),
    });
    const res = await r.json();
    if (!res.ok) throw new Error(`切换失败：${res.error ?? ''}`);
    await sleep(900);
  };

  await test('★ 切到空白项目后，代码区/路径栏/标签页全部清空（不能留着旧项目的文件）', async () => {
    // 用户报的原话："切到新的一个空白项目后，工作面板的代码区域不会刷新"
    // 根因：applyReset 只清了降级用的 <code> 元素、把 Editor.path 置空，
    // 但**从没调用 renderCode()**，Monaco 实例仍挂着旧项目的 model ——
    // 于是旧文件原样显示，"空项目提示"和 Monaco 面板还同时可见。
    await switchTo(fullProj);
    await cdp.evaluate(`
      const f = [...document.querySelectorAll('#file-tree .tree-file')].find((n) => n.dataset.path === 'src/kept.js');
      if (f) f.click();
      return true;
    `);
    await sleep(900);

    const before = await cdp.evaluate(`
      return {
        path: document.querySelector('#current-path')?.textContent?.trim() ?? '',
        hostVisible: document.querySelector('#editor-host')?.getClientRects().length > 0,
      };
    `);
    if (!before.path.includes('kept.js')) throw new Error(`前置条件不成立：没能打开旧项目的文件（path=${before.path}）`);
    if (!before.hostVisible) throw new Error('前置条件不成立：Monaco 面板没显示');

    // ★ 切到空白项目
    await switchTo(blankProj);

    const after = await cdp.evaluate(`
      const vis = (sel) => { const e = document.querySelector(sel); return Boolean(e && e.getClientRects().length > 0); };
      const M = window.monaco;
      const editing = (M && window.Editor && window.Editor.inst) ? (window.Editor.inst.getModel()?.getValue() ?? '') : '';
      return {
        hostVisible: vis('#editor-host'),
        emptyVisible: vis('#editor-empty'),
        path: document.querySelector('#current-path')?.textContent?.trim() ?? '',
        tabs: document.querySelectorAll('#tabs .tab').length,
        treeFiles: document.querySelectorAll('#file-tree .tree-file').length,
        editing,
        sCurrent: (typeof S !== 'undefined') ? S.current : 'x',
      };
    `);
    if (after.hostVisible) throw new Error('代码区还显示着 Monaco 面板 —— 切到空白项目后应该藏起来');
    if (!after.emptyVisible) throw new Error('没有显示"还没选文件"的空态提示');
    if (after.path !== '未选择文件') throw new Error(`路径栏还写着旧路径：${after.path}`);
    if (after.tabs !== 0) throw new Error(`标签页没清空，还剩 ${after.tabs} 个`);
    if (after.treeFiles !== 0) throw new Error(`文件树没清空，还剩 ${after.treeFiles} 个文件`);
    if (after.sCurrent !== null) throw new Error(`S.current 没清空：${after.sCurrent}`);
    if (after.editing.includes('旧项目的文件')) throw new Error('★ Monaco 里还留着旧项目文件的内容');
    console.log(`      ${dim(`切到空白项目：Monaco 已隐藏、路径栏=${after.path}、标签 0、文件树 0`)}`);
  });

  await test('★ 空白项目里能正常创建文件（用户报"无法创建文件目录"）', async () => {
    await switchTo(blankProj);
    const before = await cdp.evaluate(`return window.__sfProbeWire === true`);
    if (!before) {
      await cdp.evaluate(`
        window.__sfProbeWire = true;
        window.__sfProbeStarts = 0;
        window.addEventListener('sf:run:start', () => { window.__sfProbeStarts += 1; });
        return true;
      `);
    }
    const n0 = await cdp.evaluate(`return window.__sfProbeStarts ?? 0`);
    await cdp.evaluate($type('#prompt', '在当前项目新建 src/fresh.js，导出 const fresh = 1。'));
    await sleep(1300);
    await cdp.evaluate($click('#btn-commit'));
    await cdp.waitFor(`(window.__sfProbeStarts ?? 0) > ${n0}`, { timeout: 40000, label: '生成启动' });
    await cdp.waitFor(`!document.querySelector('#run-badge').textContent.includes('正在')`, { timeout: 180000, label: '生成结束' });
    await sleep(1500);

    const onDisk = fs.existsSync(path.join(blankProj, 'src')) ? fs.readdirSync(path.join(blankProj, 'src')) : [];
    if (!onDisk.length) throw new Error('空白项目里生成之后，磁盘上什么都没创建 —— 这就是用户说的"无法创建文件"');
    const st = await cdp.evaluate(`
      return {
        treeFiles: [...document.querySelectorAll('#file-tree .tree-file .name')].map((n) => n.textContent.trim()),
        path: document.querySelector('#current-path')?.textContent?.trim() ?? '',
        status: document.querySelector('#status-text')?.textContent?.trim() ?? '',
      };
    `);
    if (!st.treeFiles.length) throw new Error('文件创建了，但文件树没更新 —— 用户会以为没创建成功');
    if (st.status === '出错了') throw new Error(`创建过程报错了：${await cdp.evaluate($text('#status-detail'))}`);
    console.log(`      ${dim(`磁盘: ${onDisk.join(', ')} · 文件树: ${st.treeFiles.join(', ')} · 编辑器路径: ${st.path}`)}`);
  });

  await test('清理空白项目测试并切回', async () => {
    const r = await fetch(`${BASE}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: originalProject, mode: originalMode }),
    });
    const res = await r.json();
    if (!res.ok) throw new Error(`切回失败：${res.error ?? ''}`);
    for (const d of [fullProj, blankProj]) {
      fs.rmSync(d, { recursive: true, force: true });
      const slug = `${path.basename(d).replace(/[^\w-]/g, '') || 'project'}-${sha1(d).slice(0, 8)}`;
      fs.rmSync(path.join(ROOT, '.synthflow', 'projects', slug), { recursive: true, force: true });
    }
    await cdp.waitFor(`document.querySelector('#project-chip').textContent.length > 0`, { timeout: 10000, label: '界面恢复' });
  });

  /* ------------------------------ 收尾 ------------------------------ */
  section('收尾');
  // 无论中间成功失败，都要把项目切回测试前的状态，别把用户的应用留在测试目录上
  try {
    const cur = (await (await fetch(`${BASE}/api/state`)).json()).paths.projectDir;
    if (cur !== originalProject) {
      const r = await fetch(`${BASE}/api/project`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: originalProject, mode: originalMode }),
      });
      const j = await r.json();
      console.log(`  ${j.ok ? color(32, '✓') : color(31, '✗')} 项目已切回 ${j.projectDir ?? cur}${j.error ? ` (${j.error})` : ''}`);
      await sleep(500);
    } else {
      console.log(`  ${color(32, '✓')} 项目未被改动：${cur}`);
    }
  } catch (err) {
    console.log(`  ${color(31, '✗')} 切回项目失败：${err.message}`);
  }

  console.log(`\n  通过 ${color(32, pass)} / 失败 ${fail ? color(31, fail) : 0} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const data = {
    at: new Date().toISOString(),
    url: BASE,
    pass,
    fail,
    ms: Date.now() - t0,
    consoleErrors,
    failures,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`  截图   ${SHOTS}`);
  console.log(`  报告   ${path.join(OUT, 'report.json')}`);
  if (fail) {
    console.log('\n失败详情：');
    for (const f of failures) console.log(`\n▌${f.name}\n  ${f.error}`);
  }
  if (consoleErrors.length) {
    console.log(`\n页面控制台报错 ${consoleErrors.length} 条：`);
    for (const e of consoleErrors.slice(0, 5)) console.log(`  · ${e}`);
  }
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
}
