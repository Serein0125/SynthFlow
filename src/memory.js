// SynthFlow 记忆与习惯学习（想法 13）
// 所有数据都落在 <项目>/.synthflow/memory/ 下，纯本地 JSON，随时可删。
import fs from 'node:fs';
import path from 'node:path';
import { codeStyleSignals, ensureDir, nowIso, readJsonSafe, writeJsonAtomic } from './util.js';

const MAX_PHRASES = 400;

export class Memory {
  constructor(storeDir) {
    this.dir = path.join(storeDir, 'memory');
    ensureDir(this.dir);
    this.file = path.join(this.dir, 'profile.json');
    this.profile = readJsonSafe(this.file, null) ?? {
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      prompts: 0,
      totalPromptChars: 0,
      languages: {},
      adopted: {},
      dismissed: {},
      style: { indent: null, quotes: null, semicolons: null, samples: 0 },
      phrases: {},
      topSubjects: {},
      runs: [],
      rollbacks: 0,
    };
    this.sessionFile = path.join(this.dir, 'prompts.jsonl');
  }

  /** 记录一次用户输入的完整 prompt。 */
  observePrompt(text) {
    const t = String(text ?? '').trim();
    if (!t) return;
    this.profile.prompts += 1;
    this.profile.totalPromptChars += t.length;
    for (const ph of extractPhrases(t)) this.profile.phrases[ph] = (this.profile.phrases[ph] ?? 0) + 1;
    for (const sub of extractSubjects(t)) this.profile.topSubjects[sub] = (this.profile.topSubjects[sub] ?? 0) + 1;
    this.trimMap(this.profile.phrases, MAX_PHRASES);
    this.trimMap(this.profile.topSubjects, 80);
    this.log({ type: 'prompt', text: t });
    this.save();
  }

  /** 记录一次生成运行的结果。 */
  observeRun({ prompt, files = [], contents = [], adopted = [], dismissed = [], mode = '', ms = 0, tokens = 0 }) {
    for (const f of files) {
      const ext = String(f).split('.').pop()?.toLowerCase() ?? '';
      this.profile.languages[ext || 'other'] = (this.profile.languages[ext || 'other'] ?? 0) + 1;
    }
    for (const a of adopted) {
      const k = a.kind ?? 'other';
      this.profile.adopted[k] = (this.profile.adopted[k] ?? 0) + 1;
    }
    for (const d of dismissed) {
      const k = d.kind ?? 'other';
      this.profile.dismissed[k] = (this.profile.dismissed[k] ?? 0) + 1;
    }
    if (contents.length) {
      const st = blendStyle(this.profile.style, contents);
      this.profile.style = st;
    }
    this.profile.runs.unshift({ at: nowIso(), mode, files: files.length, ms, tokens, promptChars: String(prompt ?? '').length });
    this.profile.runs = this.profile.runs.slice(0, 100);
    this.log({ type: 'run', mode, files, adopted: adopted.map((a) => a.kind), ms, tokens });
    this.save();
  }

  observeRollback() {
    this.profile.rollbacks += 1;
    this.log({ type: 'rollback' });
    this.save();
  }

  log(entry) {
    try {
      fs.appendFileSync(this.sessionFile, `${JSON.stringify({ at: nowIso(), ...entry })}\n`, 'utf8');
    } catch { /* ignore */ }
  }

  trimMap(map, max) {
    const entries = Object.entries(map);
    if (entries.length <= max) return;
    entries.sort((a, b) => b[1] - a[1]);
    for (const [k] of entries.slice(max)) delete map[k];
  }

  save() {
    this.profile.updatedAt = nowIso();
    writeJsonAtomic(this.file, this.profile);
  }

