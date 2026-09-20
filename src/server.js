// SynthFlow HTTP 服务：静态前端 + Monaco + SSE 事件流 + REST 控制接口。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHuman, ensureDir, newId, sha1 } from './util.js';
import { Workspace } from './workspace.js';
import { Session } from './session.js';
import { RagIndex } from './rag.js';
import { Memory } from './memory.js';
import { Runner } from './runner.js';
import { scanStyle, styleStats } from './style.js';
import { buildProjectMap, locate, mapStats } from './projectmap.js';
import { compactPromptText, createProvider, loadConfig, saveConfig, newProfile, PRESETS } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MONACO_DIR = path.join(__dirname, '..', 'node_modules', 'monaco-editor');
// 只服务 AMD 构建（min/vs），浏览器要的就是它；dev/esm 用不到，可用 clean.mjs --vendor 裁掉
const MONACO_MIN = path.join(MONACO_DIR, 'min');

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
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
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

const slugOf = (dir) => `${path.basename(dir).replace(/[^\w-]/g, '') || 'project'}-${sha1(dir).slice(0, 8)}`;

/**
 * v3 把快照/会话/索引从 .synthflow/ 移到了 .synthflow/projects/<项目>/ 下（多项目互不污染）。
 * 老用户的版本历史不能就这么丢，所以这里做一次性搬迁 —— 只针对默认 workspace，
 * 避免把历史错误地挂到某个真实项目上。
 */
function migrateLegacyStore(globalStore, projectStore, isDefaultWorkspace) {
  if (!isDefaultWorkspace) return [];
  const pairs = [
    ['snapshots', 'snapshots'],
    ['sessions', 'sessions'],
    ['history', 'history'],
  ];
  const moved = [];
  for (const [from, to] of pairs) {
    const src = path.join(globalStore, from);
    const dest = path.join(projectStore, to);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(src, dest);
        moved.push(from);
      } catch { /* 跨盘等情况就放弃迁移，不影响使用 */ }
    }
  }
  const idxSrc = path.join(globalStore, 'index.json');
  const idxDest = path.join(projectStore, 'index.json');
  if (fs.existsSync(idxSrc) && !fs.existsSync(idxDest)) {
    try {
      fs.renameSync(idxSrc, idxDest);
      moved.push('index.json');
    } catch { /* ignore */ }
  }
  return moved;
}

