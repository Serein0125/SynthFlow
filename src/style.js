// 项目风格扫描（想法 4）：读一遍现有代码，提炼出"这个项目是怎么写的"，
// 再把结论作为硬约束注入 system prompt，让模型产出的代码贴齐整体风格。
// 纯正则 + 统计，零依赖，几百毫秒量级，结果缓存在 .synthflow/style.json。
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, sha1, splitLines, writeJsonAtomic } from './util.js';

const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'go', 'rs', 'java', 'kt', 'php', 'rb']);
const STYLE_EXT = new Set(['css', 'scss', 'less']);
const MAX_SCAN_FILES = 160;
const MAX_SCAN_BYTES = 300 * 1024;

/** 判断"最主要的"缩进宽度。 */
function detectIndent(codeLines) {
  const counts = new Map();
  let tabVotes = 0;
  let spaceVotes = 0;
  for (const line of codeLines) {
    const m = line.match(/^([ \t]+)\S/);
    if (!m) continue;
    const w = m[1];
    if (w.includes('\t')) {
      tabVotes += 1;
      continue;
    }
    spaceVotes += 1;
    const n = w.length;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  if (tabVotes > spaceVotes) return 'tab';
  // 找最常见的"最小缩进步长"
  const steps = new Map();
  for (const [n, c] of counts) {
    for (const step of [2, 4, 8]) if (n % step === 0) steps.set(step, (steps.get(step) ?? 0) + c);
  }
  // 用最小的缩进值作为步长候选（2 空格项目不会出现奇数缩进）
  let best = null;
  let bestScore = 0;
  for (const [step, c] of steps) {
    const score = c / step; // 更小的步长在同等票数下更可能是真正的基本单位
    if (score > bestScore) {
      bestScore = score;
      best = step;
    }
  }
  return best ? `${best} 空格` : null;
}

function detectCommentLanguage(code) {
  const comments = [];
  const patterns = [/\/\/[^\n]*/g, /\/\*[\s\S]*?\*\//g, /#[^\n]*/g, /<!--[\s\S]*?-->/g];
  for (const re of patterns) {
    const m = code.match(re);
    if (m) comments.push(...m);
  }
  if (!comments.length) return null;
  const text = comments.join('\n');
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]{2,}/g) ?? []).length;
  if (cjk === 0 && latin === 0) return null;
  if (cjk > 0 && latin > 0) return cjk >= latin ? '以中文注释为主' : '以英文注释为主';
  return cjk > 0 ? '中文注释' : '英文注释';
}

function detectNaming(names) {
  const votes = { camel: 0, pascal: 0, snake: 0, constant: 0 };
  for (const n of names) {
    if (/^[A-Z][A-Z0-9_]*$/.test(n)) votes.constant += 1;
    else if (/^[A-Z][A-Za-z0-9]*$/.test(n)) votes.pascal += 1;
    else if (/^[a-z][A-Za-z0-9]*$/.test(n)) votes.camel += 1;
    else if (/^[a-z][a-z0-9_]*$/.test(n)) votes.snake += 1;
  }
  const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 3) return null;
  return { camel: '小驼峰 camelCase', pascal: '大驼峰 PascalCase', snake: '下划线 snake_case', constant: '常量全大写' }[top[0]];
}

function detectFileNaming(files) {
  const votes = { kebab: 0, pascal: 0, camel: 0, snake: 0 };
  for (const f of files) {
    const base = path.basename(f).replace(/\.[^.]+$/, '');
    if (!/^[A-Za-z][\w-]*$/.test(base)) continue;
    if (base.includes('-')) votes.kebab += 1;
    else if (/^[A-Z]/.test(base)) votes.pascal += 1;
    else if (base.includes('_')) votes.snake += 1;
    else votes.camel += 1;
  }
  const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 2) return null;
  return { kebab: 'kebab-case（短横线）', pascal: 'PascalCase', camel: 'camelCase', snake: 'snake_case' }[top[0]];
}

function detectFramework(pkg) {
  const out = [];
  if (!pkg) return out;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (k) => Object.prototype.hasOwnProperty.call(deps, k);
  if (has('next')) out.push('Next.js');
  else if (has('nuxt')) out.push('Nuxt');
  if (has('react')) out.push('React');
  if (has('vue')) out.push('Vue');
  if (has('svelte')) out.push('Svelte');
  if (has('solid-js')) out.push('Solid');
  if (has('express')) out.push('Express');
  if (has('koa')) out.push('Koa');
  if (has('fastify')) out.push('Fastify');
  if (has('nestjs') || has('@nestjs/core')) out.push('NestJS');
  if (has('tailwindcss')) out.push('Tailwind CSS');
  if (has('element-plus')) out.push('Element Plus');
  if (has('antd')) out.push('Ant Design');
  if (has('vite')) out.push('Vite');
  if (has('typescript')) out.push('TypeScript');
  if (has('vitest') || has('jest')) out.push(deps.vitest ? 'Vitest' : 'Jest');
  return out;
}

/**
 * 扫描工作区（合并视图），返回风格画像 + 可直接注入 prompt 的中文摘要。
 * @param {import('./workspace.js').Workspace} workspace
 */
