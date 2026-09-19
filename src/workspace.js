// SynthFlow 工作区：受沙箱约束的文件读写 + 补丁应用 + 版本快照（回退能力的地基）。
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

export function isTextFile(rel) {
  const base = path.basename(rel);
  if (base.startsWith('.') && !base.includes('.')) return true;
  const ext = base.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXT.has(ext) || !base.includes('.');
}

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024; // 单文件快照上限，防止把大二进制塞进版本库

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

  // 滑动窗口逐行归一比对；允许 1 行偏移容错。
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

  // 最后兜底：找与目标首行最相似的锚点。
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
  /**
   * @param {string} root 工作区根目录（生成的代码全部落在这里，任何路径逃逸都会被拒绝）
   * @param {{storeDir?:string, maxSnapshots?:number}} [opts]
   */
  constructor(root, opts = {}) {
    this.root = path.resolve(root);
    this.storeDir = path.resolve(opts.storeDir ?? path.join(this.root, '..', '.synthflow'));
    this.maxSnapshots = opts.maxSnapshots ?? 60;
    ensureDir(this.root);
    ensureDir(this.snapshotsDir);
    ensureDir(this.historyDir);
  }

  get snapshotsDir() {
    return path.join(this.storeDir, 'snapshots');
  }

  get historyDir() {
    return path.join(this.storeDir, 'history');
  }

  abs(rel) {
    return resolveInside(this.root, rel);
  }

  exists(rel) {
    try {
      return fs.existsSync(this.abs(rel).abs);
    } catch {
      return false;
    }
  }

  read(rel) {
    const { abs, rel: r } = this.abs(rel);
    if (!fs.existsSync(abs)) return null;
    return { rel: r, content: fs.readFileSync(abs, 'utf8'), bytes: fs.statSync(abs).size };
  }

  write(rel, content) {
    const { abs, rel: r } = this.abs(rel);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content, 'utf8');
    return { rel: r, bytes: Buffer.byteLength(content, 'utf8') };
  }

  remove(rel) {
    const { abs, rel: r } = this.abs(rel);
    if (fs.existsSync(abs)) fs.rmSync(abs, { force: true, recursive: true });
    return r;
  }

  /** 供 UI 使用的文件树。 */
  listTree() {
    const files = listFilesRecursive(this.root).filter(isTextFile);
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
    for (const f of files) {
      const dir = f.split('/').slice(0, -1).join('/');
      let size = 0;
      try {
        size = fs.statSync(path.join(this.root, f)).size;
      } catch { /* ignore */ }
      ensureDirNode(dir).children.push({ name: f.split('/').pop(), path: f, type: 'file', size, lang: f.split('.').pop() });
    }
    const sortNode = (n) => {
      if (!Array.isArray(n.children)) return;
      n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      for (const c of n.children) if (c.type === 'dir') sortNode(c);
    };
    sortNode(root);
    return root;
  }

  listFiles() {
    return listFilesRecursive(this.root).filter(isTextFile);
  }

  totalBytes() {
    let total = 0;
    for (const f of this.listFiles()) {
      try {
        total += fs.statSync(path.join(this.root, f)).size;
      } catch { /* ignore */ }
    }
    return total;
  }

  /**
   * 应用一次模型产出的文件操作。
   * @returns {{path:string, ok:boolean, mode:string, error?:string, diff?:Array, before?:string, after?:string, changedLines?:number}}
   */
  applyOp(op) {
    const rel = String(op.path || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!rel) return { path: '', ok: false, mode: op.mode, error: '缺少 path' };
    let target;
    try {
      target = this.abs(rel);
    } catch (err) {
      return { path: rel, ok: false, mode: op.mode, error: err.message };
    }
    const before = fs.existsSync(target.abs) ? fs.readFileSync(target.abs, 'utf8') : null;

    if (op.mode === 'delete') {
      if (before === null) return { path: target.rel, ok: false, mode: 'delete', error: '文件不存在' };
      this.remove(target.rel);
      return { path: target.rel, ok: true, mode: 'delete', before, after: '', diff: diffLines(before, ''), changedLines: splitLines(before).length };
    }

    if (before === null) {
      // 新建
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

    // rewrite（含 create 但文件已存在的情况）
    const content = op.content ?? '';
    this.write(target.rel, content);
    return { path: target.rel, ok: true, mode: 'rewrite', before, after: content, diff: diffLines(before, content), changedLines: diffLines(before, content).filter((d) => d.type !== 'same').length };
  }

  /* ------------------------------ 版本快照 ------------------------------ */

  listSnapshots() {
    const index = readJsonSafe(path.join(this.snapshotsDir, 'index.json'), { snapshots: [] });
    return index.snapshots ?? [];
  }

  /** 打一个全量文本快照，返回快照元数据。 */
  snapshot({ label = '', turnId = '', segmentIds = [], runId = '', meta = {} } = {}) {
    const list = this.listSnapshots();
    const seq = list.length ? Math.max(...list.map((s) => s.seq)) + 1 : 1;
    const id = `v${seq}_${newId('snap').split('_')[1]}`;
    const dir = path.join(this.snapshotsDir, id);
    const filesDir = path.join(dir, 'files');
    ensureDir(filesDir);
    const manifest = {};
    let bytes = 0;
    for (const rel of this.listFiles()) {
      const abs = path.join(this.root, rel);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_SNAPSHOT_BYTES) continue;
      const dest = path.join(filesDir, rel);
      ensureDir(path.dirname(dest));
      fs.copyFileSync(abs, dest);
      manifest[rel] = sha1(fs.readFileSync(abs, 'utf8'));
      bytes += stat.size;
    }
    const rec = { id, seq, label, turnId, segmentIds, runId, createdAt: nowIso(), fileCount: Object.keys(manifest).length, bytes, meta };
    writeJsonAtomic(path.join(dir, 'manifest.json'), { ...rec, files: manifest });
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

  /** 回退到某个快照：先清空工作区，再按快照内容重建（工作区由 SynthFlow 独占管理）。 */
  restore(snapshotId) {
    const dir = path.join(this.snapshotsDir, snapshotId);
    const man = readJsonSafe(path.join(dir, 'manifest.json'), null);
    if (!man) throw new Error(`快照不存在: ${snapshotId}`);
    for (const rel of this.listFiles()) {
      try {
        this.remove(rel);
      } catch { /* ignore */ }
    }
    const written = [];
    for (const rel of Object.keys(man.files ?? {})) {
      const src = path.join(dir, 'files', rel);
      if (!fs.existsSync(src)) continue;
      const content = fs.readFileSync(src, 'utf8');
      this.write(rel, content);
      written.push(rel);
    }
    this.cleanupEmptyDirs();
    return { snapshotId, restored: written.length, files: written, meta: man };
  }

  cleanupEmptyDirs() {
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name));
      try {
        if (dir !== this.root && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch { /* ignore */ }
    };
    walk(this.root);
  }

  /** 生成一段紧凑的"项目地图"，用于塞进模型上下文。 */
  repoMap(maxFiles = 40, maxChars = 6000) {
    const files = this.listFiles();
    const lines = [];
    for (const rel of files.slice(0, maxFiles)) {
      let content = '';
      try {
        content = fs.readFileSync(path.join(this.root, rel), 'utf8');
      } catch {
        continue;
      }
      const symbols = [];
      const re = /(?:export\s+)?(?:async\s+)?(?:function|class|const|let|def|interface|type|struct)\s+([A-Za-z_$][\w$]*)/g;
      let m;
      while ((m = re.exec(content)) && symbols.length < 8) symbols.push(m[1]);
      const head = splitLines(content).length;
      lines.push(`${rel} (${head} 行)${symbols.length ? ` — ${symbols.join(', ')}` : ''}`);
    }
    if (files.length > maxFiles) lines.push(`… 另有 ${files.length - maxFiles} 个文件未列出`);
    return lines.join('\n').slice(0, maxChars);
  }
}