  /** 给 UI 的"快捷片段"：用户经常使用的说法。 */
  chips(limit = 8) {
    return Object.entries(this.profile.phrases)
      .filter(([p, n]) => n >= 2 && p.length >= 2 && p.length <= 12)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([text, count]) => ({ text, count }));
  }

  /** 给模型的"用户画像"注入块。 */
  briefing() {
    const p = this.profile;
    const parts = [];
    if (p.style?.indent) parts.push(`缩进偏好：${p.style.indent === 'tab' ? 'Tab' : `${p.style.indent} 空格`}`);
    if (p.style?.quotes) parts.push(`引号偏好：${p.style.quotes === 'single' ? '单引号' : '双引号'}`);
    if (typeof p.style?.semicolons === 'boolean') parts.push(`语句结尾分号：${p.style.semicolons ? '保留' : '省略'}`);
    const langs = Object.entries(p.languages).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}(${v})`);
    if (langs.length) parts.push(`常用类型：${langs.join(' ')}`);
    const adopted = Object.entries(p.adopted).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const dismissed = Object.entries(p.dismissed).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (adopted.length) parts.push(`他容易采纳的建议类型：${adopted.map(([k, v]) => `${k}×${v}`).join(' ')}`);
    if (dismissed.length) parts.push(`他常忽略的建议类型（少提）：${dismissed.map(([k, v]) => `${k}×${v}`).join(' ')}`);
    if (p.prompts) parts.push(`累计 ${p.prompts} 次输入，平均 ${Math.round(p.totalPromptChars / Math.max(1, p.prompts))} 字`);
    const subjects = Object.entries(p.topSubjects).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
    if (subjects.length) parts.push(`常做的方向：${subjects.join('、')}`);
    return parts.length ? parts.join('\n') : '（暂无历史画像，本次开始积累）';
  }

  summary() {
    const p = this.profile;
    return {
      prompts: p.prompts,
      adopted: p.adopted,
      dismissed: p.dismissed,
      style: p.style,
      languages: p.languages,
      rollbacks: p.rollbacks,
      runs: p.runs.slice(0, 10),
      chips: this.chips(10),
      briefing: this.briefing(),
    };
  }
}

const STOP = new Set(['帮我', '给我', '一个', '一些', '这个', '那个', '然后', '可以', '需要', '想要', '实现', '支持']);

function extractPhrases(text) {
  const out = [];
  const t = text.replace(/\s+/g, ' ');
  const cjk = t.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  for (const c of cjk) {
    if (c.length < 2 || STOP.has(c)) continue;
    out.push(c);
  }
  const latin = t.match(/[A-Za-z][A-Za-z0-9-]{3,14}/g) ?? [];
  for (const l of latin) out.push(l.toLowerCase());
  return out.slice(0, 40);
}

function extractSubjects(text) {
  const dict = [
    ['后台管理', /后台|管理后台|admin|dashboard/i],
    ['登录注册', /登录|注册|鉴权|auth|login/i],
    ['表格列表', /表格|列表|table|list|分页/i],
    ['表单', /表单|form|填报/i],
    ['图表', /图表|可视化|chart|echarts/i],
    ['落地页', /落地页|官网|landing|首页/i],
    ['组件库', /组件库|components?/i],
    ['接口请求', /接口|api|请求|fetch|axios/i],
    ['样式美化', /样式|美化|css|tailwind|主题/i],
    ['重构优化', /重构|优化|性能|refactor/i],
    ['修 bug', /bug|报错|修复|fix/i],
    ['测试', /测试|test|单测/i],
    ['文档', /文档|readme|注释/i],
  ];
  return dict.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function blendStyle(prev, contents) {
  const next = { ...(prev ?? { indent: null, quotes: null, semicolons: null, samples: 0 }) };
  const sigs = contents.map(codeStyleSignals).filter(Boolean);
  if (!sigs.length) return next;
  const indentVotes = sigs.map((s) => s.indent).filter((v) => v !== null && v !== undefined);
  const quoteVotes = sigs.map((s) => s.quotes).filter(Boolean);
  const semiVotes = sigs.map((s) => s.semicolons);
  next.indent = mode(indentVotes) ?? next.indent;
  next.quotes = mode(quoteVotes) ?? next.quotes;
  if (semiVotes.length) next.semicolons = semiVotes.filter(Boolean).length * 2 >= semiVotes.length;
  next.samples = (next.samples ?? 0) + sigs.length;
  return next;
}

function mode(arr) {
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) { n = v; best = k; }
  return best;
}
