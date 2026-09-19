// SynthFlow 轻量 RAG + Skills（想法 11）
// 纯内置模块实现的 BM25 检索：给模型注入"项目里已有的相关代码片段"，
// 以及 .synthflow/skills/*.md 里定义的技能说明。零依赖、零下载。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, listFilesRecursive, readJsonSafe, sha1, splitLines, tokenize, truncate, writeJsonAtomic } from './util.js';

const CHUNK_LINES = 48;
const CHUNK_OVERLAP = 8;

export class RagIndex {
  constructor(workspace, opts = {}) {
    this.workspace = workspace;
    this.storeDir = workspace.storeDir;
    this.skillsDir = path.join(this.storeDir, 'skills');
    this.indexFile = path.join(this.storeDir, 'index.json');
    this.maxChunkChars = opts.maxChunkChars ?? 1800;
    this.docs = [];
    this.postings = new Map(); // token -> Map(docId -> tf)
    this.docLen = new Map();
    this.avgLen = 1;
    this.builtAt = 0;
    this.signature = '';
    ensureDir(this.skillsDir);
  }

  /** 扫描工作区 + 记忆 + 技能，构建倒排索引。 */
  build({ force = false } = {}) {
    const files = listFilesRecursive(this.workspace.root).filter((f) => /\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte|json|md|css|scss|html|py|go|rs|java|php|sql|yml|yaml|toml|sh)$/i.test(f));
    const sig = sha1(files.map((f) => `${f}:${safeStat(f)}`).join('|'));
    if (!force && sig === this.signature && this.docs.length) return { reused: true, chunks: this.docs.length };
    const cached = readJsonSafe(this.indexFile, null);
    if (!force && cached && cached.signature === sig) {
      this.docs = cached.docs;
      this.avgLen = cached.avgLen;
      this.signature = sig;
      this.builtAt = cached.builtAt;
      this.reindex();
      return { reused: true, chunks: this.docs.length, fromCache: true };
    }

    const docs = [];
    for (const rel of files) {
      let content = '';
      try {
        content = fs.readFileSync(path.join(this.workspace.root, rel), 'utf8');
      } catch {
        continue;
      }
      const lines = splitLines(content);
      if (lines.length <= CHUNK_LINES) {
        docs.push({ id: `${rel}#0`, kind: 'code', source: rel, startLine: 1, endLine: lines.length, text: content });
        continue;
      }
      const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP);
      for (let i = 0; i < lines.length; i += step) {
        const slice = lines.slice(i, i + CHUNK_LINES);
        if (slice.join('').trim().length < 30) continue;
        docs.push({ id: `${rel}#${i}`, kind: 'code', source: rel, startLine: i + 1, endLine: i + slice.length, text: slice.join('\n') });
      }
    }
    for (const skill of this.skills()) {
      docs.push({ id: `skill:${skill.name}`, kind: 'skill', source: skill.file, startLine: 1, endLine: 0, text: `${skill.name}\n${skill.description}\n${skill.body}` });
    }

    this.docs = docs;
    this.signature = sig;
    this.builtAt = Date.now();
    this.reindex();
    writeJsonAtomic(this.indexFile, { signature: sig, builtAt: this.builtAt, avgLen: this.avgLen, docs });
    return { reused: false, chunks: docs.length };
  }

  reindex() {
    this.postings = new Map();
    this.docLen = new Map();
    this.docs.forEach((doc, i) => {
      const tokens = tokenize(`${doc.source} ${doc.text}`);
      this.docLen.set(i, tokens.length);
      const tf = new Map();
      for (const tk of tokens) tf.set(tk, (tf.get(tk) ?? 0) + 1);
      for (const [tk, n] of tf) {
        if (!this.postings.has(tk)) this.postings.set(tk, new Map());
        this.postings.get(tk).set(i, n);
      }
    });
    const lens = [...this.docLen.values()];
    this.avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 1;
  }

  /** BM25 检索。 */
  search(query, { k = 5, kind = null, maxChars = 6000 } = {}) {
    const q = tokenize(query);
    if (!q.length || !this.docs.length) return [];
    const k1 = 1.2;
    const b = 0.75;
    const N = this.docs.length;
    const scores = new Map();
    const seen = new Set();
    for (const tk of q) {
      if (seen.has(tk)) continue;
      seen.add(tk);
      const posting = this.postings.get(tk);
      if (!posting) continue;
      const df = posting.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [docId, tf] of posting) {
        const len = this.docLen.get(docId) ?? 1;
        const score = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / this.avgLen)));
        scores.set(docId, (scores.get(docId) ?? 0) + score);
      }
    }
    let ranked = [...scores.entries()].sort((a, b2) => b2[1] - a[1]);
    if (kind) ranked = ranked.filter(([i]) => this.docs[i].kind === kind);
    const out = [];
    let total = 0;
    for (const [i, score] of ranked.slice(0, k)) {
      const doc = this.docs[i];
      const text = truncate(doc.text, this.maxChunkChars);
      if (total + text.length > maxChars) break;
      total += text.length;
      out.push({ score: Number(score.toFixed(3)), kind: doc.kind, source: doc.source, startLine: doc.startLine, endLine: doc.endLine, text });
    }
    return out;
  }

  /** 读取技能目录（.synthflow/skills/*.md），支持极简 frontmatter。 */
  skills() {
    const out = [];
    if (!fs.existsSync(this.skillsDir)) return out;
    for (const name of fs.readdirSync(this.skillsDir)) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(this.skillsDir, name);
      let raw = '';
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
      const meta = {};
      let body = raw;
      if (fm) {
        body = raw.slice(fm[0].length);
        for (const line of fm[1].split('\n')) {
          const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
          if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
        }
      }
      out.push({
        name: meta.name || name.replace(/\.md$/, ''),
        description: meta.description || truncate(body.split('\n').find((l) => l.trim()) ?? '', 120),
        triggers: (meta.triggers || meta.when || '').split(/[,，;；]/).map((s) => s.trim()).filter(Boolean),
        body,
        file: name,
      });
    }
    return out;
  }

  /** 按触发词挑选本次用得上的技能。 */
  matchSkills(query) {
    const q = String(query ?? '').toLowerCase();
    return this.skills()
      .map((s) => ({ ...s, hits: s.triggers.filter((t) => q.includes(t.toLowerCase())).length }))
      .filter((s) => s.hits > 0 || s.triggers.length === 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 3);
  }

  stats() {
    return { chunks: this.docs.length, terms: this.postings.size, builtAt: this.builtAt, skills: this.skills().length };
  }
}

function safeStat(rel) {
  try {
    const st = fs.statSync(rel);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return '0';
  }
}
