// 为 README 生成一套**中性演示项目**上的截图（不含任何真实项目/个人信息）。
// 用法：node scripts/make-shots.mjs
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, sleep } from './lib/browser.mjs';

const ROOT = process.cwd();
const BASE = 'http://127.0.0.1:7788';
const DEMO = path.join(ROOT, '.synthflow', 'demo-notes');
const IMAGES = path.join(ROOT, 'docs', 'images');
const PROFILE = path.join(ROOT, '.synthflow', 'shot-profile');

const api = async (route, body) => {
  const r = await fetch(`${BASE}${route}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return r.json();
};

/* ------------------------- 1. 建一个中性演示项目 ------------------------- */
fs.rmSync(DEMO, { recursive: true, force: true });
const mk = (rel, body) => {
  const p = path.join(DEMO, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
};

mk('README.md', '# Notes\n\n一个用来演示 SynthFlow 的小项目（纯前端）。\n');
mk('index.html', `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Notes</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main id="app"></main>
    <script type="module" src="src/main.js"></script>
  </body>
</html>
`);
mk('styles.css', `:root {
  --bg: #0f1115;
  --panel: #171a21;
  --fg: #e6e9ef;
  --muted: #8b95a7;
  --accent: #7c6cf5;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.note {
  padding: 12px 14px;
  margin: 8px 0;
  background: var(--panel);
  border-radius: 10px;
}
`);
mk('src/store.js', `// 极简状态容器：订阅 + 通知
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();

  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of listeners) fn(state);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
`);
mk('src/main.js', `import { createStore } from "./store.js";

const store = createStore({ items: [] });

store.subscribe(({ items }) => {
  const app = document.querySelector("#app");
  app.innerHTML = items.map((n) => \`<div class="note">\${n.text}</div>\`).join("");
});

store.set({ items: [{ id: 1, text: "第一条笔记" }] });
`);

console.log(`演示项目已建好：${DEMO}`);

/* ------------------------- 2. 切过去并造几个版本 ------------------------- */
const pre = await api('/api/state');
const original = { dir: pre.paths.projectDir, mode: pre.paths.writeMode };
await api('/api/project', { dir: DEMO, mode: 'direct' });
fs.mkdirSync(IMAGES, { recursive: true });

/* ------------------------- 3. 拍图 ------------------------- */
const browser = await launchBrowser({
  profileDir: PROFILE,
  windowSize: '1600,1000',
});
const { cdp } = browser;
cdp.on('Page.javascriptDialogOpening', async () => {
  try { await cdp.send('Page.handleJavaScriptDialog', { accept: true }); } catch { /* ignore */ }
});

await cdp.send('Page.navigate', { url: `${BASE}/` });
await cdp.waitFor(`document.querySelector('#status-text') && document.querySelector('#status-text').textContent !== '正在连接…'`, { timeout: 20000, label: 'boot' });
await sleep(1200);

const shot = async (name) => {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(IMAGES, `${name}.png`), Buffer.from(res.data, 'base64'));
  console.log(`  ✓ docs/images/${name}.png`);
};

// 打开一个文件，让编辑器里有内容
await cdp.evaluate(`
  const f = [...document.querySelectorAll('#file-tree .tree-file')].find((n) => n.dataset.path === 'src/store.js');
  if (f) f.click();
  return true;
`);
await sleep(1200);

// 图 1：主界面（打字中 + 意图条）
await cdp.evaluate(`
  const el = document.querySelector('#prompt');
  el.value = '给每条笔记加一个删除按钮，删掉之后要能从本地存储里恢复。';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
`);
await sleep(900);
await shot('overview');

// 图 2：生成中（思考流 + 代码流 + 建议）
await cdp.evaluate(`document.querySelector('#btn-commit')?.click(); return true;`);
await sleep(2500);
await shot('generating');
await cdp.waitFor(`!document.querySelector('#run-badge').textContent.includes('正在')`, { timeout: 180000, label: '生成结束' });
await sleep(1500);

// 图 3：设置面板的「模型」页（模型可选 + 推理强度）
await cdp.evaluate(`document.querySelector('#btn-settings')?.click(); return true;`);
await sleep(900);
await cdp.evaluate(`document.querySelector('#settings-modal [data-tab="model"]')?.click(); return true;`);
await sleep(600);
await shot('model-settings');
await cdp.evaluate(`document.querySelector('#cfg-close')?.click(); return true;`);
await sleep(500);

// 图 4：版本时间线（多存几版，让 × 和未保存轮次都出现）
for (const label of ['搭好项目骨架', '加上本地存储', '接上筛选与排序']) {
  await api('/api/version/save', { label });
  await sleep(250);
}
const v = await api('/api/versions');
console.log(`  版本链：${v.versions.map((x) => x.id).join(' → ')}`);
await cdp.evaluate(`
  const t = document.querySelector('#timeline');
  if (t) t.scrollTop = t.scrollHeight;
  return true;
`);
await sleep(700);
await shot('version-timeline');

/* ------------------------- 4. 收尾 ------------------------- */
await api('/api/project', { dir: original.dir, mode: original.mode });
await browser.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n已切回 ${original.dir}`);
console.log('（演示项目保留在 .synthflow/demo-notes，方便你以后重新拍图；它不会被提交）');
process.exit(0);
