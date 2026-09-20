// SynthFlow HTTP 服务：静态前端 + SSE 事件流 + REST 控制接口。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHuman, ensureDir, newId } from './util.js';
import { Workspace } from './workspace.js';
import { Session } from './session.js';
import { RagIndex } from './rag.js';
import { Memory } from './memory.js';
import { Runner } from './runner.js';
import { loadConfig, saveConfig, PRESETS } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else args[key] = true;
    }
  }
  return args;
}

export function createServer({ projectRoot, port, host = '127.0.0.1', log = console.log, providerOverride, allowMock = false } = {}) {
  const root = path.resolve(projectRoot ?? path.join(__dirname, '..'));
  const cfg = loadConfig(root);
  if (providerOverride) cfg.provider = providerOverride;
  const workspaceDir = path.join(root, 'workspace');
  ensureDir(workspaceDir);

  const workspace = new Workspace(workspaceDir, { storeDir: path.join(root, '.synthflow') });
  const memory = new Memory(workspace.storeDir);
  const rag = new RagIndex(workspace);
  rag.build();

  // 会话：默认复用最近一次，方便用户刷新页面不丢上下文
  const sessionsDir = path.join(workspace.storeDir, 'sessions');
  let session = null;
  const sessionFiles = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')) : [];
  if (sessionFiles.length) {
    const newest = sessionFiles
      .map((f) => ({ f, m: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    session = Session.load(path.join(sessionsDir, newest.f), { workspace, config: cfg });
  }
  if (!session) session = new Session({ id: newId('sess'), workspace, config: cfg });

  /* ----------------------------- SSE 广播 ----------------------------- */
  const clients = new Set();
  const throttle = new Map();
  let throttleTimer = null;

  function flushThrottled() {
    throttleTimer = null;
    for (const [key, entry] of throttle) {
      throttle.delete(key);
      broadcast(entry.name, entry.payload, true);
    }
  }
  function broadcast(name, payload, raw = false) {
    const text = `event: ${name}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
    for (const res of clients) {
      try {
        res.write(text);
      } catch {
        clients.delete(res);
      }
    }
  }

  const THROTTLED = new Set(['think:delta', 'file:delta', 'run:text']);
  const LAST_WINS = new Set(['intent']); // 高频状态类事件：只保留最后一次，避免界面抖动
  function emit(name, payload) {
    if (THROTTLED.has(name)) {
      const key = `${name}:${payload?.path ?? ''}`;
      const cur = throttle.get(key);
      if (cur) cur.payload.delta += payload.delta ?? '';
      else throttle.set(key, { name, payload: { ...payload }, mode: 'append' });
      if (!throttleTimer) throttleTimer = setTimeout(flushThrottled, 45);
      return;
    }
    if (LAST_WINS.has(name)) {
      throttle.set(name, { name, payload, mode: 'last' });
      if (!throttleTimer) throttleTimer = setTimeout(flushThrottled, 90);
      return;
    }
    broadcast(name, payload);
  }

  const runner = new Runner({ session, workspace, rag, memory, config: cfg, emit });

  /* ------------------------------ 路由 ------------------------------ */
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const route = url.pathname;

    if (route === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`retry: 1500\n\n`);
      clients.add(res);
      res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now(), provider: runner.provider.name, ready: runner.provider.ready })}\n\n`);
      broadcast('state', runner.snapshot());
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch { /* ignore */ }
      }, 15000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (route.startsWith('/api/')) {
      try {
        const out = await handleApi(route, req, res, url);
        if (out !== undefined) sendJson(res, 200, out);
      } catch (err) {
        sendJson(res, err.status ?? 500, { error: err.message ?? String(err) });
      }
      return;
    }

    serveStatic(route, res);
  });

  async function handleApi(route, req, res, url) {
    const body = req.method === 'POST' ? await readBody(req) : {};
    switch (route) {
      case '/api/health':
        return { ok: true, at: Date.now(), uptime: process.uptime(), pid: process.pid, projectRoot: root, workspace: workspaceDir };

      case '/api/state':
        return {
          ...runner.snapshot(),
          // runner.snapshot().config 只有生成参数；这里补上完整的公开配置（含 apiKeySet / patchRetry），
          // 否则设置面板拿不到 baseUrl、也判断不出 Key 是否已保存。
          config: { ...runner.snapshot().config, ...publicConfig(cfg) },
          presets: Object.fromEntries(
            Object.entries(PRESETS)
              .filter(([k, v]) => !v.hidden || allowMock || k === cfg.provider)
              .map(([k, v]) => [k, { label: v.label, baseUrl: v.baseUrl, model: v.model, needsKey: v.needsKey }]),
          ),
          paths: { projectRoot: root, workspace: workspaceDir, store: workspace.storeDir, public: PUBLIC_DIR },
        };

      case '/api/input': {
        runner.onInput({ text: body.text ?? '', idleMs: body.idleMs ?? 0 });
        return { ok: true };
      }

      case '/api/commit':
        return runner.commit({ reason: body.reason ?? 'manual', force: Boolean(body.force) });

      case '/api/cancel':
        return { ok: true, cancelled: runner.cancel('user') };

      case '/api/rollback':
        return runner.moveVersion(body.direction ?? 'back', body.versionId);

      case '/api/forward':
        return runner.moveVersion('forward');

      case '/api/adopt':
        return runner.adopt(body.suggestion);

      case '/api/dismiss':
        return runner.dismiss(body.suggestion);

      case '/api/tree':
        return { tree: workspace.listTree(), files: workspace.listFiles(), bytes: workspace.totalBytes(), human: bytesToHuman(workspace.totalBytes()) };

      case '/api/file': {
        const rel = url.searchParams.get('path') ?? body.path;
        const file = workspace.read(rel);
        if (!file) {
          const e = new Error(`文件不存在: ${rel}`);
          e.status = 404;
          throw e;
        }
        return file;
      }

      case '/api/save':
        return runner.writeFile(body.path, body.content ?? '');

      case '/api/versions':
        return { ...session.versionList(), segments: session.segments.slice(-80) };

      case '/api/context':
        return { ...session.contextStack(), stats: session.stats, versions: session.versionList() };

      case '/api/memory':
        return memory.summary();

      case '/api/rag': {
        const q = url.searchParams.get('q') ?? body.q ?? '';
        return { query: q, hits: rag.search(q, { k: 6 }), stats: rag.stats(), skills: rag.skills().map((s) => ({ name: s.name, description: s.description, triggers: s.triggers })) };
      }

      case '/api/config': {
        if (req.method === 'POST') {
          const saved = saveConfig(root, body);
          Object.assign(cfg, loadConfig(root), saved.port ? { port: Number(saved.port) } : {});
          runner.provider = (await import('./llm.js')).createProvider(cfg);
          runner.config = cfg;
          broadcast('state', runner.snapshot());
          broadcast('toast', { level: 'ok', message: `模型配置已更新：${runner.provider.label}${runner.provider.ready ? '' : `（${runner.provider.note}）`}` });
          return { ok: true, config: publicConfig(cfg), provider: { name: runner.provider.name, ready: runner.provider.ready, note: runner.provider.note } };
        }
        return { config: publicConfig(cfg), file: cfg.file };
      }

      case '/api/reindex':
        rag.build({ force: true });
        return { ok: true, stats: rag.stats() };

      default: {
        const e = new Error(`未知接口: ${route}`);
        e.status = 404;
        throw e;
      }
    }
  }

  function serveStatic(route, res) {
    const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
    let file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // SPA 兜底
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(fallback)) file = fallback;
      else {
        res.writeHead(404).end('not found');
        return;
      }
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }

  return {
    server,
    runner,
    session,
    workspace,
    rag,
    memory,
    config: cfg,
    projectRoot: root,
    workspaceDir,
    listen() {
      return new Promise((resolve) => {
        server.listen(port ?? cfg.port, host, () => resolve(server.address()));
      });
    },
    close() {
      for (const c of clients) {
        try {
          c.end();
        } catch { /* ignore */ }
      }
      return new Promise((resolve) => server.close(resolve));
    },
    emit,
    broadcast,
  };
}

