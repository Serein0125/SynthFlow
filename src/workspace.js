// SynthFlow 工作区：受沙箱约束的文件读写 + 补丁应用 + 版本快照。
//
// v3 起支持"目标项目"模式（想法 4/D）：
//   · 直接模式（overlayDir === root）：写盘立即生效，和以前一样
//   · 暂存模式（overlayDir = .synthflow/staging）：读 = 暂存层优先、否则读真实项目；
//     写 = 只写暂存层；用户确认后才由 applyPending() 落到真实项目。
//   这样 AI 永远不会在你没点确认之前改坏已有项目，同时又能看到项目的真实内容与风格。
import fs from 'node:fs';
import path from 'node:path';
import {
  diffLines,
  ensureDir,
  listFilesRecursive,
  nowIso,
  newId,
  readJsonSafe,
  resolveInside,
  sha1,
  splitLines,
  writeJsonAtomic,
} from './util.js';

const TEXT_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'json', 'md', 'markdown',
  'css', 'scss', 'less', 'html', 'htm', 'txt', 'yml', 'yaml', 'toml', 'ini', 'env',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'php', 'sh', 'ps1', 'sql', 'xml', 'svg', 'gitignore',
]);

const IGNORE_DIRS = [
  '.git', 'node_modules', '.synthflow', '.cache', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.turbo', '.svelte-kit', 'vendor', '.venv', 'venv', '__pycache__',
  '.idea', '.vscode', 'target', 'bin', 'obj',
];

const MAX_READ_BYTES = 512 * 1024; // 超过这个大小的文件不读进内存（避免误读大产物）
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
// 单次快照的总量与数量上限：防止"切到一个大目录 → 把整个项目复制进版本库"
const SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_MAX_FILES = 1500;

export function isTextFile(rel) {
  const base = path.basename(rel);
  if (base.startsWith('.') && !base.includes('.')) return true;
  const ext = base.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXT.has(ext) || !base.includes('.');
}

/** 在 haystack 中定位 needle：先精确，再按"忽略首尾空白 + 行归一"模糊匹配。 */
export function locateBlock(haystack, needle) {
  const text = String(haystack ?? '');
  const target = String(needle ?? '');
  if (!target.trim()) return null;
  const exact = text.indexOf(target);
  if (exact >= 0) return { start: exact, end: exact + target.length, kind: 'exact' };

  const norm = (s) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).join('\n').trim();
  const targetLines = splitLines(target);
  const targetNorm = norm(target);
  if (!targetNorm) return null;
  const lines = splitLines(text);

  for (let size = targetLines.length; size >= Math.max(1, targetLines.length - 1); size -= 1) {
    for (let i = 0; i + size <= lines.length; i += 1) {
      const windowNorm = norm(lines.slice(i, i + size).join('\n'));
      if (windowNorm === targetNorm) {
        const start = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
        const end = start + lines.slice(i, i + size).join('\n').length;
        return { start, end, kind: 'normalized' };
      }
    }
  }

  const first = targetLines.find((l) => l.trim().length > 3);
  if (first) {
    const anchor = lines.findIndex((l) => l.trim() === first.trim());
    if (anchor >= 0) {
      const start = lines.slice(0, anchor).join('\n').length + (anchor > 0 ? 1 : 0);
      const useLines = lines.slice(anchor, anchor + targetLines.length);
      const end = start + useLines.join('\n').length;
      return { start, end, kind: 'anchor' };
    }
  }
  return null;
}

export class Workspace {
  #scan = null;

  /**
   * @param {string} root 目标目录（真实项目或生成目录）
   * @param {{storeDir?:string, overlayDir?:string, maxSnapshots?:number}} [opts]
   */
  constructor(root, opts = {}) {
    this.root = path.resolve(root);
    this.storeDir = path.resolve(opts.storeDir ?? path.join(this.root, '..', '.synthflow'));
    this.overlayDir = path.resolve(opts.overlayDir ?? this.root);
    this.staging = this.overlayDir !== this.root;
    this.maxSnapshots = opts.maxSnapshots ?? 60;
    this.stateFile = path.join(this.storeDir, 'staging.json');
    // 注意：不能用 mkdirSync(root, {recursive:true}) 去"确保"根目录存在 ——
    // 对盘符根目录（D:\）它会直接 EPERM。只在真的不存在时才建。
    if (!fs.existsSync(this.root)) ensureDir(this.root);
    if (this.staging && !fs.existsSync(this.overlayDir)) ensureDir(this.overlayDir);
    ensureDir(this.snapshotsDir);
    ensureDir(this.historyDir);
    const st = readJsonSafe(this.stateFile, { deleted: [] });
    this.deleted = new Set(st.deleted ?? []);
  }

