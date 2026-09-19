// SynthFlow 基础工具：零依赖，全部基于 Node 内置模块。
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

let __seq = 0;
export function newId(prefix = 'id') {
  __seq += 1;
  return `${prefix}_${Date.now().toString(36)}${__seq.toString(36)}${crypto
    .randomBytes(2)
    .toString('hex')}`;
}

export const nowIso = () => new Date().toISOString();

export const sha1 = (text) => crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function truncate(text, max = 200) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 按行切分，保留行内容（不带换行符）。 */
export function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

/**
 * 行级 LCS 差异。返回 [{ type: 'same'|'ins'|'del', text }]。
 * 主要用于：1) 计算 prompt 漂移量；2) 生成给模型看的锚点补丁；3) UI diff 展示。
 */
export function diffLines(aText, bText) {
  const a = splitLines(aText);
  const b = splitLines(bText);
  const n = a.length;
  const m = b.length;
  // 大文本退化为按块比对，避免 O(n*m) 爆内存。
  if (n * m > 4_000_000) {
    return [
      ...a.map((text) => ({ type: 'del', text })),
      ...b.map((text) => ({ type: 'ins', text })),
    ];
  }
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[at(i, j)] =
        a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      out.push({ type: 'del', text: a[i] });
      i += 1;
    } else {
      out.push({ type: 'ins', text: b[j] });
      j += 1;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'ins', text: b[j++] });
  return out;
}

/** 归一化的相似度 0..1（字符 3-gram 的 Dice 系数，速度快、对中文友好、对"追加"不敏感）。 */
export function similarity(aText, bText) {
  const a = String(aText ?? '');
  const b = String(bText ?? '');
  if (a === b) return 1;
  if (!a || !b) return 0;
  const grams = (s) => {
    const set = new Set();
    const t = s.replace(/\s+/g, ' ').trim();
    if (t.length <= 3) set.add(t);
    for (let i = 0; i + 3 <= t.length; i += 1) set.add(t.slice(i, i + 3));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  const denom = ga.size + gb.size;
  return denom === 0 ? 0 : (2 * inter) / denom;
}

/** 取新旧文本的"变更跨度"，用于把前文修改锚定到对应片段。 */
export function changedSpan(prevText, nextText) {
  const a = String(prevText ?? '');
  const b = String(nextText ?? '');
  let start = 0;
  const maxStart = Math.min(a.length, b.length);
  while (start < maxStart && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return {
    start,
    removed: a.slice(start, endA),
    added: b.slice(start, endB),
    prefix: a.slice(0, start),
    isAppend: start === a.length,
    isPureDelete: endB === start,
  };
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/** 轻量分词：拉丁词 + 数字 + 中文单字 & 双字组，供 BM25 检索使用。 */
export function tokenize(text) {
  const raw = String(text ?? '').toLowerCase();
  const out = [];
  const latin = raw.match(/[a-z_$][a-z0-9_$.-]{1,}|[0-9]+/g) ?? [];
  out.push(...latin);
  const cjkRun = raw.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRun) {
    for (let i = 0; i < run.length; i += 1) {
      out.push(run[i]);
      if (i + 2 <= run.length) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

export const hasCJK = (text) => CJK.test(String(text ?? ''));

/** 统计缩进风格、引号风格等"代码习惯"信号，用于用户习惯记忆。 */
export function codeStyleSignals(text) {
  const s = String(text ?? '');
  const lines = splitLines(s).filter((l) => l.trim().length > 0);
  const indents = lines
    .map((l) => (l.match(/^[ \t]+/) ?? [''])[0])
    .filter(Boolean)
    .map((l) => (l.includes('\t') ? 'tab' : l.length));
  const counts = new Map();
  for (const v of indents) counts.set(v, (counts.get(v) ?? 0) + 1);
  let indent = null;
  let best = 0;
  for (const [k, v] of counts) if (v > best) { best = v; indent = k; }
  const single = (s.match(/'/g) ?? []).length;
  const double = (s.match(/"/g) ?? []).length;
  const semi = (s.match(/;$/gm) ?? []).length;
  return {
    indent,
    quotes: double > single ? 'double' : single > double ? 'single' : null,
    semicolons: semi > lines.length * 0.25,
    blankLineRatio: lines.length ? 1 - lines.filter((l) => l.trim()).length / (lines.length || 1) : 0,
  };
}

/* ------------------------------------------------------------------ *
 * 路径沙箱：任何文件操作都必须落在 root 之内，杜绝 ../ 逃逸。
 * ------------------------------------------------------------------ */
export function resolveInside(root, relPath) {
  const rootAbs = path.resolve(root);
  const raw = String(relPath ?? '');
  if (!raw.trim()) throw new Error('空路径');
  // 先按"原始输入"判定绝对路径，再做任何清洗，否则 /etc/passwd 会被悄悄改写成相对路径。
  if (/^[a-zA-Z]:/.test(raw) || /^[/\\]/.test(raw) || raw.startsWith('~')) {
    throw new Error(`非法绝对路径: ${relPath}`);
  }
  const cleaned = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!cleaned) throw new Error('空路径');
  const abs = path.resolve(rootAbs, cleaned);
  const rel = path.relative(rootAbs, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径逃逸被拒绝: ${relPath}`);
  return { abs, rel: rel.split(path.sep).join('/') };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function listFilesRecursive(root, opts = {}) {
  const { ignore = ['.git', 'node_modules', '.synthflow', '.cache'], maxFiles = 3000 } = opts;
  const out = [];
  const walk = (dir, rel) => {
    if (out.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (ignore.includes(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel);
      else if (e.isFile()) out.push(childRel);
      if (out.length >= maxFiles) return;
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}

export function bytesToHuman(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