export function scanStyle(workspace, { force = false, maxFiles = MAX_SCAN_FILES } = {}) {
  const cacheFile = path.join(workspace.storeDir, 'style.json');
  const files = workspace.listFiles().filter((f) => {
    const ext = f.split('.').pop()?.toLowerCase() ?? '';
    return CODE_EXT.has(ext) || STYLE_EXT.has(ext) || f.endsWith('package.json') || ext === 'html' || ext === 'md';
  });
  const listed = files.slice(0, maxFiles);
  const signature = sha1(listed.map((f) => {
    const r = workspace.read(f);
    return `${f}:${r?.bytes ?? 0}:${(r?.content ?? '').length}`;
  }).join('|'));

  const cached = readJsonSafe(cacheFile, null);
  if (!force && cached && cached.signature === signature) return cached.data;

  const langs = {};
  const codeLines = [];
  let quoteSingle = 0;
  let quoteDouble = 0;
  let semiLines = 0;
  let stmtLines = 0;
  let esm = 0;
  let cjs = 0;
  const symbols = [];
  const commentSamples = [];
  let scanned = 0;

  for (const rel of listed) {
    const ext = rel.split('.').pop()?.toLowerCase() ?? 'other';
    langs[ext] = (langs[ext] ?? 0) + 1;
    const f = workspace.read(rel);
    if (!f || f.tooLarge) continue;
    const code = f.content;
    if (code.length > MAX_SCAN_BYTES) continue;
    scanned += 1;
    if (CODE_EXT.has(ext)) {
      const lines = splitLines(code);
      codeLines.push(...lines);
      // 引号（粗略：去掉字符串里的转义，避免把英文撇号算进去）
      quoteSingle += (code.match(/'/g) ?? []).length;
      quoteDouble += (code.match(/"/g) ?? []).length;
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')) continue;
        if (/[;{}(),]$/.test(t) || /^(const|let|var|return|import|export|function|if|for|while)\b/.test(t)) {
          stmtLines += 1;
          if (t.endsWith(';')) semiLines += 1;
        }
      }
      esm += (code.match(/^\s*(import|export)\s/gm) ?? []).length;
      cjs += (code.match(/require\(|module\.exports/g) ?? []).length;
      const re = /(?:export\s+)?(?:async\s+)?(?:function|class|const|let|interface|type)\s+([A-Za-z_$][\w$]*)/g;
      let m;
      while ((m = re.exec(code)) && symbols.length < 400) symbols.push(m[1]);
      commentSamples.push(code.slice(0, 4000));
    } else if (ext === 'md' || ext === 'html' || STYLE_EXT.has(ext)) {
      commentSamples.push(code.slice(0, 2000));
    }
  }

  let pkg = null;
  try {
    const p = workspace.read('package.json');
    if (p) pkg = JSON.parse(p.content.replace(/^\uFEFF/, ''));
  } catch { /* 忽略坏 package.json */ }

  const indent = detectIndent(codeLines);
  const quotes = quoteSingle === 0 && quoteDouble === 0 ? null : quoteDouble >= quoteSingle ? '双引号' : '单引号';
  const semicolons = stmtLines < 20 ? null : semiLines / stmtLines >= 0.5;
  const commentLang = detectCommentLanguage(commentSamples.join('\n'));
  const symbolNaming = detectNaming(symbols);
  const fileNaming = detectFileNaming(listed);
  const moduleStyle = esm === 0 && cjs === 0 ? null : esm >= cjs ? 'ES Module（import/export）' : 'CommonJS（require）';
  const frameworks = detectFramework(pkg);
  const hasTests = listed.some((f) => /(^|\/)(__tests__|tests?|spec)\//.test(f) || /\.(test|spec)\./.test(f));

  const data = {
    scanned,
    totalFiles: files.length,
    langs: Object.fromEntries(Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 8)),
    indent,
    quotes,
    semicolons,
    commentLang,
    symbolNaming,
    fileNaming,
    moduleStyle,
    frameworks,
    hasTests,
    packageName: pkg?.name ?? null,
    scannedAt: new Date().toISOString(),
  };
  data.summary = buildSummary(data);
  writeJsonAtomic(cacheFile, { signature, data });
  return data;
}

function buildSummary(d) {
  const rules = [];
  if (d.indent) rules.push(`缩进使用 ${d.indent}`);
  if (d.quotes) rules.push(`字符串使用${d.quotes}`);
  if (d.semicolons === true) rules.push('语句结尾写分号');
  if (d.semicolons === false) rules.push('语句结尾不写分号');
  if (d.moduleStyle) rules.push(`模块使用 ${d.moduleStyle}`);
  if (d.symbolNaming) rules.push(`函数/变量命名用 ${d.symbolNaming}`);
  if (d.fileNaming) rules.push(`文件名用 ${d.fileNaming}`);
  if (d.commentLang) rules.push(`${d.commentLang}`);
  if (d.frameworks.length) rules.push(`技术栈涉及 ${d.frameworks.join(' / ')}`);
  if (!rules.length) return null;
  return (
    `【项目现有风格（扫描了 ${d.scanned} 个文件，必须严格沿用，不要引入新风格）】\n` +
    rules.map((r) => `- ${r}`).join('\n') +
    `\n新写的代码必须与现有文件在缩进、引号、命名、模块写法上完全一致；不要顺手改成你偏好的风格。`
  );
}

export function styleStats(workspace) {
  const cacheFile = path.join(workspace.storeDir, 'style.json');
  const cached = readJsonSafe(cacheFile, null);
  return cached?.data ?? null;
}