export function createServer({ projectRoot, port, host = '127.0.0.1', log = console.log, providerOverride, allowMock = false } = {}) {
  const root = path.resolve(projectRoot ?? path.join(__dirname, '..'));
  const globalStore = path.join(root, '.synthflow');
  ensureDir(globalStore);
  ensureDir(path.join(globalStore, 'skills'));

  let cfg = loadConfig(root);
  if (providerOverride) cfg.provider = providerOverride;
  const monacoAvailable = fs.existsSync(path.join(MONACO_DIR, 'min', 'vs', 'loader.js'));

  /* ----------------------------- SSE 广播 ----------------------------- */
  const clients = new Set();
  const throttle = new Map();
  let throttleTimer = null;

  function broadcast(name, payload) {
    const text = `event: ${name}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
    for (const res of clients) {
      try {
        res.write(text);
      } catch {
        clients.delete(res);
      }
    }
  }

  function flushThrottled() {
    throttleTimer = null;
    for (const [key, entry] of throttle) {
      throttle.delete(key);
      broadcast(entry.name, entry.payload);
    }
  }

  const THROTTLED = new Set(['think:delta', 'file:delta', 'run:text']);
  const LAST_WINS = new Set(['intent']);
  function emit(name, payload) {
    if (THROTTLED.has(name)) {
      const key = `${name}:${payload?.path ?? ''}`;
      const cur = throttle.get(key);
      if (cur) cur.payload.delta += payload.delta ?? '';
      else throttle.set(key, { name, payload: { ...payload } });
      if (!throttleTimer) throttleTimer = setTimeout(flushThrottled, 45);
      return;
    }
    if (LAST_WINS.has(name)) {
      throttle.set(name, { name, payload });
      if (!throttleTimer) throttleTimer = setTimeout(flushThrottled, 90);
      return;
    }
    broadcast(name, payload);
  }

  /* --------------------------- 服务容器（可重载） --------------------------- */
  // 每个目标项目有独立的 snapshots / sessions / staging，避免切换项目时互相污染。
  let svc = null;

  function buildServices() {
    const projectDir = cfg.projectDir ? path.resolve(cfg.projectDir) : path.join(root, 'workspace');
    const slug = slugOf(projectDir);
    const projectStore = path.join(globalStore, 'projects', slug);
    const writeMode = cfg.writeMode === 'staging' ? 'staging' : 'direct';
    const overlayDir = writeMode === 'staging' ? path.join(projectStore, 'staging') : projectDir;
    ensureDir(projectStore);

    // 直接写入模式：如果上一轮用的是暂存模式，暂存层里可能还压着没应用的改动。
    // 用户选"直接写入"的意思就是"生成即落到项目目录"，所以这些改动要补齐写进去 ——
    // 不能无声无息地烂在暂存目录里（这正是之前的坑：他以为早写进项目了，其实没有）。
    let carryOver = null;
    if (writeMode === 'direct') {
      const carry = new Workspace(projectDir, { storeDir: projectStore, overlayDir: path.join(projectStore, 'staging') });
      const res = carry.applyPending();
      if (res.applied.length || res.deleted.length) {
        carryOver = res;
        log(`  [写入] 直接写入模式：已把上次暂存的 ${res.applied.length} 个文件补齐写进项目${res.deleted.length ? `，并删除 ${res.deleted.length} 个` : ''}`);
      }
    }
    const migrated = migrateLegacyStore(globalStore, projectStore, projectDir === path.join(root, 'workspace'));
    if (migrated.length) log(`  [迁移] 已把旧的 ${migrated.join('、')} 搬到项目数据目录，历史版本不会丢`);

    const workspace = new Workspace(projectDir, { storeDir: projectStore, overlayDir });
    const memory = new Memory(globalStore);
    const rag = new RagIndex(workspace, { skillsDir: path.join(globalStore, 'skills') });
    // 注意：这里**不**建索引。切到大目录时建索引会同步读几百 MB 并卡死事件循环，
    // 索引改成首次真正检索时懒建（RagIndex.search 内部触发）。
    const fileCount = workspace.listFiles().length;

    const sessionsDir = path.join(projectStore, 'sessions');
    let session = null;
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
      if (files.length) {
        const newest = files.map((f) => ({ f, m: fs.statSync(path.join(sessionsDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
        session = Session.load(path.join(sessionsDir, newest.f), { workspace, config: cfg });
      }
    }
    if (!session) session = new Session({ id: newId('sess'), workspace, config: cfg, storeDir: sessionsDir });

    const runner = new Runner({ session, workspace, rag, memory, config: cfg, emit });

    // 记录项目登记表（供界面切换）
    const registryFile = path.join(globalStore, 'projects.json');
    let registry = { current: projectDir, list: [] };
    try {
      registry = JSON.parse(fs.readFileSync(registryFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch { /* 首次运行 */ }
    registry.current = projectDir;
    registry.list = [{ dir: projectDir, slug, name: path.basename(projectDir), mode: writeMode, lastUsed: new Date().toISOString() },
      ...(registry.list ?? []).filter((p) => p.dir !== projectDir)].slice(0, 12);
    fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

    return { projectDir, projectStore, writeMode, overlayDir, workspace, memory, rag, session, runner, registry, fileCount, carryOver };
  }

  svc = buildServices();

  function reloadServices() {
    cfg = loadConfig(root);
    if (providerOverride) cfg.provider = providerOverride;
    svc = buildServices();
    // 想法 13：切项目等于换会话，前端必须整体重置，不能留着上一个项目的思考栏和输入框
    broadcast('reset', {
      projectDir: svc.projectDir,
      staging: svc.workspace.staging,
      sessionId: svc.session.id,
      prompt: svc.session.prompt ?? '',
      timeline: svc.session.timeline ?? [],
    });
    broadcast('state', svc.runner.snapshot());
    broadcast('tree', { tree: svc.workspace.listTree() });
    broadcast('versions', svc.session.versionList());
    broadcast('timeline', { timeline: svc.session.timeline });
    broadcast('pending', { items: svc.workspace.pending(), staging: svc.workspace.staging });
    if (svc.carryOver) {
      const { applied, deleted } = svc.carryOver;
      broadcast('toast', {
        level: 'ok',
        message: `直接写入模式：已把上次暂存的 ${applied.length} 个文件写进项目${deleted.length ? `，并删除 ${deleted.length} 个` : ''}，不用你再点"应用到项目"`,
      });
    }
    return svc;
  }

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
      res.write('retry: 1500\n\n');
      clients.add(res);
      res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now(), provider: svc.runner.provider.name, ready: svc.runner.provider.ready, monaco: monacoAvailable })}\n\n`);
      broadcast('state', svc.runner.snapshot());
      broadcast('timeline', { timeline: svc.session.timeline });
      broadcast('pending', { items: svc.workspace.pending(), staging: svc.workspace.staging });
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

    if (route.startsWith('/vendor/monaco/')) {
      serveMonaco(route, res);
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
    const { runner, session, workspace, rag, memory } = svc;

    switch (route) {
      case '/api/health':
        return {
          ok: true,
          at: Date.now(),
          uptime: process.uptime(),
          pid: process.pid,
          projectRoot: root,
          projectDir: svc.projectDir,
          workspace: svc.projectDir, // 兼容旧字段名
          staging: workspace.staging,
          monaco: monacoAvailable,
        };

      case '/api/state': {
        const snap = runner.snapshot();
        return {
          ...snap,
          config: { ...snap.config, ...publicConfig(cfg) },
          presets: visiblePresets(),
          // 必须合并而不是覆盖 snapshot.paths —— 否则 staging / writeMode / files 会丢，
          // 前端在状态刷新时就会把项目徽标与暂存状态擦成空白。
          paths: {
            ...snap.paths,
            projectRoot: root,
            projectDir: svc.projectDir,
            workspace: svc.projectDir,
            store: globalStore,
            projectStore: svc.projectStore,
            public: PUBLIC_DIR,
          },
          monaco: monacoAvailable,
          projects: svc.registry,
          profiles: maskedProfiles(),
          activeProfileId: cfg.activeProfileId,
        };
      }

      case '/api/input':
        runner.onInput({ text: body.text ?? '', idleMs: body.idleMs ?? 0 });
        return { ok: true };

      case '/api/commit':
        return runner.commit({ reason: body.reason ?? 'manual', force: Boolean(body.force) });

      case '/api/cancel':
        return { ok: true, cancelled: runner.cancel('user') };

      case '/api/sync': {
        // 想法 1：一键关掉/开启"同步思考与同步生成"。
        // 明确传了布尔值就照做，没传才当作切换。前端两个按钮都是显式传值的。
        const wantSync = typeof body.enabled === 'boolean' ? body.enabled : !runner.syncEnabled;
        return runner.setSync(wantSync);
      }

      case '/api/version/save':
        // 想法 11：只有这个接口才会产生版本
        return runner.saveVersion({ label: body.label });

      case '/api/version/undo-round':
        // 一次性退回到"最近一次保存版本"的状态（跨所有未保存轮次）
        return runner.undoRound();

      case '/api/version/undo-step':
        // v3.3：只往回退 N 轮，粒度是"轮"，不要求先保存版本
        return runner.undoRoundStep({ count: Number(body.count ?? 1) });

      case '/api/timeline/clear':
        session.clearTimeline();
        session.save();
        broadcast('timeline', { timeline: [] });
        return { ok: true, timeline: [] };

      case '/api/locate': {
        const q = url.searchParams.get('q') ?? body.q ?? '';
        const map = buildProjectMap(workspace);
        return { query: q, hits: locate(map, q, { k: 8 }), stats: mapStats(workspace) };
      }

      case '/api/projectmap': {
        if (req.method === 'POST') {
          const map = buildProjectMap(workspace, { force: true });
          return { ok: true, stats: mapStats(workspace), pages: map.pages.slice(0, 30), components: map.components.slice(0, 30) };
        }
        const map = buildProjectMap(workspace);
        return { stats: mapStats(workspace), pages: map.pages.slice(0, 40), components: map.components.slice(0, 40) };
      }

      case '/api/prompt/compact': {
        const text = String(body.text ?? session.prompt ?? '').trim();
        if (!text) throw Object.assign(new Error('提示词为空，没什么可整合的'), { status: 400 });
        const provider = runner.provider;
        if (!provider.ready) throw Object.assign(new Error(`模型未就绪：${provider.note}`), { status: 400 });
        const style = body.style ?? cfg.compactStyle ?? 'balanced';
        const t0 = Date.now();
        let out = '';
        try {
          out = await compactPromptText(provider, {
            text,
            style,
            extra: session.manualEdits?.length ? `（这些文件用户手动改过：${session.manualEdits.map((m) => m.path).join(', ')}）` : '',
          });
        } catch (err) {
          throw Object.assign(new Error(`整合失败：${err.message}`), { status: 502 });
        }
        if (!out) throw Object.assign(new Error('模型返回了空结果，可能是提示词太短或调用被中断'), { status: 502 });
        return { ok: true, text: out, before: text, style, ms: Date.now() - t0, charsBefore: text.length, charsAfter: out.length };
      }

      case '/api/browse': {
        // 想法 7：服务端目录浏览，用于"选文件夹"弹窗（浏览器拿不到真实路径）
        const raw = url.searchParams.get('dir') ?? body.dir ?? '';
        const target = raw ? path.resolve(raw) : path.parse(root).root;
        let entries = [];
        try {
          entries = fs.readdirSync(target, { withFileTypes: true });
        } catch (err) {
          throw Object.assign(new Error(`无法读取目录：${err.message}`), { status: 400 });
        }
        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
          .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const parent = path.dirname(target);
        let drives = [];
        if (process.platform === 'win32' && /^[A-Za-z]:\\?$/.test(target)) {
          drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((d) => fs.existsSync(`${d}:\\`)).map((d) => `${d}:\\`);
        }
        return {
          dir: target,
          parent: parent === target ? null : parent,
          dirs: dirs.slice(0, 500),
          drives,
          isProject: fs.existsSync(path.join(target, 'package.json')) || fs.existsSync(path.join(target, '.git')),
          root,
        };
      }

      case '/api/rollback':
        return runner.moveVersion(body.direction ?? 'back', body.versionId);

      case '/api/forward':
        return runner.moveVersion('forward');

      case '/api/version/confirm':
        return runner.confirmVersion(body.versionId);

      case '/api/version/discard':
        return runner.discardVersion(body.versionId);

      case '/api/adopt':
        return runner.adopt(body.suggestion);

      case '/api/dismiss':
        return runner.dismiss(body.suggestion);

      case '/api/selection':
        return runner.setSelection(body.selection ?? null);

      case '/api/tree':
        return {
          // force: 用户手动刷新时重扫一遍，平时走缓存（大目录下差别是秒级的）
          tree: workspace.listTree(),
          files: workspace.listFiles({ force: url.searchParams.get('force') === '1' }),
          bytes: workspace.totalBytes(),
          human: bytesToHuman(workspace.totalBytes()),
          staging: workspace.staging,
          projectDir: svc.projectDir,
        };

      case '/api/timeline':
        return {
          timeline: session.timeline ?? [],
          manualEdits: (session.manualEdits ?? []).map((m) => ({ path: m.path, count: m.count, at: m.at })),
          restoredFrom: 'session',
        };

      case '/api/pending':
        return { items: workspace.pending(), staging: workspace.staging, projectDir: svc.projectDir, writeMode: svc.writeMode };

      case '/api/apply':
        return runner.applyPending();

      case '/api/discard':
        return runner.discardPending();

      case '/api/file': {
        const rel = url.searchParams.get('path') ?? body.path;
        const file = workspace.read(rel);
        if (!file) {
          const e = new Error(`文件不存在: ${rel}`);
          e.status = 404;
          throw e;
        }
        return { ...file, staged: workspace.staging ? workspace.stagedAbsolute(file.rel) : false };
      }

      case '/api/save': {
        return runner.writeFile(body.path, body.content ?? '');
      }

      case '/api/compare': {
        const rel = url.searchParams.get('path') ?? body.path;
        const from = url.searchParams.get('from') ?? body.from;
        const v = session.versions.find((x) => x.id === from);
        if (!v) {
          const e = new Error(`版本不存在: ${from}`);
          e.status = 404;
          throw e;
        }
        const oldText = workspace.readFromSnapshot(v.snapshotId, rel);
        const now = workspace.read(rel);
        const { diffLines, compactDiff } = await import('./util.js');
        const diff = diffLines(oldText ?? '', now?.content ?? '');
        return {
          path: rel,
          from: v.id,
          fromExists: oldText !== null,
          nowExists: Boolean(now),
          compact: compactDiff(diff),
          stat: { added: diff.filter((d) => d.type === 'ins').length, removed: diff.filter((d) => d.type === 'del').length },
        };
      }

      case '/api/versions':
        return { ...session.versionList(), segments: session.segments.slice(-80) };

      case '/api/context':
        return { ...session.contextStack(), stats: session.stats, versions: session.versionList() };

      case '/api/memory':
        return memory.summary();

      case '/api/style': {
        if (req.method === 'POST') {
          const data = scanStyle(workspace, { force: true });
          broadcast('toast', { level: 'ok', message: `已重新扫描项目风格（${data.scanned} 个文件）` });
          return { ok: true, style: data };
        }
        return { style: styleStats(workspace) ?? scanStyle(workspace) };
      }

      case '/api/rag': {
        const q = url.searchParams.get('q') ?? body.q ?? '';
        return {
          query: q,
          hits: rag.search(q, { k: 6 }),
          stats: rag.stats(),
          skills: rag.skills().map((s) => ({ name: s.name, description: s.description, triggers: s.triggers, file: s.file })),
        };
      }

      case '/api/rag/rebuild':
        rag.build({ force: true });
        return { ok: true, stats: rag.stats() };

      case '/api/skills': {
        if (req.method === 'POST') return saveSkill(body);
        return { skills: skillList() };
      }

      case '/api/skills/delete':
        return deleteSkill(body.name);

      case '/api/profiles': {
        if (req.method === 'POST') return upsertProfile(body);
        return { profiles: maskedProfiles(), activeProfileId: cfg.activeProfileId };
      }

      case '/api/profiles/activate':
        return activateProfile(body.id);

      case '/api/profiles/delete':
        return deleteProfile(body.id);

      case '/api/project':
        return setProject(body);

      case '/api/config': {
        if (req.method === 'POST') {
          saveConfig(root, body);
          reloadServices();
          const p = svc.runner.provider;
          broadcast('toast', { level: 'ok', message: `设置已更新：${p.label}${p.ready ? '' : `（${p.note}）`}` });
          return { ok: true, config: publicConfig(cfg), provider: { name: p.name, label: p.label, ready: p.ready, note: p.note } };
        }
        return { config: publicConfig(cfg), file: cfg.file };
      }

      default: {
        const e = new Error(`未知接口: ${route}`);
        e.status = 404;
        throw e;
      }
    }
  }

  /* --------------------------- 技能 / 配置档 / 项目 --------------------------- */

  function skillsDir() {
    return path.join(globalStore, 'skills');
  }

  function skillList() {
    return svc.rag.skills().map((s) => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      body: s.body,
      file: s.file,
    }));
  }

  function saveSkill(body) {
    const name = String(body.name ?? '').trim();
    if (!name) throw Object.assign(new Error('技能名不能为空'), { status: 400 });
    const slug = name.replace(/[^\w\u4e00-\u9fff-]/g, '_').slice(0, 60);
    const triggers = Array.isArray(body.triggers) ? body.triggers : String(body.triggers ?? '').split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
    const content = [
      '---',
      `name: ${name}`,
      `description: ${String(body.description ?? '').replace(/\n/g, ' ')}`,
      `triggers: ${triggers.join(', ')}`,
      '---',
      '',
      String(body.body ?? ''),
      '',
    ].join('\n');
    const file = path.join(skillsDir(), `${slug}.md`);
    ensureDir(skillsDir());
    fs.writeFileSync(file, content, 'utf8');
    svc.rag.build({ force: true });
    return { ok: true, file: `${slug}.md`, skills: skillList() };
  }

  function deleteSkill(name) {
    const target = svc.rag.skills().find((s) => s.name === name || s.file === name);
    if (!target) throw Object.assign(new Error(`技能不存在: ${name}`), { status: 404 });
    fs.rmSync(path.join(skillsDir(), target.file), { force: true });
    svc.rag.build({ force: true });
    return { ok: true, skills: skillList() };
  }

  function maskedProfiles() {
    return (cfg.profiles ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.model,
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      apiKeySet: Boolean(p.apiKey) || Boolean(PRESETS[p.provider]?.needsKey === false),
      apiKeyHint: p.apiKey ? `${p.apiKey.slice(0, 3)}…${p.apiKey.slice(-4)}` : '',
    }));
  }

  function upsertProfile(body) {
    const list = [...(cfg.profiles ?? [])];
    const id = body.id || body.profile?.id;
    const idx = id ? list.findIndex((p) => p.id === id) : -1;
    const incoming = body.profile ?? body;
    if (idx >= 0) {
      const cur = list[idx];
      const next = { ...cur, ...incoming };
      // 没填 Key 就保留原来的，避免误清空
      if (!incoming.apiKey) next.apiKey = cur.apiKey;
      if (incoming.provider && incoming.provider !== cur.provider) {
        const preset = PRESETS[incoming.provider] ?? PRESETS.custom;
        if (!incoming.baseUrl) next.baseUrl = preset.baseUrl ?? '';
        if (!incoming.model) next.model = preset.model ?? '';
      }
      list[idx] = next;
    } else {
      list.push(newProfile(incoming));
    }
    saveConfig(root, { profiles: list, activeProfileId: body.activate ? (list[idx >= 0 ? idx : list.length - 1].id) : cfg.activeProfileId });
    reloadServices();
    return { ok: true, profiles: maskedProfiles(), activeProfileId: cfg.activeProfileId };
  }

  function activateProfile(id) {
    if (!(cfg.profiles ?? []).some((p) => p.id === id)) throw Object.assign(new Error(`配置不存在: ${id}`), { status: 404 });
    saveConfig(root, { activeProfileId: id });
    reloadServices();
    const p = svc.runner.provider;
    broadcast('toast', { level: 'ok', message: `已切换到 ${p.label} · ${cfg.model}${p.ready ? '' : `（${p.note}）`}` });
    return { ok: true, activeProfileId: id, provider: { name: p.name, label: p.label, ready: p.ready, note: p.note, model: cfg.model } };
  }

  function deleteProfile(id) {
    const list = (cfg.profiles ?? []).filter((p) => p.id !== id);
    if (!list.length) throw Object.assign(new Error('至少要保留一个配置'), { status: 400 });
    const activeProfileId = cfg.activeProfileId === id ? list[0].id : cfg.activeProfileId;
    saveConfig(root, { profiles: list, activeProfileId });
    reloadServices();
    return { ok: true, profiles: maskedProfiles(), activeProfileId };
  }

  function setProject(body) {
    const dir = String(body.dir ?? '').trim();
    const mode = body.mode === 'staging' ? 'staging' : 'direct';
    let warning = null;
    if (dir) {
      const abs = path.resolve(dir);
      let st = null;
      try {
        st = fs.statSync(abs);
      } catch { /* 下面统一报错 */ }
      if (!st || !st.isDirectory()) {
        throw Object.assign(new Error(`目录不存在或不是文件夹: ${abs}`), { status: 400 });
      }
      // 盘符根目录 / 用户主目录这种"巨大且不该当项目"的目录，先劝一句
      const isRoot = path.dirname(abs) === abs;
      if (isRoot) {
        warning = `${abs} 是磁盘根目录，把它当项目会扫描海量无关文件。建议选到具体的项目文件夹。`;
      }
      saveConfig(root, { projectDir: abs, writeMode: mode });
    } else {
      saveConfig(root, { projectDir: '', writeMode: 'direct' });
    }
    const t0 = Date.now();
    try {
      reloadServices();
    } catch (err) {
      // 切换失败要把话说清楚，而不是丢一个 500 让界面卡在那儿
      throw Object.assign(new Error(`切换失败：${err.message}`), { status: 500 });
    }
    const ms = Date.now() - t0;
    if (!warning && svc.fileCount > 1200) {
      warning = `这个目录有 ${svc.fileCount} 个文件，体积偏大；检索与风格扫描会自动限量，但建议选到更精确的项目根目录。`;
    }
    broadcast('toast', {
      level: warning ? 'warn' : 'ok',
      message: dir
        ? `已切换到 ${svc.projectDir}（${svc.writeMode === 'staging' ? '暂存模式' : '直接写入'}）· ${svc.fileCount} 个文件 · 用时 ${ms}ms`
        : '已切回默认 workspace 目录',
    });
    return { ok: true, projectDir: svc.projectDir, writeMode: svc.writeMode, staging: svc.workspace.staging, fileCount: svc.fileCount, ms, warning };
  }

  function visiblePresets() {
    return Object.fromEntries(
      Object.entries(PRESETS)
        .filter(([k, v]) => !v.hidden || allowMock || k === cfg.provider)
        .map(([k, v]) => [k, { label: v.label, baseUrl: v.baseUrl, model: v.model, needsKey: v.needsKey }]),
    );
  }

  /* ------------------------------ 静态资源 ------------------------------ */

  function serveMonaco(route, res) {
    const rel = route.replace(/^\/vendor\/monaco\/?/, '');
    let file = path.resolve(MONACO_MIN, rel);
    if (!file.startsWith(MONACO_MIN)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
    });
    fs.createReadStream(file).pipe(res);
  }

  function serveStatic(route, res) {
    const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
    let file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
    get runner() {
      return svc.runner;
    },
    get session() {
      return svc.session;
    },
    get workspace() {
      return svc.workspace;
    },
    get rag() {
      return svc.rag;
    },
    get memory() {
      return svc.memory;
    },
    get config() {
      return cfg;
    },
    projectRoot: root,
    get projectDir() {
      return svc.projectDir;
    },
    get workspaceDir() {
      return svc.projectDir;
    },
    reloadServices,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          if (err.code === 'EADDRINUSE') {
            console.error('');
            console.error(`  ✗ 端口 ${port ?? cfg.port} 已经被占用。`);
            console.error(`    很可能已经有一个 SynthFlow 在跑了 —— 直接打开 http://127.0.0.1:${port ?? cfg.port}/ 就能用。`);
            console.error('    想再开一个实例：node src/server.js --port 7799');
            console.error('');
          }
          reject(err);
        };
        server.once('error', onError);
        server.listen(port ?? cfg.port, host, () => {
          server.off('error', onError);
          resolve(server.address());
        });
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
    saveMode: cfg.saveMode ?? 'manual',
    suggest: cfg.suggest,
    compactStyle: cfg.compactStyle ?? 'balanced',
    streamLimitKB: cfg.streamLimitKB ?? 1024,
    customInstructions: cfg.customInstructions ?? '',
    projectDir: cfg.projectDir ?? '',
    writeMode: cfg.writeMode ?? 'direct',
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
      if (data.length > 16 * 1024 * 1024) reject(new Error('请求体过大'));
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
  console.log(`  目标项目   ${app.projectDir}${app.workspace.staging ? '   [暂存模式：改动需确认后应用]' : '   [直接写入]'}`);
  console.log(`  目标项目文件数 ${app.workspace.listFiles().length} / ${bytesToHuman(app.workspace.totalBytes())}`);
  console.log(`  本地数据   ${path.join(app.projectRoot, '.synthflow')}`);
  console.log(`  编辑器     ${fs.existsSync(MONACO_DIR) ? 'Monaco（VS Code 内核）' : '未安装 monaco-editor，将降级为只读高亮'}`);
  console.log(`  模型       ${app.runner.provider.label} · ${cfg.model || '(未设置)'} · ${app.runner.provider.ready ? '就绪' : '未就绪'}`);
  if (!app.runner.provider.ready) console.log(`             ${app.runner.provider.note}`);
  console.log('  停止服务   Ctrl + C');
  console.log('');
  if (args.open || process.env.SYNTHFLOW_OPEN === '1') {
    const { spawn } = await import('node:child_process');
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}