function publicConfig(cfg) {
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKeySet: Boolean(cfg.apiKey),
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    specDelayMs: cfg.specDelayMs,
    commitIdleMs: cfg.commitIdleMs,
    settleMs: cfg.settleMs,
    intentThreshold: cfg.intentThreshold,
    autoCommit: cfg.autoCommit,
    autoAdoptHigh: Boolean(cfg.autoAdoptHigh),
    patchRetry: cfg.patchRetry !== false,
  };
}

function sendJson(res, status, data) {
  const text = JSON.stringify(data ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 8 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`JSON 解析失败: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------- CLI ------------------------------- */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs();
  const projectRoot = args.root ? path.resolve(args.root) : path.join(__dirname, '..');
  const providerOverride = args.provider ? String(args.provider) : undefined;
  const app = createServer({
    projectRoot,
    port: Number(args.port) || undefined,
    providerOverride,
    allowMock: Boolean(args['show-mock']),
  });
  const addr = await app.listen();
  const url = `http://127.0.0.1:${addr.port}/`;
  const cfg = app.config;
  console.log('');
  console.log('  ┌────────────────────────────────────────────────────────┐');
  console.log('  │  SynthFlow · 预生成式 AI 编程工作台                     │');
  console.log('  └────────────────────────────────────────────────────────┘');
  console.log(`  界面地址   ${url}`);
  console.log(`  项目根目录 ${app.projectRoot}`);
  console.log(`  代码输出   ${app.workspaceDir}   (${app.workspace.listFiles().length} 个文件 / ${bytesToHuman(app.workspace.totalBytes())})`);
  console.log(`  本地数据   ${path.join(app.projectRoot, '.synthflow')}`);
  console.log(`  模型       ${app.runner.provider.label} · ${cfg.model || '(未设置)'} · ${app.runner.provider.ready ? '就绪' : '未就绪'}`);
  if (!app.runner.provider.ready) console.log(`             ${app.runner.provider.note}`);
  console.log('  停止服务   Ctrl + C');
  console.log('');
  if (args.open || process.env.SYNTHFLOW_OPEN === '1') {
    const { spawn } = await import('node:child_process');
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}
