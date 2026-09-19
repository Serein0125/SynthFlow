// SynthFlow 模型接入层：零依赖。
// - mock：离线内置"演示大脑"，无需任何 API Key 就能完整体验流式生成 + 建议 + 增量补丁
// - openai / deepseek / ollama / 任意 OpenAI 兼容端点：用 Node 内置 fetch 直接流式读取
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe } from './util.js';

export const PRESETS = {
  mock: { label: '内置演示（离线可用）', baseUrl: '', model: 'synthflow-demo', needsKey: false },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true, envKey: 'DEEPSEEK_API_KEY' },
  openai: { label: 'OpenAI 兼容', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true, envKey: 'OPENAI_API_KEY' },
  ollama: { label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b', needsKey: false },
  siliconflow: { label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-Coder-7B-Instruct', needsKey: true, envKey: 'SILICONFLOW_API_KEY' },
  custom: { label: '自定义 OpenAI 兼容端点', baseUrl: '', model: '', needsKey: false },
};

export function loadConfig(projectRoot) {
  const file = path.join(projectRoot, '.synthflow', 'config.json');
  const stored = readJsonSafe(file, {});
  const provider = process.env.SYNTHFLOW_PROVIDER || stored.provider || 'mock';
  const preset = PRESETS[provider] ?? PRESETS.custom;
  const apiKey =
    process.env.SYNTHFLOW_API_KEY ||
    (preset.envKey ? process.env[preset.envKey] : '') ||
    stored.apiKey ||
    '';
  return {
    provider,
    baseUrl: process.env.SYNTHFLOW_BASE_URL || stored.baseUrl || preset.baseUrl || '',
    model: process.env.SYNTHFLOW_MODEL || stored.model || preset.model || '',
    apiKey,
    temperature: Number(process.env.SYNTHFLOW_TEMPERATURE ?? stored.temperature ?? 0.3),
    maxTokens: Number(process.env.SYNTHFLOW_MAX_TOKENS ?? stored.maxTokens ?? 4096),
    // 预生成（想法 1/2）：打字停顿超过 specDelayMs 就先跑一遍"预演"
    specDelayMs: Number(stored.specDelayMs ?? 320),
    commitIdleMs: Number(stored.commitIdleMs ?? 900),
    // 兜底：用户停手不打了但句子没以标点结尾时，停顿这么久也自动开工
    settleMs: Number(stored.settleMs ?? 1600),
    intentThreshold: Number(stored.intentThreshold ?? 0.6),
    autoCommit: stored.autoCommit !== false,
    autoAdoptHigh: stored.autoAdoptHigh === true,
    port: Number(stored.port ?? 7788),
    open: stored.open === true,
    file: file,
    stored,
  };
}

export function saveConfig(projectRoot, patch) {
  const file = path.join(projectRoot, '.synthflow', 'config.json');
  const cur = readJsonSafe(file, {});
  const next = { ...cur, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/* ------------------------------------------------------------------ *
 * Mock Provider —— 离线演示大脑
 * 它遵守与真实模型完全相同的流协议，因此前端/后端无需为它做任何特殊分支。
 * ------------------------------------------------------------------ */

function pickTemplate(prompt) {
  const p = String(prompt ?? '');
  if (/后台|管理|admin|dashboard|控制台|CRUD|增删改查/i.test(p)) return 'admin';
  if (/登录|注册|login|signin|鉴权|认证|auth/i.test(p)) return 'login';
  if (/图表|chart|可视化|统计|看板|dashboard-chart/i.test(p)) return 'chart';
  if (/表单|form|填报|校验/i.test(p)) return 'form';
  return 'widget';
}

function templateFiles(kind, prompt) {
  const title = (prompt.match(/[\u4e00-\u9fffA-Za-z0-9]{2,16}/)?.[0] ?? 'SynthFlow Demo').trim();
  if (kind === 'admin') {
    return [
      {
        path: 'src/index.html',
        lang: 'html',
        content: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · 后台管理</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <h1 class="brand">${title}</h1>
      <nav>
        <a class="nav-item active" href="#users">用户管理</a>
        <a class="nav-item" href="#orders">订单管理</a>
        <a class="nav-item" href="#settings">系统设置</a>
      </nav>
    </aside>
    <main class="content">
      <header class="topbar">
        <h2 id="page-title">用户管理</h2>
        <div class="actions">
          <input id="search" class="input" type="search" placeholder="搜索用户名 / 邮箱" />
          <button id="create" class="btn primary">新建用户</button>
        </div>
      </header>
      <section class="card">
        <table class="table" id="user-table">
          <thead>
            <tr><th>ID</th><th>用户名</th><th>邮箱</th><th>角色</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody id="user-body"></tbody>
        </table>
        <footer class="pager">
          <button id="prev" class="btn">上一页</button>
          <span id="page-info">1 / 1</span>
          <button id="next" class="btn">下一页</button>
        </footer>
      </section>
    </main>
  </div>
  <script type="module" src="./main.js"></script>
</body>
</html>
`,
      },
      {
        path: 'src/styles.css',
        lang: 'css',
        content: `:root {
  --bg: #0f1115;
  --panel: #171a21;
  --line: #262b36;
  --text: #e6e9ef;
  --muted: #98a2b3;
  --brand: #5b8cff;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}

.layout { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }

.sidebar {
  background: var(--panel);
  border-right: 1px solid var(--line);
  padding: 20px 16px;
}

.brand { font-size: 16px; margin: 0 0 24px; }
.nav-item { display: block; padding: 9px 12px; border-radius: 8px; color: var(--muted); text-decoration: none; }
.nav-item.active, .nav-item:hover { background: rgba(91, 140, 255, 0.14); color: var(--text); }

.content { padding: 20px 24px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.actions { display: flex; gap: 8px; }

.input, .btn {
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--text);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}

.btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; }

.card {
  margin-top: 18px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
}

.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th, .table td { padding: 11px 14px; text-align: left; border-bottom: 1px solid var(--line); }
.table th { color: var(--muted); font-weight: 500; background: rgba(255, 255, 255, 0.02); }
.table tr:hover td { background: rgba(91, 140, 255, 0.06); }

.pager { display: flex; align-items: center; gap: 12px; padding: 12px 14px; color: var(--muted); }
.tag { padding: 2px 8px; border-radius: 999px; font-size: 12px; background: rgba(91, 140, 255, 0.16); color: #9dbcff; }
`,
      },
      {
        path: 'src/main.js',
        lang: 'js',
        content: `// ${title} —— 后台管理主逻辑（SynthFlow 生成）
const state = {
  page: 1,
  pageSize: 8,
  keyword: '',
  users: [],
};

async function loadUsers() {
  const res = await fetch('/api/users');
  if (!res.ok) throw new Error('加载用户失败: ' + res.status);
  state.users = await res.json();
  render();
}

function filtered() {
  const kw = state.keyword.trim().toLowerCase();
  if (!kw) return state.users;
  return state.users.filter((u) => u.name.toLowerCase().includes(kw) || u.email.toLowerCase().includes(kw));
}

function render() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  state.page = Math.min(state.page, pages);
  const slice = rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
  const body = document.getElementById('user-body');
  body.innerHTML = slice
    .map(
      (u) => \`<tr>
        <td>\${u.id}</td>
        <td>\${u.name}</td>
        <td>\${u.email}</td>
        <td><span class="tag">\${u.role}</span></td>
        <td>\${u.active ? '启用' : '停用'}</td>
        <td><button class="btn" data-id="\${u.id}">编辑</button></td>
      </tr>\`,
    )
    .join('');
  document.getElementById('page-info').textContent = \`\${state.page} / \${pages}\`;
}

function bind() {
  document.getElementById('search').addEventListener('input', (e) => {
    state.keyword = e.target.value;
    state.page = 1;
    render();
  });
  document.getElementById('prev').addEventListener('click', () => { state.page -= 1; render(); });
  document.getElementById('next').addEventListener('click', () => { state.page += 1; render(); });
  document.getElementById('create').addEventListener('click', () => {
    alert('TODO: 接入新建用户弹窗');
  });
}

bind();
loadUsers().catch((err) => {
  console.error(err);
  document.getElementById('user-body').innerHTML = '<tr><td colspan="6">加载失败，请检查接口</td></tr>';
});
`,
      },
      {
        path: 'README.md',
        lang: 'markdown',
        content: `# ${title}

由 SynthFlow 生成的后台管理示例。

## 文件

- \`src/index.html\` — 页面骨架
- \`src/styles.css\` — 深色主题样式
- \`src/main.js\` — 列表 / 搜索 / 分页逻辑

## 待办

- [ ] 接入真实用户接口 \`GET /api/users\`
- [ ] 新建 / 编辑用户弹窗
- [ ] 权限控制
`,
      },
    ];
  }
  if (kind === 'login') {
    return [
      {
        path: 'src/index.html',
        lang: 'html',
        content: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · 登录</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <main class="auth">
    <form class="card" id="login-form" novalidate>
      <h1 class="title">登录</h1>
      <p class="subtitle">欢迎回来，请输入账号信息</p>
      <label class="field">
        <span>邮箱</span>
        <input id="email" name="email" type="email" autocomplete="username" required />
        <em class="error" data-for="email"></em>
      </label>
      <label class="field">
        <span>密码</span>
        <input id="password" name="password" type="password" autocomplete="current-password" required minlength="8" />
        <em class="error" data-for="password"></em>
      </label>
      <label class="check"><input id="remember" type="checkbox" /> 记住我</label>
      <button class="submit" type="submit">登录</button>
      <p class="hint" id="hint"></p>
    </form>
  </main>
  <script type="module" src="./main.js"></script>
</body>
</html>
`,
      },
      {
        path: 'src/styles.css',
        lang: 'css',
        content: `* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: radial-gradient(1200px 600px at 50% -10%, #1b2438, #0b0d12 70%);
  color: #e7ebf3;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}

.auth { width: 100%; max-width: 380px; padding: 24px; }

.card {
  background: rgba(23, 27, 36, 0.92);
  border: 1px solid #262c3a;
  border-radius: 16px;
  padding: 28px 26px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
}

.title { margin: 0 0 6px; font-size: 22px; }
.subtitle { margin: 0 0 20px; color: #98a2b3; font-size: 13px; }

.field { display: block; margin-bottom: 14px; }
.field span { display: block; font-size: 12px; color: #98a2b3; margin-bottom: 6px; }

.field input {
  width: 100%;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #2b3242;
  background: #10131a;
  color: inherit;
  font-size: 14px;
}

.field input:focus { outline: 2px solid #5b8cff55; border-color: #5b8cff; }
.field.invalid input { border-color: #ef5350; }
.error { color: #ef7b78; font-size: 12px; font-style: normal; min-height: 16px; display: block; }
.check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #98a2b3; margin-bottom: 16px; }

.submit {
  width: 100%;
  padding: 11px;
  border: 0;
  border-radius: 10px;
  background: linear-gradient(135deg, #5b8cff, #7a5bff);
  color: #fff;
  font-size: 15px;
  cursor: pointer;
}

.submit:disabled { opacity: 0.6; cursor: progress; }
.hint { min-height: 18px; font-size: 12px; color: #98a2b3; text-align: center; }
`,
      },
      {
        path: 'src/main.js',
        lang: 'js',
        content: `// ${title} —— 登录表单（SynthFlow 生成）
const rules = {
  email: (v) => (!v ? '请输入邮箱' : /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v) ? '' : '邮箱格式不正确'),
  password: (v) => (!v ? '请输入密码' : v.length < 8 ? '密码至少 8 位' : ''),
};

const form = document.getElementById('login-form');
const hint = document.getElementById('hint');

function validateField(name) {
  const input = form.elements[name];
  const msg = rules[name]?.(input.value) ?? '';
  const box = form.querySelector(\`.error[data-for="\${name}"]\`);
  if (box) box.textContent = msg;
  input.closest('.field')?.classList.toggle('invalid', Boolean(msg));
  return !msg;
}

for (const name of Object.keys(rules)) {
  form.elements[name].addEventListener('blur', () => validateField(name));
  form.elements[name].addEventListener('input', () => {
    const box = form.querySelector(\`.error[data-for="\${name}"]\`);
    if (box?.textContent) validateField(name);
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = Object.keys(rules).every(validateField);
  if (!ok) return;
  const btn = form.querySelector('.submit');
  btn.disabled = true;
  hint.textContent = '登录中…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: form.elements.email.value,
        password: form.elements.password.value,
        remember: form.elements.remember.checked,
      }),
    });
    if (!res.ok) throw new Error('账号或密码不正确');
    hint.textContent = '登录成功，正在跳转…';
    location.href = '/dashboard';
  } catch (err) {
    hint.textContent = err.message;
    btn.disabled = false;
  }
});
`,
      },
    ];
  }
  if (kind === 'chart') {
    return [
      {
        path: 'src/index.html',
        lang: 'html',
        content: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${title} · 数据看板</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <main class="board">
    <h1>${title}</h1>
    <div class="cards" id="cards"></div>
    <section class="panel">
      <h2>近 12 个月趋势</h2>
      <canvas id="chart" width="900" height="360"></canvas>
    </section>
  </main>
  <script type="module" src="./main.js"></script>
</body>
</html>
`,
      },
      {
        path: 'src/styles.css',
        lang: 'css',
        content: `body {
  margin: 0;
  padding: 28px;
  background: #0e1014;
  color: #e8ecf3;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}

.board { max-width: 1000px; margin: 0 auto; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin: 18px 0; }
.metric { background: #171b23; border: 1px solid #262c38; border-radius: 12px; padding: 16px; }
.metric .label { color: #98a2b3; font-size: 12px; }
.metric .value { font-size: 26px; margin-top: 6px; font-variant-numeric: tabular-nums; }
.panel { background: #171b23; border: 1px solid #262c38; border-radius: 12px; padding: 16px; }
canvas { width: 100%; height: auto; }
`,
      },
      {
        path: 'src/main.js',
        lang: 'js',
        content: `// ${title} —— 纯 Canvas 折线图（零依赖，SynthFlow 生成）
const months = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const series = [820, 932, 901, 1290, 1330, 1450, 1520, 1610, 1480, 1720, 1890, 2100];

function drawMetrics() {
  const box = document.getElementById('cards');
  const total = series.reduce((a, b) => a + b, 0);
  const metrics = [
    ['累计访问', total.toLocaleString()],
    ['月均访问', Math.round(total / series.length).toLocaleString()],
    ['峰值月份', months[series.indexOf(Math.max(...series))]],
    ['同比', '+23.4%'],
  ];
  box.innerHTML = metrics
    .map(([label, value]) => \`<div class="metric"><div class="label">\${label}</div><div class="value">\${value}</div></div>\`)
    .join('');
}

function drawChart() {
  const canvas = document.getElementById('chart');
  const ctx = canvas.getContext('2d');
  const { width: W, height: H } = canvas;
  const pad = { l: 48, r: 20, t: 20, b: 32 };
  const max = Math.max(...series) * 1.15;
  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = '#232a36';
  ctx.fillStyle = '#6b7688';
  ctx.font = '12px system-ui';
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.t + ((H - pad.t - pad.b) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(max - (max * i) / 4)), 8, y + 4);
  }

  const px = (i) => pad.l + ((W - pad.l - pad.r) * i) / (series.length - 1);
  const py = (v) => H - pad.b - ((H - pad.t - pad.b) * v) / max;

  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, 'rgba(91,140,255,0.35)');
  grad.addColorStop(1, 'rgba(91,140,255,0)');
  ctx.beginPath();
  ctx.moveTo(px(0), py(series[0]));
  series.forEach((v, i) => ctx.lineTo(px(i), py(v)));
  ctx.lineTo(px(series.length - 1), H - pad.b);
  ctx.lineTo(px(0), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  series.forEach((v, i) => (i === 0 ? ctx.moveTo(px(i), py(v)) : ctx.lineTo(px(i), py(v))));
  ctx.strokeStyle = '#5b8cff';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#8b95a7';
  months.forEach((m, i) => {
    if (i % 2) return;
    ctx.fillText(m, px(i) - 10, H - 10);
  });
}

drawMetrics();
drawChart();
window.addEventListener('resize', drawChart);
`,
      },
    ];
  }
  if (kind === 'form') {
    return [
      {
        path: 'src/index.html',
        lang: 'html',
        content: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${title} · 表单</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <form id="app-form" class="form" novalidate>
    <h1>${title}</h1>
    <label>姓名<input name="name" required /></label>
    <label>手机号<input name="phone" inputmode="numeric" required /></label>
    <label>备注<textarea name="note" rows="3"></textarea></label>
    <button type="submit">提交</button>
    <p id="msg"></p>
  </form>
  <script type="module" src="./main.js"></script>
</body>
</html>
`,
      },
      {
        path: 'src/styles.css',
        lang: 'css',
        content: `body { margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0f1115; color: #e6e9ef; font-family: system-ui, "Microsoft YaHei", sans-serif; }
.form { width: min(460px, 92vw); background: #171a21; border: 1px solid #262b36; border-radius: 14px; padding: 24px; display: grid; gap: 14px; }
label { display: grid; gap: 6px; font-size: 13px; color: #98a2b3; }
input, textarea { background: #10131a; border: 1px solid #2b3242; border-radius: 8px; padding: 9px 11px; color: inherit; font: inherit; }
button { background: #5b8cff; border: 0; color: #fff; padding: 10px; border-radius: 8px; font-size: 15px; cursor: pointer; }
#msg { min-height: 18px; font-size: 13px; color: #7ddc9a; }
`,
      },
      {
        path: 'src/main.js',
        lang: 'js',
        content: `// ${title} —— 表单校验（SynthFlow 生成）
const form = document.getElementById('app-form');
const msg = document.getElementById('msg');

const validators = {
  name: (v) => (v.trim().length >= 2 ? '' : '姓名至少 2 个字'),
  phone: (v) => (/^1[3-9]\\d{9}$/.test(v.trim()) ? '' : '手机号格式不正确'),
  note: (v) => (v.length <= 200 ? '' : '备注不超过 200 字'),
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  for (const [key, fn] of Object.entries(validators)) {
    const err = fn(String(data[key] ?? ''));
    if (err) {
      msg.textContent = err;
      form.elements[key].focus();
      return;
    }
  }
  msg.textContent = '提交中…';
  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    msg.textContent = res.ok ? '提交成功 ✅' : \`提交失败：\${res.status}\`;
  } catch (err) {
    msg.textContent = \`网络错误：\${err.message}\`;
  }
});
`,
      },
    ];
  }
  return [
    {
      path: 'src/index.html',
      lang: 'html',
      content: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <main class="app">
    <h1>${title}</h1>
    <p class="lead">需求原文：${title}</p>
    <div class="row">
      <input id="text" placeholder="输入点什么…" />
      <button id="go">执行</button>
    </div>
    <ul id="list" class="list"></ul>
  </main>
  <script type="module" src="./main.js"></script>
</body>
</html>
`,
    },
    {
      path: 'src/styles.css',
      lang: 'css',
      content: `body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1115; color: #e8ecf3; font-family: system-ui, "Microsoft YaHei", sans-serif; }
.app { width: min(560px, 92vw); background: #171a21; border: 1px solid #262b36; border-radius: 16px; padding: 26px; }
h1 { margin: 0 0 6px; font-size: 20px; }
.lead { color: #98a2b3; font-size: 13px; margin: 0 0 18px; }
.row { display: flex; gap: 8px; }
input { flex: 1; background: #10131a; border: 1px solid #2b3242; border-radius: 10px; padding: 10px 12px; color: inherit; font: inherit; }
button { background: #5b8cff; color: #fff; border: 0; border-radius: 10px; padding: 10px 16px; cursor: pointer; }
.list { list-style: none; padding: 0; margin: 18px 0 0; display: grid; gap: 8px; }
.list li { background: #10131a; border: 1px solid #232a36; border-radius: 10px; padding: 10px 12px; font-size: 14px; display: flex; justify-content: space-between; }
.list li.done { color: #6b7688; text-decoration: line-through; }
`,
    },
    {
      path: 'src/main.js',
      lang: 'js',
      content: `// ${title} —— 最小可运行逻辑（SynthFlow 生成）
const state = { items: [] };

function render() {
  const list = document.getElementById('list');
  list.innerHTML = state.items
    .map((it, i) => \`<li class="\${it.done ? 'done' : ''}" data-i="\${i}"><span>\${it.text}</span><span>\${it.done ? '✓' : '·'}</span></li>\`)
    .join('');
}

document.getElementById('go').addEventListener('click', () => {
  const input = document.getElementById('text');
  const text = input.value.trim();
  if (!text) return;
  state.items.unshift({ text, done: false });
  input.value = '';
  render();
});

document.getElementById('list').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const i = Number(li.dataset.i);
  state.items[i].done = !state.items[i].done;
  render();
});

render();
`,
    },
  ];
}

function mockSuggestionSet(prompt, kind) {
  const base = [
    {
      kind: 'clarify',
      title: '需要补全：数据来源与鉴权方式',
      impact: 'high',
      insert: '数据来自后端接口，请使用 fetch 封装统一请求层，接口未就绪时用本地 mock 数据兜底。',
      body: '当前需求没有说明数据来源。建议明确是真实接口还是本地 mock，并统一错误处理，否则后续接入时整页逻辑都要改。',
    },
  ];
  if (kind === 'admin') {
    base.push(
      {
        kind: 'optimize',
        title: '表格渲染改为事件委托，避免逐行绑定',
        impact: 'medium',
        insert: '表格行操作请用事件委托绑定在 tbody 上，不要给每一行单独 addEventListener。',
        body: '每行绑定监听在数据量大时会带来明显的初始化开销与内存占用；委托到 tbody 只绑一次。',
      },
      {
        kind: 'risk',
        title: 'innerHTML 拼接存在 XSS 风险',
        impact: 'high',
        insert: '渲染用户数据时必须转义 HTML，或改用 textContent / 模板 + 显式转义函数。',
        body: '当前用模板字符串拼 innerHTML，用户名里带 <img onerror> 就会执行。请加 escapeHtml 或改用 textContent。',
      },
      {
        kind: 'test',
        title: '补一个分页边界测试',
        impact: 'low',
        insert: '请为分页补边界用例：空数据、只有 1 页、删除最后一页最后一条时页码回退。',
        body: '分页最常见的 bug 就是当前页被删空后停在空白页，建议顺手写测试固定行为。',
      },
    );
  } else if (kind === 'login') {
    base.push(
      {
        kind: 'optimize',
        title: '密码框加入可见性切换与防重复提交',
        impact: 'medium',
        insert: '密码输入框请提供"显示/隐藏"切换，并在提交中禁用按钮防止重复提交。',
        body: '登录场景用户输错率高，可见性切换能显著降低失败率；防重复提交避免产生多条会话。',
      },
      {
        kind: 'risk',
        title: '不要在客户端保存明文密码',
        impact: 'high',
        insert: '"记住我"只保存 token 或邮箱，绝不保存密码明文；token 存 httpOnly Cookie 更安全。',
        body: 'localStorage 可被任意脚本读取，明文密码一旦泄露影响面极大。',
      },
    );
  } else if (kind === 'chart') {
    base.push({
      kind: 'optimize',
      title: 'Canvas 需要处理高分屏模糊',
      impact: 'medium',
      insert: 'Canvas 请按 devicePixelRatio 放大画布并用 CSS 缩回，避免高分屏模糊。',
      body: 'retina 屏下 canvas 逻辑像素与物理像素不一致，线条会发虚；乘以 dpr 后清晰度明显提升。',
    });
  }
  base.push({
    kind: 'optimize',
    title: '抽出可复用组件，避免页面逻辑膨胀',
    impact: 'medium',
    insert: '请把可复用的部分抽成独立组件/模块，页面文件只保留组装逻辑。',
    body: `你这个需求（${prompt.slice(0, 24)}）后续大概率会扩展，先把结构切开能省下大量返工。`,
  });
  return base;
}

async function* mockStream(req) {
  const prompt = req.userPrompt ?? '';
  const kind = pickTemplate(prompt);
  const incremental = req.mode === 'continue' || req.mode === 'incremental';
  const existing = req.existingFiles ?? {};
  const existingPaths = Object.keys(existing);
  const w = (text) => ({ type: 'delta', text });
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  const emit = async function* (text, chunk = 24, delay = 6) {
    for (let i = 0; i < text.length; i += chunk) {
      yield w(text.slice(i, i + chunk));
      await nap(delay);
    }
  };

  yield* emit(`<<<SF think>>>\n`, 64, 0);
  yield* emit(`收到需求：「${prompt.trim().slice(0, 60)}」。\n`);
  yield* emit(`识别为 ${kind} 类型场景${incremental ? '，且这是**增量续写**，我会尽量只补不改' : ''}。\n`);
  await nap(40);

  if (incremental && existingPaths.length) {
    const target = existingPaths.includes('src/main.js') ? 'src/main.js' : existingPaths[0];
    const prev = existing[target] ?? '';
    yield* emit(`已有产出：${existingPaths.join('、')}。我优先在 ${target} 上做定点补丁，避免全量重写。\n`);
    yield* emit(`<<<SF /think>>>\n\n`);
    yield* emit(`<<<SF suggest kind="optimize" title="增量续写：把新增能力挂到现有结构上" impact="medium" insert="新增功能请复用既有的 render/bind 结构，不要另起一套渲染流程。">>\n`);
    yield* emit(`检测到这是对已有代码的追加需求。直接插入新函数并在既有事件里调用，改动面最小。\n`);
    yield* emit(`<<<SF /suggest>>>\n\n`);
    const anchorLine = prev.split('\n').slice(-3).join('\n').replace(/\s+$/, '');
    yield* emit(`<<<SF file path="${target}" action="update" lang="js">>>\n`);
    yield* emit(`<<<<<<< SEARCH\n${anchorLine}\n=======\n${anchorLine}\n\n// —— 增量新增（SynthFlow）——\n// 新需求：${prompt.trim().slice(0, 50)}\nfunction synthflowExtend() {\n  console.log('由 SynthFlow 增量追加的能力');\n  return { ok: true };\n}\n\nsynthflowExtend();\n>>>>>>> REPLACE\n`);
    yield* emit(`<<<SF /file>>>\n\n`);
    yield* emit(`<<<SF think>>>\n增量补丁已生成：只触碰了 ${target} 的尾部锚点，其余文件保持原样。\n<<<SF /think>>>\n`);
    return;
  }

  for (const s of mockSuggestionSet(prompt.trim(), kind)) {
    yield* emit(`<<<SF suggest kind="${s.kind}" title="${s.title.replace(/"/g, "'")}" impact="${s.impact}" insert="${s.insert.replace(/"/g, "'")}">>>\n`);
    yield* emit(`${s.body}\n`);
    yield* emit(`<<<SF /suggest>>>\n\n`);
    await nap(30);
  }
  yield* emit(`<<<SF /think>>>\n\n`);
  yield* emit(`<<<SF think>>>\n现在开始产出文件：\n`);
  const files = templateFiles(kind, prompt);
  yield* emit(files.map((f) => `- ${f.path}`).join('\n'));
  yield* emit(`\n<<<SF /think>>>\n\n`);
  await nap(30);

  for (const f of files) {
    yield* emit(`<<<SF file path="${f.path}" action="create" lang="${f.lang}">>>\n`);
    yield* emit(f.content, 48, 4);
    yield* emit(`<<<SF /file>>>\n\n`);
  }
  yield* emit(`<<<SF think>>>\n完成。共 ${files.length} 个文件。可以继续说需求，我会增量续写而不是推倒重来。\n<<<SF /think>>>\n`);
}

/* ------------------------------------------------------------------ *
 * OpenAI 兼容 Provider（流式 SSE）
 * ------------------------------------------------------------------ */

async function* openaiStream(req, cfg) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const body = {
    model: cfg.model,
    stream: true,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    messages: req.messages,
  };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`模型接口返回 ${res.status}: ${text.slice(0, 300)}`);
  }
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta ?? {};
        const text = delta.content ?? delta.reasoning_content ?? '';
        if (text) yield { type: 'delta', text };
      } catch { /* 跳过心跳/半包 */ }
    }
  }
}

/* ------------------------------------------------------------------ */

export function createProvider(cfg) {
  const provider = cfg.provider && PRESETS[cfg.provider] ? cfg.provider : 'custom';
  const label = PRESETS[provider]?.label ?? provider;
  if (provider === 'mock') {
    return {
      name: 'mock',
      label,
      ready: true,
      note: '内置演示大脑：不消耗任何 API 额度，适合先跑通交互',
      stream: (req) => mockStream(req),
    };
  }
  const missing = [];
  if (!cfg.baseUrl) missing.push('baseUrl');
  if (!cfg.model) missing.push('model');
  if (PRESETS[provider]?.needsKey && !cfg.apiKey) missing.push('apiKey');
  return {
    name: provider,
    label,
    ready: missing.length === 0,
    note: missing.length ? `缺少配置：${missing.join(', ')}（可在界面右上角「模型设置」补全）` : `${cfg.model} @ ${cfg.baseUrl}`,
    stream: (req) => openaiStream(req, cfg),
  };
}
