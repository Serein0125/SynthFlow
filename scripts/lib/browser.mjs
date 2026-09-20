// 极简 CDP 客户端 + 浏览器启动器。
// uitest.mjs 与 monkey.mjs 共用这一份，避免两套 CDP 样板各自跑偏。
//
// 为什么不用 Puppeteer：装了就要下几百 MB 的 Chromium，而本机已经有 Edge；
// CDP 本身就是 WebSocket + JSON 协议，Node 内置 WebSocket 就够用。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export class Cdp {
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

  /** 在页面里求值（会把表达式包成 async 立即执行函数，支持 await）。 */
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
}

/**
 * 启动本机已有的 Edge/Chrome，返回 { cdp, close() }。
 * @param {{profileDir:string, headed?:boolean, keepProfile?:boolean, windowSize?:string, onConsoleError?:(text:string)=>void}} opts
 */
export async function launchBrowser(opts) {
  const {
    profileDir,
    headed = false,
    keepProfile = false,
    windowSize = '1600,1000',
    onConsoleError = () => {},
  } = opts;
  const exe = findBrowser();
  if (!exe) throw new Error('本机没找到 Edge/Chrome，无法做浏览器测试');
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const argv = [
    headed ? '--headless=false' : '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    `--window-size=${windowSize}`,
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ];

  const proc = spawn(exe, argv, { stdio: 'ignore', windowsHide: true });

  const portFile = path.join(profileDir, 'DevToolsActivePort');
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
      onConsoleError(text.slice(0, 300));
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    onConsoleError(`未捕获异常: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? ''}`.slice(0, 400));
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
      if (!keepProfile) {
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  };
}
