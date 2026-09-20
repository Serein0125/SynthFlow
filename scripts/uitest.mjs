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
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
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
  const originalProject = (await (await fetch(`${BASE}/api/state`)).json()).paths.projectDir;
  console.log(`  ${dim(`当前项目：${originalProject}（测试结束会切回）`)}`);
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
    const bad = await cdp.evaluate(`
      const sels = ['#prompt', '#btn-commit', '#btn-stop', '#btn-sync', '#btn-save-version', '#file-tree', '#timeline', '#stream-body'];
      const out = [];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) { out.push(s + ':缺失'); continue; }
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) out.push(s + ':尺寸异常 ' + Math.round(r.width) + 'x' + Math.round(r.height));
        else if (r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight) out.push(s + ':跑出视口');
      }
      return out;
    `);
    if (bad.length) throw new Error(bad.join('；'));
  });

  await test('输入区高度符合布局变量', async () => {
    const info = await cdp.evaluate(`
      const h = Math.round(document.querySelector('.composer').getBoundingClientRect().height);
      const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--composer-h'), 10);
      return { h, v };
    `);
    if (Math.abs(info.h - info.v) > 6) throw new Error(`输入区高度 ${info.h}px 与 --composer-h ${info.v}px 不符`);
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
    const target = 'D:\\ProgramData';
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
      await cdp.waitFor(`document.querySelector('#project-chip').textContent.includes('ProgramData')`, { timeout: 15000, label: '项目徽标更新' });
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
    await cdp.evaluate($click('#project-chip'));
    await cdp.waitFor($visible('#picker-modal'), { timeout: 8000, label: '选择器出现' });
    await cdp.evaluate(`document.querySelector('#picker-path').value = 'D:\\\\'; return true;`);
    // 会弹 confirm，先自动点掉
    await cdp.evaluate(`window.__sfOrigConfirm = window.confirm; window.confirm = () => true; return true;`);
    const t0 = Date.now();
    await cdp.evaluate($click('#picker-use'));
    await cdp.waitFor(`document.querySelector('#picker-modal').classList.contains('hidden')`, { timeout: 40000, label: '选择器关闭' });
    const ms = Date.now() - t0;
    await cdp.evaluate(`window.confirm = window.__sfOrigConfirm; return true;`);
    const st = await (await fetch(`${BASE}/api/state`)).json();
    if (st.paths.projectDir !== 'D:\\') throw new Error(`没切到 D:\\（实际 ${st.paths.projectDir}）`);
    if (ms > 20000) throw new Error(`切盘符根目录用了 ${ms}ms`);
    console.log(`      ${dim(`D:\\ 切换耗时 ${ms}ms，${st.workspace.files} 个文件`)}`);
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

  /* ------------------------------ 收尾 ------------------------------ */
  section('收尾');
  // 无论中间成功失败，都要把项目切回测试前的状态，别把用户的应用留在测试目录上
  try {
    const cur = (await (await fetch(`${BASE}/api/state`)).json()).paths.projectDir;
    if (cur !== originalProject) {
      const r = await fetch(`${BASE}/api/project`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: originalProject, mode: 'staging' }),
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