  get snapshotsDir() {
    return path.join(this.storeDir, 'snapshots');
  }

  get historyDir() {
    return path.join(this.storeDir, 'history');
  }

  /** 写路径（暂存模式下是暂存层）。 */
  abs(rel) {
    return resolveInside(this.overlayDir, rel);
  }

  absRead(rel) {
    return resolveInside(this.root, rel);
  }

  absAt(base, rel) {
    return resolveInside(base, rel);
  }

  saveState() {
    writeJsonAtomic(this.stateFile, { deleted: [...this.deleted] });
  }

  /** 暂存层里是否有这个文件（而不是项目里）。 */
  stagedAbsolute(rel) {
    try {
      return fs.existsSync(resolveInside(this.overlayDir, rel).abs);
    } catch {
      return false;
    }
  }

  exists(rel) {
    try {
      if (this.deleted.has(rel)) return false;
      const { abs } = this.absRead(rel);
      if (fs.existsSync(abs)) return true;
      return this.staging && fs.existsSync(this.abs(rel).abs);
    } catch {
      return false;
    }
  }

  /** 读取：暂存层优先，否则读真实项目。 */
  read(rel) {
    let r;
    try {
      r = this.absRead(rel);
    } catch {
      return null;
    }
    const candidates = this.staging ? [this.abs(rel).abs, r.abs] : [r.abs];
    for (const abs of candidates) {
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          if (fs.statSync(abs).size > MAX_READ_BYTES) return { rel: r.rel, content: '', bytes: 0, tooLarge: true };
          return { rel: r.rel, content: fs.readFileSync(abs, 'utf8'), bytes: fs.statSync(abs).size };
        }
      } catch { /* 换下一个候选 */ }
    }
    return null;
  }

  /** 写入永远落到暂存层（暂存模式下不会碰真实项目）。 */
  write(rel, content) {
    const { abs, rel: r } = this.abs(rel);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content, 'utf8');
    if (this.deleted.delete(r)) this.saveState();
    this.invalidateScan();
    return { rel: r, bytes: Buffer.byteLength(content, 'utf8') };
  }

  remove(rel) {
    const { rel: r } = this.abs(rel);
    if (this.staging) {
      const inOverlay = this.stagedAbsolute(r);
      if (inOverlay) fs.rmSync(this.abs(r).abs, { force: true, recursive: true });
      // 项目里存在的文件：只记录"待删除"，等用户确认后才真删
      const inProject = fs.existsSync(this.absRead(r).abs);
      if (inProject) {
        this.deleted.add(r);
        this.saveState();
      }
    } else if (fs.existsSync(this.abs(r).abs)) {
      fs.rmSync(this.abs(r).abs, { force: true, recursive: true });
    }
    this.invalidateScan();
    return r;
  }

  /**
   * 一次扫描拿到全部元数据（路径 + 大小 + mtime），缓存起来复用。
   * 之前 listFiles / totalBytes / listTree 各自遍历一遍，而且 totalBytes 和 listTree
   * 为了拿 size 会把**每个文件的内容读一遍** —— 2500 个文件的项目上 /api/state 要 2.3 秒。
   * 现在统一走 statSync，并带缓存；我们自己的写操作会主动失效。
   */
  scan({ force = false } = {}) {
    // 大目录下"每次状态刷新都重扫一遍"也会卡；TTL 放宽到 4 秒，
    // 我们自己的写操作会立刻 invalidate，用户手动刷新走 ?force=1。
    const TTL = 4000;
    if (!force && this.#scan && Date.now() - this.#scan.at < TTL) return this.#scan;
    const entries = new Map(); // rel -> {bytes, mtime}
    const collect = (base, isOverlay) => {
      for (const rel of listFilesRecursive(base, { ignore: IGNORE_DIRS })) {
        if (!isTextFile(rel)) continue;
        let st;
        try {
          st = fs.statSync(path.join(base, rel));
        } catch {
          continue;
        }
        if (st.size > MAX_READ_BYTES) continue;
        // 暂存层优先：同名文件以 overlay 的为准
        if (!isOverlay && entries.has(rel)) continue;
        entries.set(rel, { bytes: st.size, mtime: st.mtimeMs, staged: isOverlay });
      }
    };
    if (this.staging) collect(this.overlayDir, true);
    collect(this.root, false);
    for (const d of this.deleted) entries.delete(d);
    let bytes = 0;
    for (const v of entries.values()) bytes += v.bytes;
    this.#scan = { at: Date.now(), entries, bytes, files: [...entries.keys()].sort() };
    return this.#scan;
  }

  invalidateScan() {
    this.#scan = null;
  }

  /** 合并视图下的全部文件。force 会跳过缓存重新扫描。 */
  listFiles({ force = false } = {}) {
    return this.scan({ force }).files;
  }

  totalBytes({ force = false } = {}) {
    return this.scan({ force }).bytes;
  }

  fileStats(rel) {
    return this.scan().entries.get(rel) ?? null;
  }

  listTree() {
    const snap = this.scan();
    const pending = this.pendingRels();
    const root = { name: path.basename(this.root), path: '', type: 'dir', children: [] };
    const dirIndex = new Map([['', root]]);
    const ensureDirNode = (dirPath) => {
      if (dirIndex.has(dirPath)) return dirIndex.get(dirPath);
      const parent = ensureDirNode(dirPath.split('/').slice(0, -1).join('/'));
      const node = { name: dirPath.split('/').pop(), path: dirPath, type: 'dir', children: [] };
      parent.children.push(node);
      dirIndex.set(dirPath, node);
      return node;
    };
    for (const f of snap.files) {
      const dir = f.split('/').slice(0, -1).join('/');
      const meta = snap.entries.get(f);
      const node = { name: f.split('/').pop(), path: f, type: 'file', size: meta?.bytes ?? 0, lang: f.split('.').pop() };
      if (pending.has(f)) node.pending = true;
      ensureDirNode(dir).children.push(node);
    }
    const sortNode = (n) => {
      if (!Array.isArray(n.children)) return;
      n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      for (const c of n.children) if (c.type === 'dir') sortNode(c);
    };
    sortNode(root);
    return root;
  }

  /* ------------------------- 暂存层（改动待应用） ------------------------- */

  pendingRels() {
    if (!this.staging) return new Set();
    const out = new Set(this.deleted);
    for (const f of listFilesRecursive(this.overlayDir, { ignore: IGNORE_DIRS })) {
      if (isTextFile(f)) out.add(f);
    }
    return out;
  }

  /** 待应用到真实项目的改动清单（带差异与统计）。 */
  pending() {
    if (!this.staging) return [];
    const out = [];
    for (const rel of this.pendingRels()) {      let overlay = null;
      let base = null;
      try {
        const o = this.abs(rel).abs;
        if (fs.existsSync(o)) overlay = fs.readFileSync(o, 'utf8');
      } catch { /* ignore */ }
      try {
        const b = this.absRead(rel).abs;
        if (fs.existsSync(b)) base = fs.readFileSync(b, 'utf8');
      } catch { /* ignore */ }
      if (overlay === base) continue;
      const diff = diffLines(base ?? '', overlay ?? '');
      out.push({
        path: rel,
        status: base === null ? 'added' : overlay === null ? 'deleted' : 'modified',
        added: diff.filter((d) => d.type === 'ins').length,
        removed: diff.filter((d) => d.type === 'del').length,
        diff,
      });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** 把暂存层的改动真正写进目标项目。 */
  applyPending() {
    if (!this.staging) return { applied: [], deleted: [] };
    const items = this.pending();
    const applied = [];
    const deleted = [];
    for (const item of items) {
      const target = this.absRead(item.path);
      if (item.status === 'deleted') {
        if (fs.existsSync(target.abs)) fs.rmSync(target.abs, { force: true });
        deleted.push(item.path);
      } else {
        const src = this.abs(item.path).abs;
        ensureDir(path.dirname(target.abs));
        fs.copyFileSync(src, target.abs);
        applied.push(item.path);
      }
    }
    this.clearStaging();
    return { applied, deleted };
  }

  /** 丢弃所有暂存改动（真实项目分毫未动）。 */
  discardPending() {
    if (!this.staging) return { discarded: 0 };
    const count = this.pendingRels().size;
    this.clearStaging();
    return { discarded: count };
  }

  clearStaging() {
    if (this.staging) {
      for (const f of listFilesRecursive(this.overlayDir)) {
        try {
          fs.rmSync(path.join(this.overlayDir, f), { force: true });
        } catch { /* ignore */ }
      }
      this.cleanupEmptyDirs(this.overlayDir);
    }
    this.deleted = new Set();
    this.saveState();
    this.invalidateScan();
  }

  /* ------------------------------ 补丁应用 ------------------------------ */

  applyOp(op) {
    const rel = String(op.path || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!rel) return { path: '', ok: false, mode: op.mode, error: '缺少 path' };
    let target;
    try {
      target = this.abs(rel);
    } catch (err) {
      return { path: rel, ok: false, mode: op.mode, error: err.message };
    }
    const existing = this.read(rel);
    const before = existing?.content ?? null;

    if (op.mode === 'delete') {
      if (!this.exists(rel)) return { path: target.rel, ok: false, mode: 'delete', error: '文件不存在' };
      this.remove(target.rel);
      return { path: target.rel, ok: true, mode: 'delete', before, after: '', diff: diffLines(before ?? '', ''), changedLines: splitLines(before ?? '').length };
    }

    if (before === null || existing?.tooLarge) {
      const content = op.content ?? '';
      this.write(target.rel, content);
      return { path: target.rel, ok: true, mode: 'create', before: null, after: content, diff: diffLines('', content), changedLines: splitLines(content).length };
    }

    if (op.mode === 'patch') {
      let content = before;
      const notes = [];
      let appliedCount = 0;
      for (const p of op.patches ?? []) {
        const hit = locateBlock(content, p.search);
        if (!hit) {
          notes.push(`未匹配片段: ${p.search.trim().split('\n')[0].slice(0, 40)}`);
          continue;
        }
        content = content.slice(0, hit.start) + p.replace + content.slice(hit.end);
        appliedCount += 1;
      }
      if (appliedCount === 0) {
        return { path: target.rel, ok: false, mode: 'patch', error: `补丁未命中（${notes.join('; ')}）`, before, after: before };
      }
      this.write(target.rel, content);
      return {
        path: target.rel,
        ok: true,
        mode: 'patch',
        before,
        after: content,
        appliedCount,
        totalPatches: (op.patches ?? []).length,
        warning: notes.length ? notes.join('; ') : undefined,
        diff: diffLines(before, content),
        changedLines: diffLines(before, content).filter((d) => d.type !== 'same').length,
      };
    }

    const content = op.content ?? '';
    this.write(target.rel, content);
    return { path: target.rel, ok: true, mode: 'rewrite', before, after: content, diff: diffLines(before, content), changedLines: diffLines(before, content).filter((d) => d.type !== 'same').length };
  }

  /* ------------------------------ 版本快照 ------------------------------ */

  listSnapshots() {
    const index = readJsonSafe(path.join(this.snapshotsDir, 'index.json'), { snapshots: [] });
    return index.snapshots ?? [];
  }

  snapshot({ label = '', turnId = '', segmentIds = [], runId = '', meta = {} } = {}) {
    const list = this.listSnapshots();
    const seq = list.length ? Math.max(...list.map((s) => s.seq)) + 1 : 1;
    const id = `v${seq}_${newId('snap').split('_')[1]}`;
    const dir = path.join(this.snapshotsDir, id);
    const filesDir = path.join(dir, 'files');
    ensureDir(filesDir);
    const manifest = {};
    let bytes = 0;
    let skipped = 0;
    for (const rel of this.listFiles()) {
      if (Object.keys(manifest).length >= SNAPSHOT_MAX_FILES || bytes >= SNAPSHOT_TOTAL_BYTES) {
        skipped += 1;
        continue;
      }
      const f = this.read(rel);
      if (!f || f.tooLarge) continue;
      if (bytes + f.bytes > SNAPSHOT_TOTAL_BYTES && Object.keys(manifest).length > 0) {
        skipped += 1;
        continue;
      }
      const dest = path.join(filesDir, rel);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, f.content, 'utf8');
      manifest[rel] = sha1(f.content);
      bytes += f.bytes;
    }
    const rec = {
      id, seq, label, turnId, segmentIds, runId, createdAt: nowIso(),
      fileCount: Object.keys(manifest).length, bytes, skipped, meta,
    };
    writeJsonAtomic(path.join(dir, 'manifest.json'), { ...rec, files: manifest });
    list.push(rec);
    writeJsonAtomic(path.join(this.snapshotsDir, 'index.json'), { snapshots: list });
    this.prune();
    return rec;
  }

  /**
   * 空快照：什么都不复制，只用于"暂存模式的基线"。
   * 暂存层为空 = 项目原样，所以回退到它只需要清空暂存层 —— 不需要真的把项目复制一份。
   */
  emptySnapshot({ label = '基线（项目原样）', meta = {} } = {}) {
    const list = this.listSnapshots();
    const seq = list.length ? Math.max(...list.map((s) => s.seq)) + 1 : 1;
    const id = `v${seq}_${newId('snap').split('_')[1]}`;
    const dir = path.join(this.snapshotsDir, id);
    ensureDir(path.join(dir, 'files'));
    const rec = { id, seq, label, createdAt: nowIso(), fileCount: 0, bytes: 0, skipped: 0, meta: { ...meta, kind: 'staging-baseline' } };
    writeJsonAtomic(path.join(dir, 'manifest.json'), { ...rec, files: {} });
    list.push(rec);
    writeJsonAtomic(path.join(this.snapshotsDir, 'index.json'), { snapshots: list });
    this.prune();
    return rec;
  }

  prune() {
    const list = this.listSnapshots();
    if (list.length <= this.maxSnapshots) return 0;
    const losers = list.slice(0, list.length - this.maxSnapshots);
    for (const s of losers) fs.rmSync(path.join(this.snapshotsDir, s.id), { recursive: true, force: true });
    const keep = list.slice(list.length - this.maxSnapshots);
    writeJsonAtomic(path.join(this.snapshotsDir, 'index.json'), { snapshots: keep });
    return losers.length;
  }

  /** 读某个快照里的某个文件（用于"与历史版本对比"）。 */
  readFromSnapshot(snapshotId, rel) {
    try {
      const { rel: r } = resolveInside(this.root, rel);
      const file = path.join(this.snapshotsDir, snapshotId, 'files', r);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  /** 只读目标项目本身（不看暂存层）。 */
  readProject(rel) {
    try {
      const { abs } = this.absRead(rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return fs.readFileSync(abs, 'utf8');
    } catch { /* ignore */ }
    return null;
  }

  /** 回退：清空当前写入层，再按快照内容重建（暂存模式下真实项目不会被触碰）。 */
  restore(snapshotId) {
    const dir = path.join(this.snapshotsDir, snapshotId);
    const man = readJsonSafe(path.join(dir, 'manifest.json'), null);
    if (!man) throw new Error(`快照不存在: ${snapshotId}`);
    const want = man.files ?? {};
    if (this.staging) {
      this.clearStaging();
      // "暂存模式的基线"= 项目原样。它本来就不含任何文件，
      // 所以回退到它只需要清空暂存层，绝不能把项目里的文件全标记成"待删除"。
      if (man.meta?.kind === 'staging-baseline') {
        return { snapshotId, restored: 0, files: [], meta: man };
      }
      // 暂存模式下只把"与项目不同"的文件放进暂存层：
      // 否则一次回退会把整个项目复制进 staging，白白占一份磁盘。
      for (const rel of Object.keys(want)) {
        const src = path.join(dir, 'files', rel);
        if (!fs.existsSync(src)) continue;
        const content = fs.readFileSync(src, 'utf8');
        if (this.readProject(rel) === content) continue;
        this.write(rel, content);
      }
      // 快照里没有、但项目里有的文件 → 标记为"待删除"
      for (const rel of this.listProjectFiles()) {
        if (!(rel in want)) this.deleted.add(rel);
      }
      if (this.deleted.size) this.saveState();
      return { snapshotId, restored: this.pendingRels().size, files: [...this.pendingRels()], meta: man };
    }
    // 直接模式：工作区由 SynthFlow 独占管理，整目录重建才等价于"回到那一版"
    for (const rel of this.listFiles()) {
      try {
        fs.rmSync(this.abs(rel).abs, { force: true });
      } catch { /* ignore */ }
    }
    this.cleanupEmptyDirs(this.root);
    const written = [];
    for (const rel of Object.keys(want)) {
      const src = path.join(dir, 'files', rel);
      if (!fs.existsSync(src)) continue;
      this.write(rel, fs.readFileSync(src, 'utf8'));
      written.push(rel);
    }
    return { snapshotId, restored: written.length, files: written, meta: man };
  }

  listProjectFiles() {
    return listFilesRecursive(this.root, { ignore: IGNORE_DIRS }).filter(isTextFile);
  }

  cleanupEmptyDirs(base = this.root) {
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name));
      try {
        if (dir !== base && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch { /* ignore */ }
    };
    walk(base);
  }

  /** 生成一段紧凑的"项目地图"，用于塞进模型上下文。 */
  repoMap(maxFiles = 40, maxChars = 6000) {
    const files = this.listFiles();
    const lines = [];
    for (const rel of files.slice(0, maxFiles)) {
      const f = this.read(rel);
      if (!f) continue;
      const symbols = [];
      const re = /(?:export\s+)?(?:async\s+)?(?:function|class|const|let|def|interface|type|struct)\s+([A-Za-z_$][\w$]*)/g;
      let m;
      while ((m = re.exec(f.content)) && symbols.length < 8) symbols.push(m[1]);
      lines.push(`${rel} (${splitLines(f.content).length} 行)${symbols.length ? ` — ${symbols.join(', ')}` : ''}`);
    }
    if (files.length > maxFiles) lines.push(`… 另有 ${files.length - maxFiles} 个文件未列出`);
    return lines.join('\n').slice(0, maxChars);
  }
}
