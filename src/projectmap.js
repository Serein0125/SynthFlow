// 项目定位索引（想法 4）：做"优化已有项目"时，先快速定位到要改的页面 / 组件文件。
//
// 做法：解析路由配置 + 组件声明，建一张「页面/路由 → 文件」「组件名 → 文件」的索引，
// 连同路径关键词一起注入提示词。相比纯 BM25 内容检索，它能直接回答
// "用户说的那个页面/组件在哪个文件里"，避免模型去猜、去全量重写。
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, tokenize, truncate, writeJsonAtomic } from './util.js';

const MAX_FILES = 400;
const MAX_ENTRIES = 80;

const ROUTER_HINTS = /(^|\/)(router|routes)(\/|\.|$)|router\/index\.|routes\.(js|ts)$/i;
const COMPONENT_EXT = new Set(['vue', 'jsx', 'tsx', 'svelte']);
const SKIP_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'eot', 'pdf', 'zip', 'jar', 'class', 'lock', 'map']);

/** 各类语言的顶层声明（含 Java 的 class/interface/record）。 */
const SYMBOL_RE = /(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|async\s+)*(?:class|interface|enum|record|function|def|struct|impl|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g;

/** Java / Spring 的接口映射，用来当作"页面/入口"。 */
const JAVA_ROUTE_RE = /@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;

/** 从路由文件里抽出 path → component 的映射（兼容 vue-router 与 react-router 两种写法）。 */
export function parseRoutes(code, baseDir = '') {
  const out = [];
  const imports = {};
  // import Xxx from './views/Xxx.vue'  /  import('./views/Xxx.vue')
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g)) {
    imports[m[1]] = m[2];
  }
  for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports[`__lazy_${m[1]}`] = m[1];
  }
  // { path: '/users', component: UserList }  或  component: () => import('./views/UserList.vue')
  const blockRe = /path\s*:\s*['"`]([^'"`]+)['"`]([\s\S]{0,220}?)(?=\bpath\s*:|$)/g;
  for (const m of code.matchAll(blockRe)) {
    const route = m[1];
    const chunk = m[2];
    let file = null;
    let name = null;
    const comp = chunk.match(/component\s*:\s*([A-Za-z_$][\w$]*)/);
    if (comp && imports[comp[1]]) {
      file = imports[comp[1]];
      name = comp[1];
    }
    const lazy = chunk.match(/import\(\s*['"]([^'"]+)['"]\s*\)/);
    if (!file && lazy) {
      file = lazy[1];
      name = path.basename(lazy[1]).replace(/\.[^.]+$/, '');
    }
    const named = chunk.match(/name\s*:\s*['"`]([^'"`]+)['"`]/);
    if (named) name = named[1];
    if (route && file) out.push({ route, file: normalizeRel(file, baseDir), name });
  }
  // react-router:  <Route path="/x" element={<X />} />
  for (const m of code.matchAll(/<Route[^>]*path=["']([^"']+)["'][^>]*?(?:element|component)=\{?<?([A-Za-z_$][\w$]*)/g)) {
    const file = imports[m[2]];
    if (file) out.push({ route: m[1], file: normalizeRel(file, baseDir), name: m[2] });
  }
  return out;
}

function normalizeRel(spec, baseDir) {
  if (!spec) return '';
  if (spec.startsWith('@/') || spec.startsWith('~/')) return spec.slice(2);
  if (spec.startsWith('.')) return path.posix.normalize(path.posix.join(baseDir, spec));
  return spec.replace(/^\.\//, '');
}

/** 从 SFC / 组件文件里抽出组件名。 */
export function componentNameOf(rel, code) {
  const base = path.basename(rel).replace(/\.[^.]+$/, '');
  const m =
    code.match(/defineOptions\s*\(\s*\{\s*name\s*:\s*['"`]([^'"`]+)['"`]/) ||
    code.match(/name\s*:\s*['"`]([A-Za-z_$][\w$]*)['"`]/) ||
    code.match(/(?:export\s+default\s+|export\s+function\s+|function\s+)([A-Z][\w$]*)/);
  return m?.[1] ?? base;
}

/** 页面文件（views/pages 目录下的组件）优先当作"页面"。 */
const isPageLike = (rel) => /(^|\/)(views?|pages?)\//i.test(rel) || /Page\.(vue|jsx|tsx|js|ts)$/.test(rel);

export function buildProjectMap(workspace, { force = false } = {}) {
  const cacheFile = path.join(workspace.storeDir, 'projectmap.json');
  const files = workspace.listFiles().filter((f) => {
    const ext = f.split('.').pop()?.toLowerCase() ?? '';
    return !SKIP_EXT.has(ext);
  }).slice(0, MAX_FILES);

  const signature = files.map((f) => `${f}:${workspace.read(f)?.bytes ?? 0}`).join('|');
  const cached = readJsonSafe(cacheFile, null);
  if (!force && cached && cached.signature === signature) return cached.data;

  const pages = [];
  const components = [];
  const entries = [];

  for (const rel of files) {
    const f = workspace.read(rel);
    if (!f || f.tooLarge) continue;
    const ext = rel.split('.').pop()?.toLowerCase() ?? '';
    const code = f.content;

    // 1) 前端路由文件：解析 path → component
    if (ROUTER_HINTS.test(rel)) {
      for (const r of parseRoutes(code, path.posix.dirname(rel))) {
        if (r.file) pages.push({ ...r, from: rel });
      }
    }

    // 2) 抽顶层声明符号（不挑语言）
    const symbols = [];
    SYMBOL_RE.lastIndex = 0;
    let m;
    while ((m = SYMBOL_RE.exec(code)) && symbols.length < 8) symbols.push(m[1]);
    const base = path.basename(rel).replace(/\.[^.]+$/, '');

    // 3) Java / Spring：把 @RequestMapping 当成入口
    let route = null;
    JAVA_ROUTE_RE.lastIndex = 0;
    const jm = JAVA_ROUTE_RE.exec(code);
    if (jm) route = jm[2];
    if (route) {
      pages.push({ route, file: rel, name: symbols[0] ?? base, from: 'annotation' });
    } else if (/\.java$/.test(rel) && /Controller$/.test(base)) {
      pages.push({ route: null, file: rel, name: base, from: 'controller' });
    } else if (COMPONENT_EXT.has(ext) || /^[A-Z]/.test(base)) {
      const name = componentNameOf(rel, code);
      if (isPageLike(rel)) pages.push({ route: null, file: rel, name, from: 'path' });
      else components.push({ name, file: rel, page: false });
    }

    entries.push({ name: base, file: rel, symbols, kind: 'file' });
  }

  // 去重
  const pageFiles = new Map();
  for (const p of pages) if (p.file && !pageFiles.has(p.file)) pageFiles.set(p.file, p);
  const compFiles = new Map();
  for (const c of components) if (!compFiles.has(c.file)) compFiles.set(c.file, c);

  const data = {
    pages: [...pageFiles.values()].slice(0, MAX_ENTRIES),
    components: [...compFiles.values()].slice(0, MAX_ENTRIES),
    files: entries,
    scanned: files.length,
    builtAt: new Date().toISOString(),
  };
  writeJsonAtomic(cacheFile, { signature, data });
  return data;
}

/**
 * 中文需求 ↔ 英文代码标识符的对照表。
 * 用户会说"改简历列表页"，而代码里写的是 resume / ResumeView —— 不做这层映射就定位不到。
 * 只覆盖最常见的开发词，宁可少而准。
 */
const SYNONYMS = {
  简历: ['resume', 'cv'], 用户: ['user', 'account', 'member'], 账号: ['account', 'user'],
  登录: ['login', 'signin', 'auth'], 注册: ['register', 'signup'], 权限: ['permission', 'role', 'auth'],
  角色: ['role'], 列表: ['list', 'table'], 表格: ['table', 'grid'], 详情: ['detail', 'info'],
  首页: ['home', 'index'], 设置: ['setting', 'config', 'option'], 配置: ['config', 'setting'],
  订单: ['order'], 商品: ['product', 'goods', 'item'], 搜索: ['search', 'query', 'filter'],
  上传: ['upload'], 下载: ['download'], 导出: ['export'], 导入: ['import'],
  消息: ['message', 'notice', 'notification'], 通知: ['notice', 'notification'],
  图表: ['chart', 'graph', 'dashboard'], 表单: ['form'], 文章: ['article', 'post', 'blog'],
  评论: ['comment'], 分类: ['category', 'type'], 标签: ['tag', 'label'], 数据: ['data'],
  接口: ['api', 'controller', 'service'], 组件: ['component'], 页面: ['view', 'page'],
  样式: ['style', 'css', 'theme'], 路由: ['router', 'route'], 状态: ['store', 'state', 'redux'],
  请求: ['request', 'api', 'fetch', 'axios'], 图片: ['image', 'img', 'photo'], 文件: ['file'],
  日志: ['log'], 测试: ['test', 'spec'], 前端: ['frontend', 'client', 'web'], 后端: ['backend', 'server'],
  数据库: ['db', 'database', 'mapper', 'repository', 'dao'], 模型: ['model', 'entity'],
  首页路由: ['home', 'index'], 个人: ['profile', 'personal'], 信息: ['info', 'profile'],
  技能: ['skill'], 经历: ['experience'], 项目: ['project'], 教育: ['education'], 联系: ['contact'],
  头像: ['avatar'], 主题: ['theme'], 布局: ['layout'], 导航: ['nav', 'menu', 'header'],
  按钮: ['button', 'btn'], 弹窗: ['modal', 'dialog', 'popup'], 分页: ['pagination', 'page'],
  验证: ['validate', 'verify', 'check'], 错误: ['error', 'exception'], 缓存: ['cache'],
  富文本: ['editor', 'richtext'], 地图: ['map'], 支付: ['pay', 'payment'],
};

/** 把中文 token 展开成对应的英文标识符，跟原 token 一起参与匹配。 */
function expandTokens(tokens) {
  const out = new Set(tokens);
  for (const t of tokens) {
    const tk = t.toLowerCase();
    if (SYNONYMS[tk]) for (const s of SYNONYMS[tk]) out.add(s);
    // 单字/双字中文在整句里也要能被识别（例："简历列表" → 简历 + 列表）
    for (const key of Object.keys(SYNONYMS)) {
      if (t.includes(key)) for (const s of SYNONYMS[key]) out.add(s);
    }
  }
  return [...out];
}

/** 从一句需求里定位最可能要改的文件（跨语言：路径 / 文件名 / 类名 / 符号 / 路由）。 */
export function locate(projectMap, query, { k = 6 } = {}) {
  const tokens = expandTokens([...new Set(tokenize(query))].filter((t) => t.length > 1 || /[\u4e00-\u9fff]/.test(t)));
  if (!tokens.length) return [];
  const scored = [];
  const add = (kind, entry, extra = '') => {
    const name = (entry.name ?? '').toLowerCase();
    const file = String(entry.file ?? '').toLowerCase();
    const route = String(entry.route ?? '').toLowerCase();
    const syms = (entry.symbols ?? []).join(' ').toLowerCase();
    let score = 0;
    for (const t of tokens) {
      const tk = t.toLowerCase();
      let hit = 0;
      if (name.includes(tk)) hit += 4;
      if (file.includes(tk)) hit += 3;
      if (route.includes(tk)) hit += 3;
      if (syms.includes(tk)) hit += 2;
      if (extra.toLowerCase().includes(tk)) hit += 1;
      if (hit === 0) continue;
      score += hit * (tk.length >= 3 ? 1.5 : 1);
      if (name === tk) score += 5;
    }
    if (score > 0) scored.push({ kind, score: Number(score.toFixed(1)), route: entry.route ?? null, name: entry.name, file: entry.file, symbols: (entry.symbols ?? []).slice(0, 4) });
  };

  for (const p of projectMap.pages ?? []) add('page', p);
  for (const c of projectMap.components ?? []) add('component', c);
  for (const f of projectMap.files ?? []) {
    if ((projectMap.pages ?? []).some((p) => p.file === f.file)) continue;
    add('file', f);
  }

  // 同一文件只留最高分
  const best = new Map();
  for (const s of scored.sort((a, b) => b.score - a.score)) {
    if (!best.has(s.file)) best.set(s.file, s);
  }
  return [...best.values()].slice(0, k);
}

/** 生成给模型看的定位索引（有上限，避免塞爆上下文）。 */
export function locatorBrief(workspace, projectMap) {
  const pages = projectMap.pages ?? [];
  const comps = projectMap.components ?? [];
  const files = (projectMap.files ?? []).filter((f) => (f.symbols ?? []).length);
  if (!pages.length && !comps.length && !files.length) return null;
  const lines = [];
  if (pages.length) {
    lines.push('页面 / 接口入口：');
    for (const p of pages.slice(0, 40)) {
      lines.push(`- ${p.route ? `${p.route} → ` : ''}${p.name ?? ''} \`${p.file}\``);
    }
  }
  if (comps.length) {
    lines.push('可复用组件：');
    for (const c of comps.slice(0, 30)) lines.push(`- ${c.name} \`${c.file}\``);
  }
  if (pages.length + comps.length < 25 && files.length) {
    lines.push('其它关键文件（含主要声明）：');
    for (const f of files.slice(0, 30)) lines.push(`- \`${f.file}\` — ${f.symbols.slice(0, 4).join(', ')}`);
  }
  return (
    `【项目定位索引（用户提到页面/组件/类时，先在这里找对应文件，不要凭猜、不要新建同名文件）】\n` +
    lines.join('\n') +
    `\n修改已有功能时：**只改定位到的文件**，用 search/replace 补丁；不要重建已有文件，也不要顺手重构无关代码。`
  );
}

export function mapStats(workspace) {
  const cacheFile = path.join(workspace.storeDir, 'projectmap.json');
  const cached = readJsonSafe(cacheFile, null);
  if (!cached?.data) return null;
  return { pages: cached.data.pages?.length ?? 0, components: cached.data.components?.length ?? 0, scanned: cached.data.scanned ?? 0, builtAt: cached.data.builtAt };
}
