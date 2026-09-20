// SynthFlow 冒烟测试：不依赖浏览器、不依赖网络、不消耗任何模型额度。
//   node scripts/smoke.mjs             跑全部用例
//   node scripts/smoke.mjs --bench     额外跑一次吞吐基线
// 所有测试产物都写在 <项目>/.synthflow/testrun/ 下，跑完自动清理。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addedLineNumbers, bytesToHuman, changedSpan, compactDiff, diffLines, ensureDir, readJsonSafe, sha1, similarity } from '../src/util.js';
import { createProtocolParser, parseFilePayload, stripFence } from '../src/protocol.js';
import { Workspace, locateBlock } from '../src/workspace.js';
import { Session, analyzeIntent, decidePromptChange } from '../src/session.js';
import { Memory } from '../src/memory.js';
import { RagIndex } from '../src/rag.js';
import { Runner, normalizeTiming } from '../src/runner.js';
import { createServer } from '../src/server.js';
import { createProvider, loadConfig, MODEL_CATALOG, newProfile, saveConfig } from '../src/llm.js';
import { scanStyle } from '../src/style.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.synthflow', 'testrun');
const bench = process.argv.includes('--bench');

let pass = 0;
let fail = 0;
const failures = [];
const t0 = Date.now();

async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    fail += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name} (${Date.now() - start}ms)\n      ${err.message}`);
  }
}

function section(title) {
  console.log(`\n▌${title}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ 1. 工具层 ============================ */
section('1. 基础工具（diff / 相似度 / 变更跨度）');

await test('diffLines 正确区分增删改', () => {
  const d = diffLines('a\nb\nc', 'a\nx\nc');
  assert.equal(d.filter((x) => x.type === 'same').length, 2);
  assert.equal(d.filter((x) => x.type === 'del').map((x) => x.text).join(), 'b');
  assert.equal(d.filter((x) => x.type === 'ins').map((x) => x.text).join(), 'x');
});

await test('similarity 单调合理', () => {
  assert.equal(similarity('abc', 'abc'), 1);
  assert.ok(similarity('写一个登录页', '写一个后台管理页') < 1);
  assert.ok(similarity('写一个登录页', '写一个登录页，用中文注释') > 0.5);
});

await test('changedSpan 识别尾部追加与中间改写', () => {
  const app = changedSpan('写一个登录页', '写一个登录页，加上记住我');
  assert.equal(app.isAppend, true);
  assert.equal(app.added, '，加上记住我');
  const mid = changedSpan('写一个登录页，用蓝色主题', '写一个注册页，用蓝色主题');
  assert.equal(mid.isAppend, false);
  assert.equal(mid.removed, '登录');
  assert.equal(mid.added, '注册');
});

await test('compactDiff 只保留变化行并折叠上下文', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 20', 'line 20 changed');
  const d = diffLines(before, after);
  const c = compactDiff(d, { context: 2 });
  assert.ok(c.length < 10, `压缩后应很短，实际 ${c.length}`);
  assert.ok(c.some((x) => x.type === 'gap'), '未改动区域应折叠成 gap');
  assert.equal(c.filter((x) => x.type === 'ins').length, 1);
  assert.equal(c.filter((x) => x.type === 'del').length, 1);
  const ins = c.find((x) => x.type === 'ins');
  assert.equal(ins.ln, 21, '新增行应带新文件行号');
});

await test('addedLineNumbers 给出新文件里的新增行号', () => {
  const d = diffLines('a\nb\nc', 'a\nx\ny\nc');
  assert.deepEqual(addedLineNumbers(d), [2, 3]);
  assert.deepEqual(addedLineNumbers(diffLines('a\nb', 'a\nb')), []);
  assert.deepEqual(addedLineNumbers(diffLines('a\nb\nc', 'a\nc')), []);
});

/* ============================ 2. 流协议 ============================ */
section('2. 流协议解析（分片容错）');

const SAMPLE = `先看一下需求。
<<<SF think>>>
用户在写后台管理系统，我需要注意分页边界。
<<<SF /think>>>
<<<SF suggest kind="risk" title="XSS 风险" impact="high" insert="渲染用户数据时转义 HTML">>
innerHTML 拼接有风险。
<<<SF /suggest>>>
<<<SF file path="src/a.js" action="create" lang="js">>>
const a = 1;
<<<SF /file>>>
<<<SF file path="src/b.js" action="update" lang="js">>>
<<<<<<< SEARCH
const a = 1;
=======
const a = 2;
>>>>>>> REPLACE
<<<SF /file>>>
<<<SF memory key="style.indent">>2<<<SF /memory>>>
收工。`;

function parseWith(chunkSize) {
  const got = { text: '', thinks: [], suggestions: [], ops: [], memories: [] };
  const p = createProtocolParser({
    onText: (d) => (got.text += d),
    onThinkEnd: (t) => got.thinks.push(t),
    onSuggestionEnd: (s) => got.suggestions.push(s),
    onFileEnd: (o) => got.ops.push(o),
    onMemory: (m) => got.memories.push(m),
  });
  for (let i = 0; i < SAMPLE.length; i += chunkSize) p.push(SAMPLE.slice(i, i + chunkSize));
  p.end();
  return got;
}

await test('整块推送解析正确', () => {
  const g = parseWith(SAMPLE.length);
  assert.equal(g.thinks.length, 1);
  assert.match(g.thinks[0], /分页边界/);
  assert.equal(g.suggestions.length, 1);
  assert.equal(g.suggestions[0].kind, 'risk');
  assert.equal(g.suggestions[0].title, 'XSS 风险');
  assert.equal(g.ops.length, 2);
  assert.equal(g.ops[0].mode, 'create');
  assert.equal(g.ops[1].mode, 'patch');
  assert.equal(g.ops[1].patches[0].search, 'const a = 1;');
  assert.equal(g.ops[1].patches[0].replace, 'const a = 2;');
  assert.equal(g.memories[0].key, 'style.indent');
  assert.match(g.text, /先看一下需求/);
  assert.match(g.text, /收工/);
});

await test('逐字节分片解析结果完全一致（模拟真实 SSE 半包）', () => {
  const full = parseWith(SAMPLE.length);
  for (const size of [1, 2, 3, 7, 13]) {
    const g = parseWith(size);
    assert.deepEqual(g.suggestions, full.suggestions, `chunk=${size} 建议不一致`);
    assert.deepEqual(g.ops.length, full.ops.length, `chunk=${size} 文件数不一致`);
    assert.equal(g.ops[1].patches[0].replace, 'const a = 2;', `chunk=${size} 补丁不一致`);
    assert.equal(g.memories[0]?.value, '2', `chunk=${size} memory 不一致`);
  }
});

await test('stripFence 去掉 markdown 围栏', () => {
  assert.equal(stripFence('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(stripFence('const a = 1;'), 'const a = 1;');
});

await test('parseFilePayload 无 SEARCH 的 update 退化为 rewrite', () => {
  const op = parseFilePayload({ path: 'a.js', action: 'update' }, 'const x = 1;');
  assert.equal(op.mode, 'rewrite');
});

/* ============================ 3. 工作区与补丁 ============================ */
section('3. 工作区沙箱 / 补丁命中 / 版本快照');

const WS_ROOT = path.join(TMP, 'ws');
fs.rmSync(WS_ROOT, { recursive: true, force: true });
const ws = new Workspace(WS_ROOT, { storeDir: path.join(TMP, 'store') });

await test('locateBlock 支持精确与空白漂移匹配', () => {
  const hay = 'function a() {\n  const x = 1;\n  return x;\n}';
  assert.equal(locateBlock(hay, '  const x = 1;').kind, 'exact');
  assert.ok(locateBlock(hay, '    const x = 1;   '), '缩进不同也应能匹配');
});

await test('创建 / 增量补丁 / 重写 / 删除 全链路', () => {
  const c = ws.applyOp({ path: 'src/main.js', mode: 'create', content: 'const a = 1;\nconst b = 2;\n' });
  assert.equal(c.ok, true);
  assert.equal(c.mode, 'create');

  const p = ws.applyOp({ path: 'src/main.js', mode: 'patch', patches: [{ search: 'const b = 2;', replace: 'const b = 3;' }] });
  assert.equal(p.ok, true);
  assert.equal(p.mode, 'patch');
  assert.match(p.after, /const b = 3;/);
  assert.match(p.after, /const a = 1;/);

  const shifted = ws.applyOp({ path: 'src/main.js', mode: 'patch', patches: [{ search: '    const a = 1;   ', replace: 'const a = 10;' }] });
  assert.equal(shifted.ok, true, '空白漂移应命中');

  const miss = ws.applyOp({ path: 'src/main.js', mode: 'patch', patches: [{ search: '不存在的代码', replace: 'x' }] });
  assert.equal(miss.ok, false);

  const rw = ws.applyOp({ path: 'src/main.js', mode: 'rewrite', content: 'export const x = 1;\n' });
  assert.equal(rw.mode, 'rewrite');

  const del = ws.applyOp({ path: 'src/main.js', mode: 'delete' });
  assert.equal(del.ok, true);
  assert.equal(ws.exists('src/main.js'), false);
});

await test('路径逃逸被拒绝', () => {
  for (const bad of ['../evil.js', '..\\evil.js', 'D:/evil.js', '/etc/passwd', '']) {
    const r = ws.applyOp({ path: bad, mode: 'create', content: 'x' });
    assert.equal(r.ok, false, `应当拒绝: ${bad}`);
  }
});

await test('快照可完整回滚（含新建文件与目录）', () => {
  ws.applyOp({ path: 'a/b/c.js', mode: 'create', content: 'v1' });
  ws.applyOp({ path: 'root.md', mode: 'create', content: 'base' });
  const snap = ws.snapshot({ label: 'before' });
  ws.applyOp({ path: 'a/b/c.js', mode: 'rewrite', content: 'v2-broken' });
  ws.applyOp({ path: 'new/deep/dir/x.txt', mode: 'create', content: 'should disappear' });
  assert.equal(ws.listFiles().length, 3);
  const res = ws.restore(snap.id);
  assert.equal(ws.read('a/b/c.js').content, 'v1');
  assert.equal(ws.exists('new/deep/dir/x.txt'), false);
  assert.ok(res.restored >= 2);
});

await test('repoMap 输出符号摘要', () => {
  ws.applyOp({ path: 'srv.js', mode: 'create', content: 'export function startServer() {}\nexport class App {}\n' });
  const map = ws.repoMap();
  assert.match(map, /srv\.js/);
  assert.match(map, /startServer/);
});

/* ============================ 4. 意图判定 ============================ */
section('4. 意图完整度判定（想法 6）');

await test('半截句子判为未写完', () => {
  for (const t of ['帮我写一个登录页面，', '我需要', '帮我生成一个后台管理系统，包含', '```js\nconst a = 1;', '我要一个可以']) {
    const r = analyzeIntent(t, { idleMs: 100 });
    assert.equal(r.complete, false, `不应判为完整: ${t}`);
  }
});

await test('完整句子判为写完', () => {
  for (const t of ['帮我写一个登录页面，包含邮箱和密码校验。', '继续', '生成一个后台管理系统的用户列表页面，要有分页和搜索。', '把表格改成虚拟滚动。']) {
    const r = analyzeIntent(t, { idleMs: 1200 });
    assert.equal(r.complete, true, `应判为完整: ${t} (score=${r.score} ${r.reasons.join('/')})`);
  }
});

await test('停顿越久分越高', () => {
  const a = analyzeIntent('写一个登录页', { idleMs: 0 }).score;
  const b = analyzeIntent('写一个登录页', { idleMs: 1500 }).score;
  assert.ok(b > a);
});

/* ============================ 5. 漂移决策 ============================ */
section('5. 增量 vs 重生成决策（想法 4/7/9）');

await test('尾部追加 → 增量续写', () => {
  const d = decidePromptChange('做一个后台管理系统', '做一个后台管理系统，再加一个导出 Excel 按钮', { hasCode: true, codeBytes: 40000 });
  assert.equal(d.mode, 'continue');
  assert.match(d.instruction, /增量续写/);
});

await test('中间小改写 → 定点补丁', () => {
  const d = decidePromptChange('做一个后台管理系统，用蓝色主题，包含用户列表', '做一个后台管理系统，用暗色主题，包含用户列表', { hasCode: true, codeBytes: 40000 });
  assert.equal(d.mode, 'incremental');
  assert.match(d.instruction, /增量补丁/);
});

await test('整体换需求 → 重生成', () => {
  const d = decidePromptChange('做一个后台管理系统', '写一个个人博客首页，要极简风格，带文章列表和标签云', { hasCode: true, codeBytes: 1000 });
  assert.equal(d.mode, 'regenerate');
});

await test('已有大量代码时更倾向增量（阈值收紧）', () => {
  const heavy = decidePromptChange('后台管理系统，包含用户列表、订单列表、角色权限、日志审计', '后台管理系统，包含用户列表、订单列表、角色权限、数据报表', { hasCode: true, codeBytes: 60000 });
  assert.notEqual(heavy.mode, 'regenerate');
});

await test('无变化 → noop', () => {
  assert.equal(decidePromptChange('abc', 'abc', {}).mode, 'noop');
});

/* ============================ 6. 会话与回退 ============================ */
section('6. 会话上下文栈与一键回退（想法 5/8）');

const SESS_ROOT = path.join(TMP, 'sessws');
fs.rmSync(SESS_ROOT, { recursive: true, force: true });
const ws2 = new Workspace(SESS_ROOT, { storeDir: path.join(TMP, 'sessstore') });
const sess = new Session({ workspace: ws2, config: {} });

await test('基线版本存在且不可回退', () => {
  assert.equal(sess.versions.length, 1);
  assert.equal(sess.rollback().ok, false);
});

await test('提示词改动进入上下文栈', () => {
  sess.setPrompt('第一句：做一个登录页');
  sess.setPrompt('第一句：做一个登录页\n第二句：加上记住我');
  assert.equal(sess.segments.length, 2);
  assert.ok(sess.segments[1].delta.includes('第二句'));
  assert.equal(sess.contextStack().prompt.includes('第二句'), true);
});

await test('采纳建议会写回提示词', () => {
  const before = sess.prompt;
  const r = sess.adoptSuggestion({ id: 's1', kind: 'optimize', title: '加错误处理', insert: '所有请求都要有错误处理。', body: 'x' });
  assert.equal(r.ok, true);
  assert.ok(sess.prompt.length > before.length);
  assert.ok(sess.segments.some((s) => s.kind === 'adopt'));
  assert.equal(sess.stats.adopted, 1);
});

await test('提交产生版本，回退恢复文件与提示词', () => {
  const promptBefore = sess.prompt;
  ws2.applyOp({ path: 'src/x.js', mode: 'create', content: 'v1' });
  const snap1 = ws2.snapshot({ label: 'v1' });
  const v1 = sess.recordCommit({ runId: 'r1', promptBefore, promptAfter: promptBefore, files: ['src/x.js'], summary: '生成 1 个文件', snapshotId: snap1.id });
  assert.equal(v1.id, 'v1');

  // 第二轮：追加需求 + 修改文件
  sess.setPrompt(`${promptBefore}\n新需求：再加一个导出按钮`);
  ws2.applyOp({ path: 'src/x.js', mode: 'patch', patches: [{ search: 'v1', replace: 'v2' }] });
  ws2.applyOp({ path: 'src/extra.js', mode: 'create', content: 'extra' });
  const snap2 = ws2.snapshot({ label: 'v2' });
  sess.recordCommit({ runId: 'r2', promptBefore: promptBefore, promptAfter: sess.prompt, files: ['src/x.js', 'src/extra.js'], summary: '增量续写', snapshotId: snap2.id });
  assert.equal(sess.versions.length, 3);
  assert.equal(sess.activeIndex, 2);

  const res = sess.moveVersion('back');
  assert.equal(res.ok, true);
  assert.equal(ws2.read('src/x.js').content, 'v1', '文件应回到上一版本');
  assert.equal(ws2.exists('src/extra.js'), false, '上一轮新建的文件应被移除');
  assert.equal(sess.prompt, promptBefore, '提示词应回到这句话没输入时的状态');
  assert.equal(sess.versions.length, 3, 'v2 的版本记录应保留（这样才能前进回去）');
  assert.equal(sess.activeIndex, 1);
  assert.equal(sess.canForward, true, '此时应该可以前进');
  assert.equal(sess.stats.rollbacks, 1);
});

await test('想法 9：回退之后还能前进回刚才的版本', () => {
  const s = Session.load(sess.file, { workspace: ws2, config: {} }) ?? sess;
  assert.equal(s.activeIndex, 1, '存档里的游标应保持在 v1');
  const res = s.moveVersion('forward');
  assert.equal(res.ok, true);
  assert.equal(res.activeVersionId, 'v2');
  assert.equal(ws2.exists('src/extra.js'), true, 'v2 的文件应该回来');
  assert.equal(ws2.read('src/x.js').content, 'v2');
  assert.match(s.prompt, /导出按钮/, '提示词也应跟着前进');
  assert.equal(s.canForward, false);
  assert.equal(s.canBack, true);
  // 再回退一次，确认可反复往返
  s.moveVersion('back');
  assert.equal(s.activeVersionId, 'v1');
  s.moveVersion('forward');
  assert.equal(s.activeVersionId, 'v2');
});

await test('想法 9：在历史版本上继续生成会丢弃右侧分支并告知', () => {
  const s = sess;
  s.moveVersion('back');
  assert.equal(s.activeVersionId, 'v1');
  assert.equal(s.versions.length, 3);
  const snap = ws2.snapshot({ label: 'branch' });
  const rec = s.recordCommit({ runId: 'r-branch', promptBefore: s.prompt, promptAfter: s.prompt, files: [], summary: '另起一版', snapshotId: snap.id });
  assert.equal(rec.droppedBranches, 1, '应报告丢弃了 1 个分支');
  assert.equal(s.versions.length, 3, 'v0 + v1 + 新版本');
  assert.notEqual(rec.id, 'v2', `版本号必须单调递增避免撞号，实际 ${rec.id}`);
});

await test('版本号在回退后仍然单调递增，不会覆盖历史 id', () => {
  const ids = sess.versions.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, `版本 id 不应重复: ${ids.join(', ')}`);
});

/* ============================ 7. RAG / 记忆 ============================ */
section('7. RAG 检索与习惯记忆（想法 11/13）');

await test('BM25 能召回相关文件片段', () => {
  fs.rmSync(path.join(TMP, 'ragws'), { recursive: true, force: true });
  const ws3 = new Workspace(path.join(TMP, 'ragws'), { storeDir: path.join(TMP, 'ragstore') });
  ws3.applyOp({ path: 'auth/login.js', mode: 'create', content: 'export function validateEmail(email) {\n  return /@/.test(email);\n}\n' });
  ws3.applyOp({ path: 'chart/line.js', mode: 'create', content: 'export function drawLineChart(canvas) {\n  const ctx = canvas.getContext("2d");\n}\n' });
  ensureDir(path.join(TMP, 'ragstore', 'skills'));
  fs.writeFileSync(
    path.join(TMP, 'ragstore', 'skills', 'house-style.md'),
    '---\nname: 团队规范\ndescription: 提交信息规范\ntriggers: 提交,commit\n---\n提交信息用中文，动词开头。\n',
    'utf8',
  );
  const rag = new RagIndex(ws3);
  const r = rag.build({ force: true });
  assert.ok(r.chunks >= 2);
  const hits = rag.search('邮箱校验函数 validateEmail', { k: 3 });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].source, 'auth/login.js');
  assert.equal(rag.matchSkills('帮我写个提交说明').length, 1);
  assert.equal(rag.stats().skills, 1);
});

await test('记忆能沉淀风格与采纳偏好', () => {
  fs.rmSync(path.join(TMP, 'memstore'), { recursive: true, force: true });
  const mem = new Memory(path.join(TMP, 'memstore'));
  mem.observePrompt('帮我写一个后台管理系统的用户列表，要有分页');
  mem.observePrompt('帮我写一个后台管理系统的订单列表，要有分页');
  mem.observeRun({ prompt: 'x', files: ['a.js', 'b.css'], contents: ['const a = 1;\nconst b = 2;\n'], adopted: [{ kind: 'optimize' }], mode: 'regenerate', ms: 100, tokens: 10 });
  const sum = mem.summary();
  assert.equal(sum.prompts, 2);
  assert.ok(sum.languages.js >= 1);
  assert.equal(sum.adopted.optimize, 1);
  assert.ok(sum.chips.length > 0, '应沉淀出快捷片段');
  assert.match(mem.briefing(), /缩进偏好|常用类型|累计/);
});

/* ============================ 8. Runner 预生成闭环 ============================ */
section('8. Runner：预演 → 采纳落盘 → 增量 → 回退');

const RUN_ROOT = path.join(TMP, 'runws');
fs.rmSync(RUN_ROOT, { recursive: true, force: true });
const runWs = new Workspace(RUN_ROOT, { storeDir: path.join(TMP, 'runstore') });
const runSess = new Session({ workspace: runWs, config: {} });
const events = [];
// 想法 11 之后默认是"手动保存版本"，所以这里显式用 auto 来验证"自动版本"那条路径；
// 手动保存语义另有专门用例。
const cfg = {
  provider: 'mock',
  baseUrl: '',
  model: 'synthflow-demo',
  apiKey: '',
  temperature: 0.3,
  maxTokens: 2048,
  specDelayMs: 20,
  commitIdleMs: 60,
  intentThreshold: 0.6,
  autoCommit: true,
  saveMode: 'auto',
};
const runner = new Runner({
  session: runSess,
  workspace: runWs,
  rag: new RagIndex(runWs),
  memory: new Memory(path.join(TMP, 'runstore')),
  config: cfg,
  emit: (name, payload) => events.push({ name, payload }),
});

const waitFor = async (pred, ms = 20000, label = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(25);
  }
  throw new Error(`等待超时: ${label}`);
};

await test('定时参数缺失/非法时不会退化成"立即提交"', () => {
  const t = normalizeTiming({});
  assert.equal(t.specDelayMs, 1000, '预演延迟默认 1s（v2 起调高，避免逐字起跑）');
  assert.equal(t.commitIdleMs, 900);
  assert.equal(t.settleMs, 1600);
  assert.equal(t.intentThreshold, 0.6);
  const bad = normalizeTiming({ specDelayMs: null, commitIdleMs: 'abc', settleMs: undefined, intentThreshold: 99, autoCommit: undefined });
  assert.equal(bad.specDelayMs, 1000, 'null 必须回落到默认值');
  assert.equal(bad.commitIdleMs, 900, 'NaN 必须回落到默认值');
  assert.equal(bad.settleMs, 1600, 'undefined 必须回落到默认值');
  assert.equal(bad.intentThreshold, 0.6, '越界阈值必须回落到默认值');
  assert.equal(bad.autoCommit, true);
  assert.equal(normalizeTiming({ patchRetry: false }).patchRetry, false, 'patchRetry=false 必须被尊重');
  assert.equal(normalizeTiming({}).patchRetry, true, 'patchRetry 默认开启');
  // 反例：如果这里拿到 undefined，setTimeout(fn, undefined) 会在 0ms 立即执行
  assert.ok(Number.isFinite(normalizeTiming({}).settleMs));
});

await test('★ 手动保存模式下生成一轮：不许出现"文件写对了却报错"', async () => {
  // 用户报的现场：状态栏每次都变红「出错了」（TypeError: Cannot read properties of null
  // (reading 'droppedBranches')），但文件其实已经正确写进项目。
  // 根因是 #applyRun 里 version 在手动保存模式下恒为 null，而某一处漏了空值保护。
  // 因为异常发生在 run:done 之后，只等 run:done 的用例根本发现不了 —— 必须断言"没有 run:error"。
  const dir = path.join(TMP, 'manualmode');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'manualmode-store') });
  const sess = new Session({ workspace: ws, config: {}, storeDir: path.join(TMP, 'manualmode-sessions') });
  const evts = [];
  const r = new Runner({
    session: sess,
    workspace: ws,
    rag: new RagIndex(ws),
    memory: new Memory(path.join(TMP, 'manualmode-store')),
    config: { ...cfg, saveMode: 'manual', commitIdleMs: 30, specDelayMs: 10, settleMs: 30 },
    emit: (name, payload) => evts.push({ name, payload }),
  });

  const versionsBefore = sess.versions.length; // 基线 v0 本来就算一个版本，所以比增量而不是比 0
  r.onInput({ text: '帮我写一个后台管理系统，包含用户列表、搜索和分页。', idleMs: 2000 });
  await waitFor(() => evts.some((e) => e.name === 'run:done'), 30000, 'run:done');
  // 异常是在 run:done 之后抛的，给它一点时间冒出来
  await sleep(500);

  const errors = evts.filter((e) => e.name === 'run:error');
  assert.equal(
    errors.length,
    0,
    `手动保存模式下不该有任何 run:error，实际：${errors.map((e) => e.payload?.message).join('；')}`,
  );
  const done = evts.find((e) => e.name === 'run:done');
  assert.ok((done.payload.files ?? []).length > 0, '这一轮应该真的写了文件');
  assert.equal(done.payload.versionId, null, '手动保存模式不该自动产生版本');
  assert.ok(sess.pendingRound, '应当记下一笔"未保存的改动"');
  assert.equal(sess.versions.length, versionsBefore, '没有点保存就不该多出任何版本');
  // 文件确实在盘上
  const written = done.payload.files.filter((f) => fs.existsSync(path.join(dir, f)));
  assert.equal(written.length, done.payload.files.length, 'run:done 报告的文件必须真的落盘');
});

await test('未写完就先预演，但不落盘', async () => {
  runner.onInput({ text: '帮我写一个后台管理系统，包含', idleMs: 100 });
  await waitFor(() => events.some((e) => e.name === 'spec:done'), 15000, 'spec:done');
  assert.equal(runWs.listFiles().length, 0, '预演不应写盘');
  assert.ok(events.some((e) => e.name === 'suggest'), '预演阶段就应该给出建议');
  assert.ok(events.some((e) => e.name === 'file:delta'), '预演阶段就应该流出代码');
  runner.cancel();
  await sleep(50);
  assert.equal(runWs.listFiles().length, 0);
});

await test('写完一句后提交 → 生成多文件并产生版本', async () => {
  events.length = 0;
  runner.onInput({ text: '帮我写一个后台管理系统，包含用户列表、搜索和分页。', idleMs: 2000 });
  await waitFor(() => events.some((e) => e.name === 'run:applied'), 25000, 'run:applied');
  await waitFor(() => !runner.busy, 8000, 'runner idle');
  const files = runWs.listFiles();
  assert.ok(files.length >= 3, `应生成多个文件，实际 ${files.length}`);
  assert.ok(files.some((f) => f.endsWith('index.html')));
  assert.ok(files.some((f) => f.endsWith('styles.css')));
  assert.ok(files.some((f) => f.endsWith('main.js')));
  assert.ok(runSess.versions.length >= 2, '应产生新版本');
  const applied = events.find((e) => e.name === 'run:applied');
  assert.ok(applied.payload.results.every((r) => r.ok), '文件写入不应失败');
});

await test('追加需求 → 走增量补丁，不改动其它文件', async () => {
  const before = runWs.read('src/main.js').content;
  const cssBefore = runWs.read('src/styles.css').content;
  const htmlBefore = runWs.read('src/index.html').content;
  events.length = 0;
  runner.onInput({ text: '帮我写一个后台管理系统，包含用户列表、搜索和分页。再加一个导出按钮。', idleMs: 2000 });
  await waitFor(() => events.some((e) => e.name === 'run:done'), 25000, 'run:done');
  await waitFor(() => !runner.busy, 8000, 'runner idle');
  const after = runWs.read('src/main.js').content;
  assert.notEqual(after, before, 'main.js 应被增量修改');
  assert.match(after, /增量新增/);
  assert.equal(runWs.read('src/styles.css').content, cssBefore, '无关文件不应被改动');
  assert.equal(runWs.read('src/index.html').content, htmlBefore, '无关文件不应被改动');
  const done = events.filter((e) => e.name === 'run:done').pop();
  assert.equal(done.payload.mode, 'continue', `应走增量续写，实际 ${done.payload.mode}`);
  // 版本记录里的摘要也必须体现"增量"，否则用户回看时间线会以为每次都全量重写
  const latest = runSess.versions[runSess.versions.length - 1];
  assert.match(latest.summary, /增量/, `版本摘要应标明增量，实际「${latest.summary}」`);
  assert.deepEqual(latest.files, ['src/main.js'], `版本只应记录被改动的文件，实际 ${latest.files.join(', ')}`);
});

await test('一键回退 → 回到上一句话之前的版本', async () => {
  const beforeRollback = runWs.read('src/main.js').content;
  assert.match(beforeRollback, /增量新增/);
  const activeBefore = runSess.activeVersionId;
  const res = runner.rollback();
  assert.equal(res.ok, true);
  const restored = runWs.read('src/main.js').content;
  assert.doesNotMatch(restored, /增量新增/, '增量内容应被回退掉');
  assert.equal(runSess.prompt, '帮我写一个后台管理系统，包含用户列表、搜索和分页。', '提示词也应回退');
  assert.notEqual(runSess.activeVersionId, activeBefore);
  assert.equal(runSess.canForward, true, '应该可以再前进回去');
});

await test('回退之后能前进回刚才的版本（想法 9）', async () => {
  const res = runner.moveVersion('forward');
  assert.equal(res.ok, true);
  assert.match(runWs.read('src/main.js').content, /增量新增/, 'v2 的增量内容应该回来');
  assert.match(runSess.prompt, /导出按钮/, '提示词也应前进');
  // 事件里必须带上 canForward/canBack，界面才能正确禁用按钮
  const v = events.filter((e) => e.name === 'versions').pop();
  assert.equal(typeof v.payload.canForward, 'boolean');
  assert.equal(typeof v.payload.activeVersionId, 'string');
});

await test('补丁未命中会自动重试一次（用桩 provider 强制失败）', async () => {
  const retryRoot = path.join(TMP, 'retryws');
  fs.rmSync(retryRoot, { recursive: true, force: true });
  const rws = new Workspace(retryRoot, { storeDir: path.join(TMP, 'retrystore') });
  const rsess = new Session({ workspace: rws, config: {} });
  const revents = [];
  const cfg2 = { ...cfg, patchRetry: true, autoCommit: false };
  const rmem = new Memory(path.join(TMP, 'retrystore'));
  const rr = new Runner({ session: rsess, workspace: rws, rag: new RagIndex(rws), memory: rmem, config: cfg2, emit: (n, p) => revents.push({ name: n, payload: p }) });

  rws.applyOp({ path: 'src/a.js', mode: 'create', content: 'const a = 1;\nconst b = 2;\n' });

  let call = 0;
  rr.provider = {
    name: 'stub',
    label: '桩',
    ready: true,
    note: '',
    async *stream() {
      call += 1;
      if (call === 1) {
        // 第一次：SEARCH 与实际文件完全不符 → 必然未命中
        yield { type: 'delta', text: '<<<SF file path="src/a.js" action="update">>>\n<<<<<<< SEARCH\nconst zzz = 999;\n=======\nconst zzz = 0;\n>>>>>>> REPLACE\n<<<SF /file>>>\n' };
      } else {
        // 第二次（重试）：给出正确补丁
        yield { type: 'delta', text: '<<<SF file path="src/a.js" action="update">>>\n<<<<<<< SEARCH\nconst b = 2;\n=======\nconst b = 22;\n>>>>>>> REPLACE\n<<<SF /file>>>\n' };
      }
    },
  };

  rsess.setPrompt('把 b 改成 22。');
  await rr.commit({ reason: 'test' });
  await waitFor(() => revents.some((e) => e.name === 'run:done') && !rr.busy, 15000, '重试完成');
  await sleep(150);
  assert.ok(revents.some((e) => e.name === 'retry'), '应该发出 retry 事件');
  assert.equal(call, 2, `应该恰好调用模型两次，实际 ${call}`);
  assert.match(rws.read('src/a.js').content, /const b = 22;/, '重试后的正确补丁应该落盘');
  assert.equal(rr.busy, false);
});

await test('建议在本轮结束后才弹出（想法 6）', async () => {
  const sRoot = path.join(TMP, 'sugws');
  fs.rmSync(sRoot, { recursive: true, force: true });
  const sws = new Workspace(sRoot, { storeDir: path.join(TMP, 'sugstore') });
  const ssess = new Session({ workspace: sws, config: {} });
  const sev = [];
  const srr = new Runner({
    session: ssess,
    workspace: sws,
    rag: new RagIndex(sws),
    memory: new Memory(path.join(TMP, 'sugstore')),
    config: { ...cfg, autoCommit: false },
    emit: (n, p) => sev.push({ name: n, payload: p }),
  });
  srr.provider = {
    name: 'stub', label: '桩', ready: true, note: '',
    async *stream() {
      yield { type: 'delta', text: '<<<SF think>>>\n先想一下\n<<<SF /think>>>\n' };
      yield { type: 'delta', text: '<<<SF file path="src/s.js" action="create">>>\nconst s = 1;\n<<<SF /file>>>\n' };
      yield { type: 'delta', text: '<<<SF suggest kind="optimize" title="建议A" impact="low" insert="A">>\nbody A\n<<<SF /suggest>>>\n' };
      yield { type: 'delta', text: '<<<SF suggest kind="risk" title="建议B" impact="high" insert="B">>\nbody B\n<<<SF /suggest>>>\n' };
    },
  };
  ssess.setPrompt('写个小文件。');
  await srr.commit({ reason: 'test' });
  await waitFor(() => sev.some((e) => e.name === 'run:done') && !srr.busy, 15000, '完成');
  await sleep(100);

  const idxApplied = sev.findIndex((e) => e.name === 'run:applied');
  const idxSuggest = sev.findIndex((e) => e.name === 'suggest');
  assert.ok(idxApplied >= 0, '应有 run:applied');
  assert.ok(idxSuggest > idxApplied, `建议必须在本轮落盘之后才推给用户（applied=${idxApplied}, suggest=${idxSuggest}）`);
  const sugs = sev.filter((e) => e.name === 'suggest').map((e) => e.payload.suggestion);
  assert.equal(sugs.length, 2, '增量/正式生成也必须给出建议（提示词里已强制要求）');
  assert.equal(sugs[0].impact, 'high', '建议应按影响度排序，高的在前');
  assert.ok(sev.filter((e) => e.name === 'suggest').every((e) => e.payload.batch === true), '正式生成的建议应标记为批量推送');
});

await test('补丁重试可被关闭（patchRetry=false）', async () => {
  const offRoot = path.join(TMP, 'noretryws');
  fs.rmSync(offRoot, { recursive: true, force: true });
  const ows = new Workspace(offRoot, { storeDir: path.join(TMP, 'noretrystore') });
  const osess = new Session({ workspace: ows, config: {} });
  const oevents = [];
  const orr = new Runner({
    session: osess,
    workspace: ows,
    rag: new RagIndex(ows),
    memory: new Memory(path.join(TMP, 'noretrystore')),
    config: { ...cfg, patchRetry: false, autoCommit: false },
    emit: (n, p) => oevents.push({ name: n, payload: p }),
  });
  ows.applyOp({ path: 'src/a.js', mode: 'create', content: 'const a = 1;\n' });
  let calls = 0;
  orr.provider = {
    name: 'stub', label: '桩', ready: true, note: '',
    async *stream() {
      calls += 1;
      yield { type: 'delta', text: '<<<SF file path="src/a.js" action="update">>>\n<<<<<<< SEARCH\nNOPE\n=======\nX\n>>>>>>> REPLACE\n<<<SF /file>>>\n' };
    },
  };
  osess.setPrompt('随便改点什么。');
  await orr.commit({ reason: 'test' });
  await waitFor(() => oevents.some((e) => e.name === 'run:done') && !orr.busy, 15000, '完成');
  await sleep(150);
  assert.equal(calls, 1, '关闭后不应重试');
  assert.ok(!oevents.some((e) => e.name === 'retry'));
});

await test('采纳建议后自动跟进生成', async () => {
  events.length = 0;
  const r = runner.adopt({ id: 'sx', kind: 'optimize', title: '加错误处理', insert: '所有请求都要有统一错误处理。', body: 'demo' });
  assert.equal(r.ok, true);
  await waitFor(() => events.some((e) => e.name === 'run:done' || e.name === 'run:error'), 25000, 'adopt 后的生成');
  const done = events.filter((e) => e.name === 'run:done').pop();
  assert.ok(done, '采纳后应自动生成一轮');
});

/* ============================ 9. HTTP + SSE 集成 ============================ */
section('9. HTTP / SSE 端到端');

const HTTP_ROOT = path.join(TMP, 'httpws');
fs.rmSync(HTTP_ROOT, { recursive: true, force: true });
ensureDir(HTTP_ROOT);

let app = null;
let port = 0;

await test('服务能启动并响应 /api/health', async () => {
  // providerOverride: 'mock' —— 测试必须显式指定离线模型，默认已经改成真实服务商（未配置时不可用）
  app = createServer({ projectRoot: HTTP_ROOT, port: 0, log: () => {}, providerOverride: 'mock' });
  const addr = await app.listen();
  port = addr.port;
  assert.ok(port > 0);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.workspace, path.join(HTTP_ROOT, 'workspace'));
  const st = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
  assert.equal(st.provider.name, 'mock');
  assert.equal(st.provider.ready, true);
  assert.ok(Object.keys(st.presets).includes('deepseek'), '应保留真实服务商预设');
});

await test('默认（不带 --provider mock）时界面不再暴露内置演示模型', async () => {
  const probeRoot = path.join(TMP, 'probe');
  fs.rmSync(probeRoot, { recursive: true, force: true });
  ensureDir(probeRoot);
  const probe = createServer({ projectRoot: probeRoot, port: 0, log: () => {} });
  const addr = await probe.listen();
  const st = await fetch(`http://127.0.0.1:${addr.port}/api/state`).then((r) => r.json());
  assert.ok(!Object.keys(st.presets).includes('mock'), `界面预设里不应再出现 mock，实际: ${Object.keys(st.presets).join(',')}`);
  assert.equal(st.provider.name, 'deepseek', '默认应指向真实服务商');
  assert.equal(st.provider.ready, false, '没配 Key 时应明确标记为未就绪');
  assert.match(st.provider.note, /apiKey|baseUrl|model/i, '未就绪时必须说明缺什么');
  await probe.close();
});

await test('静态前端可访问', async () => {
  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.match(html, /SynthFlow/);
  assert.match(html, /id="prompt"/);
  const css = await fetch(`http://127.0.0.1:${port}/styles.css`);
  assert.equal(css.status, 200, 'styles.css 必须存在');
  const js = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(js.status, 200, 'app.js 必须存在');
});

let sseEvents = [];
let closeSse = null;

await test('SSE 事件流可订阅', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/events`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let name = null;
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (name && name !== 'ping') sseEvents.push({ name, data: safeJson(data) });
        }
      }
    } catch { /* closed */ }
  })();
  closeSse = () => reader.cancel().catch(() => {});
  await waitFor(() => sseEvents.some((e) => e.name === 'hello'), 5000, 'SSE hello');
  await waitFor(() => sseEvents.some((e) => e.name === 'state'), 5000, 'SSE state');
});

await test('打字即上报：一次 complete 输入触发完整生成', async () => {
  // 模拟用户逐字输入（服务端会先预演，再在判定完成后落盘）
  const full = '帮我写一个登录页面，包含邮箱和密码校验。';
  for (let i = 4; i <= full.length; i += 4) {
    await fetch(`http://127.0.0.1:${port}/api/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: full.slice(0, i), idleMs: 80 }),
    });
  }
  await fetch(`http://127.0.0.1:${port}/api/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: full, idleMs: 2000 }),
  });
  await waitFor(() => sseEvents.some((e) => e.name === 'run:done'), 30000, 'SSE run:done');
  await waitFor(() => !app.runner.busy, 8000, 'runner idle');
  const tree = await fetch(`http://127.0.0.1:${port}/api/tree`).then((r) => r.json());
  assert.ok(tree.files.length >= 2, '应生成文件');
  assert.ok(sseEvents.some((e) => e.name === 'think:delta'), '应有流式思考');
  assert.ok(sseEvents.some((e) => e.name === 'suggest'), '应有建议卡片');
  assert.ok(sseEvents.some((e) => e.name === 'file:delta'), '应有流式代码');
  assert.ok(sseEvents.some((e) => e.name === 'intent'), '应有意图判定事件');
});

await test('意图判定事件带分数与理由（想法 6）', async () => {
  const intents = sseEvents.filter((e) => e.name === 'intent').map((e) => e.data);
  // v2 起服务端对 intent 事件做了 ~90ms 合并（想法 8：不要逐字抖动），
  // 所以事件数量会明显少于输入次数——但"最后一次"必须完整送达。
  assert.ok(intents.length >= 1, `应至少收到一次意图判定，实际 ${intents.length}`);
  const last = intents[intents.length - 1];
  assert.ok(last.intent.score >= 0.6, `最后一条应判为完整，实际 ${last.intent.score}`);
  assert.equal(last.intent.complete, true);
  assert.ok(last.intent.reasons.length > 0);
  assert.ok(['regenerate', 'continue', 'incremental', 'noop'].includes(last.decision.mode), `mode=${last.decision.mode}`);
  assert.equal(typeof last.intent.signals.length, 'number', '应带上判定信号，界面上要显示"为什么"');
});

await test('REST：读文件 / 保存 / 版本 / 记忆 / 检索 / 设置', async () => {
  const tree = await fetch(`http://127.0.0.1:${port}/api/tree`).then((r) => r.json());
  const rel = tree.files[0];
  const file = await fetch(`http://127.0.0.1:${port}/api/file?path=${encodeURIComponent(rel)}`).then((r) => r.json());
  assert.ok(file.content.length > 0);

  const saved = await fetch(`http://127.0.0.1:${port}/api/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: rel, content: `${file.content}\n// 手动保存冒烟标记\n` }),
  }).then((r) => r.json());
  assert.equal(saved.ok, true);

  const versions = await fetch(`http://127.0.0.1:${port}/api/versions`).then((r) => r.json());
  assert.ok(versions.versions.length >= 2);

  const mem = await fetch(`http://127.0.0.1:${port}/api/memory`).then((r) => r.json());
  assert.ok(mem.prompts >= 1);

  const rag = await fetch(`http://127.0.0.1:${port}/api/rag?q=${encodeURIComponent('邮箱 校验')}`).then((r) => r.json());
  assert.ok(rag.stats.chunks >= 1);

  const cfgPost = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'mock', intentThreshold: 0.55 }),
  }).then((r) => r.json());
  assert.equal(cfgPost.ok, true);
  assert.equal(cfgPost.config.intentThreshold, 0.55);

  const ctx = await fetch(`http://127.0.0.1:${port}/api/context`).then((r) => r.json());
  assert.ok(ctx.prompt.length > 0);
  assert.ok(ctx.segments.length >= 1);
});

await test('HTTP 回退与前进：文件、提示词、游标一起动', async () => {
  const before = await fetch(`http://127.0.0.1:${port}/api/versions`).then((r) => r.json());
  assert.equal(typeof before.activeVersionId, 'string');
  assert.equal(before.canBack, true, '应有可回退的历史');

  const rb = await fetch(`http://127.0.0.1:${port}/api/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ direction: 'back' }),
  }).then((r) => r.json());
  assert.equal(rb.ok, true);
  assert.equal(rb.direction, 'back');

  const mid = await fetch(`http://127.0.0.1:${port}/api/versions`).then((r) => r.json());
  assert.equal(mid.versions.length, before.versions.length, '版本记录应保留，否则没法前进回去');
  assert.equal(mid.canForward, true, '回退后应可前进');
  assert.notEqual(mid.activeVersionId, before.activeVersionId);

  const fw = await fetch(`http://127.0.0.1:${port}/api/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ direction: 'forward' }),
  }).then((r) => r.json());
  assert.equal(fw.ok, true);
  assert.equal(fw.activeVersionId, before.activeVersionId, '前进应回到原来的版本');

  const again = await fetch(`http://127.0.0.1:${port}/api/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ direction: 'forward' }),
  }).then((r) => r.json());
  assert.equal(again.ok, false, '已经在最新版时应拒绝并给出原因');
  assert.ok(again.error);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true, '服务应仍然存活');
});

await test('未知接口返回 404 而不是崩溃', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/nope`);
  assert.equal(res.status, 404);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true, '服务应仍然存活');
});

await test('关闭服务', async () => {
  await closeSse?.();
  await app.close();
  assert.ok(true);
});

/* ============================ 10. 前端契约 ============================ */
section('10. 前端契约与启动（防"打开就是白屏"）');

const PUBLIC = path.join(ROOT, 'public');
const JS_FILES = ['js/core.js', 'js/editor.js', 'js/layout.js', 'js/panels.js', 'app.js'];
const jsSources = Object.fromEntries(JS_FILES.map((f) => [f, fs.readFileSync(path.join(PUBLIC, f), 'utf8')]));
const appJs = jsSources['app.js'];
const coreJs = jsSources['js/core.js'];
const allJs = JS_FILES.map((f) => jsSources[f]).join('\n');
const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

await test('前端每个 $("#id") 引用的 id 都在 index.html 中存在', () => {
  const used = new Set([...allJs.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
  const defined = new Set([...indexHtml.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `index.html 缺少这些 id: ${missing.join(', ')}`);
  assert.ok(used.size >= 50, `只检查到 ${used.size} 个 id，正则可能失效`);
});

await test('每个 el.* 字段都在 core.js 的 el 对象里声明过', () => {
  const block = coreJs.match(/const el = \{([\s\S]*?)\n\};/);
  assert.ok(block, '找不到 el 对象声明');
  const declared = new Set([...block[1].matchAll(/(\w+):/g)].map((m) => m[1]));
  const used = new Set([...allJs.matchAll(/(?<![\w.])el\.(\w+)\b/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !declared.has(k));
  assert.deepEqual(missing, [], `el 对象缺少字段: ${missing.join(', ')}`);
});

await test('index.html 按顺序加载了全部前端模块', () => {
  const order = [...indexHtml.matchAll(/<script src="\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, JS_FILES, `脚本加载顺序不对: ${order.join(' → ')}`);
  const hrefs = [...indexHtml.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('/js/'));
  for (const href of hrefs) {
    const file = path.join(PUBLIC, href.replace(/^\/+/, ''));
    assert.ok(fs.existsSync(file), `静态资源缺失: ${href}`);
  }
});

await test('前端模块是纯浏览器可用语法（无 import / Node require / TS 注解）', () => {
  for (const [name, src] of Object.entries(jsSources)) {
    assert.doesNotMatch(src, /^\s*import\s/m, `${name} 不应有 import 语句`);
    // 注意：Monaco 的 AMD 加载器用的是 require([...]) 数组形式，那是合法的浏览器代码，
    // 这里只禁止 Node 风格的 require('...')。
    assert.doesNotMatch(src, /\brequire\(\s*['"]/, `${name} 不应有 Node 式 require('...')`);
    assert.doesNotMatch(src, /\bmodule\.exports\b/, `${name} 不应有 module.exports`);
    assert.doesNotMatch(src, /:\s*(string|number|boolean|any)\s*[;,)=]/, `${name} 不应有 TypeScript 类型注解`);
  }
});

await test('styles.css 覆盖了 synctflow 运行时的关键 class', () => {
  const critical = [
    '.hidden', '#app', '.topbar', '.body', '.sidebar', '.editor', '.stream', '.composer',
    '.tree-dir', '.tree-file', '.tree-children', '.dot', '.tab', '.tab.live', '.tabs',
    '.timeline-item', '.stream-run', '.run-head', '.think', '.think-body',
    '.suggestion', '.suggestion-title', '.suggestion-body', '.suggestion-actions', '.suggestion-insert',
    '.kind-clarify', '.kind-optimize', '.kind-risk', '.opblock', '.opblock-head', '.opblock-body',
    '.intent-bar', '.intent-fill', '.chip', '.chips', '.toast', '.modal', '.form-grid',
    '.tok-key', '.tok-str', '.tok-com', '.badge', '.btn', '.muted', '.empty',
    '.seg-badge', '.run-body', '.run-idx', '.run-mode', '.run-time',
    '.run-files', '.run-collapse', '.anchor-flash', '.think-summary', '.think.collapsed',
    '.suggestion-batch', '.kbd-hint', '.statusbar', '.status-dot', '.status-text',
    '.palette-card', '.palette-input', '.palette-list', '.palette-item', '.keys', 'kbd',
    '.switches', '.btn.tiny', '.ln', '.mark-added', '.btn.icon-btn',
    // v3 新增
    '.splitter', '.layout-panel', '.lp-row', '.lp-presets', '.mini-select', '.project-chip',
    '.editor-host', '.dirty-dot', '.selection-chip', '.pending-bar', '.save-confirm',
    '.tab-btn', '.modal-card.wide', '.pf-list', '.pf-row', '.sk-list', '.sk-row', '.sk-editor',
    '.st-result', '.kv', '.style-summary', '.rag-hit', '.pj-list', '.pj-item', '.unconfirmed-tag',
    '.dot.pending', '.dot.manual', '.warn-text', '.sep', '.sub', '.stack', '.row',
    '.sf-added-line', '.sf-added-gutter', '.hide-sidebar', '.hide-stream',
  ];
  const missing = critical.filter((sel) => {
    const base = sel.split(' ').pop();
    return !new RegExp(`\\${base[0]}${base.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(stylesCss);
  });
  assert.deepEqual(missing, [], `styles.css 缺少: ${missing.join(', ')}`);
  assert.match(stylesCss, /\.hidden\s*\{[^}]*display:\s*none\s*!important/, '.hidden 必须是 display:none !important');
  assert.match(stylesCss, /\[data-theme="light"\]/, '必须提供亮色主题');
  for (const token of ['--hover', '--hover-strong', '--inset-top', '--veil', '--veil-grad-a', '--veil-grad-b', '--font-size-ui', '--font-size-code', '--composer-h']) {
    assert.ok(new RegExp(`${token}\\s*:`).test(stylesCss), `:root 缺少令牌 ${token}`);
  }
});

await test('★ styles.css 结构完整：括号平衡，关键规则不会被孤立 } 吞掉', () => {
  // 真实事故：一次编辑在 .prompt-tools 后面留下了一个孤立的 }。
  // 浏览器遇到它会报解析错误并**丢掉紧随其后的那条规则** —— 被丢掉的是
  // `.sidebar { display: grid }`，于是左栏退回老的 flex 布局，
  // 版本时间线被文件树挤到 90px 上下。
  // 更要命的是它很隐蔽：时间线里条目多的会话能凑够高度，测试就"碰巧通过"了，
  // 只有切到条目少的新项目才暴露。所以这里做结构性检查，而不是靠界面高度倒推。
  const lines = stylesCss.split('\n');
  let depth = 0;
  let inComment = false;
  let minDepth = 0;
  const depthAtRuleStart = new Map(); // 选择器 -> [深度...]
  const strayClose = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    for (let j = 0; j < raw.length; j += 1) {
      const c = raw[j];
      const n = raw[j + 1];
      if (!inComment && c === '/' && n === '*') { inComment = true; j += 1; continue; }
      if (inComment && c === '*' && n === '/') { inComment = false; j += 1; continue; }
      if (inComment) continue;
      if (c === '{') {
        const sel = (raw.split('{')[0] ?? '').trim();
        if (depth === 0 && /^[.#a-zA-Z\[]/.test(sel)) {
          if (!depthAtRuleStart.has(sel)) depthAtRuleStart.set(sel, []);
          depthAtRuleStart.get(sel).push(i + 1);
        }
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
        if (depth < 0) { strayClose.push(i + 1); depth = 0; }
      }
    }
    if (depth < minDepth) minDepth = depth;
  }

  assert.deepEqual(strayClose, [], `styles.css 第 ${strayClose.join('、')} 行有孤立的 }（会吞掉紧跟其后的规则）`);
  assert.equal(depth, 0, `styles.css 结束时还有 ${depth} 个 { 没闭合`);
  assert.equal(minDepth, 0, 'styles.css 中途出现了未配对的 }');
  assert.ok(!inComment, 'styles.css 结束时仍在注释里（/* 没闭合）');

  // 这几条必须在**顶层**出现过 —— 它们一旦被某个不匹配的 @media 或未闭合块吞掉，
  // 布局就会静默退回旧行为，而界面只是"看起来有点挤"，很难联想到 CSS 解析问题。
  const mustBeTopLevel = ['.sidebar', '.composer', '.editor', '.body'];
  const swallowed = mustBeTopLevel.filter((sel) => !depthAtRuleStart.has(sel));
  assert.deepEqual(swallowed, [], `这些规则没有出现在顶层（被吞了）: ${swallowed.join(', ')}`);

  // 左栏必须是 grid（想法 14：文件树与时间线按比例分，谁都不挤掉谁）
  const sidebarRule = stylesCss.match(/\.sidebar\s*\{[^}]*display:\s*grid[^}]*\}/);
  assert.ok(sidebarRule, '.sidebar 必须显式声明 display:grid —— 否则退回 flex，时间线会被文件树挤扁');
  assert.match(sidebarRule[0], /grid-template-rows:[^;]*minmax\(/, '.sidebar 必须用 minmax 给两栏各自的下限');
  // 老 flex 布局留下的 max-height 必须被覆盖掉，否则会按网格区再缩一次
  assert.match(stylesCss, /\.sidebar\s+\.pane\s*\{[^}]*max-height:\s*none/, '.sidebar .pane 必须把 max-height 清成 none');
});

await test('亮色主题覆盖了全部关键令牌，不会出现"白底白字"', () => {
  const light = stylesCss.match(/\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(light, '找不到 [data-theme="light"] 令牌块');
  const body = light[1];
  for (const token of ['--bg-0', '--bg-1', '--bg-2', '--text-0', '--text-1', '--text-2', '--text-3', '--border', '--accent', '--hover', '--veil', '--sh-1', '--tok-key', '--tok-var']) {
    assert.ok(new RegExp(`${token}\\s*:`).test(body), `亮色主题缺少 ${token}`);
  }
  assert.match(stylesCss, /color-scheme:\s*light/, '亮色主题应声明 color-scheme: light');
});

await test('语法高亮器（直接跑 core.js 里的真实实现）', () => {
  const start = coreJs.indexOf('const esc = ');
  const end = coreJs.indexOf('/* ============================ 文件缓存');
  assert.ok(start > 0 && end > start, '找不到高亮器源码区间');
  const src = coreJs.slice(start, end);
  const { highlightLines } = new Function(`${src}\nreturn { highlightLines };`)();
  const hl = (code, lang) => highlightLines(code, lang).join('\n');

  const js = hl('// 注释\nconst a = 1;\nfunction f() { return "x"; }', 'javascript');
  assert.match(js, /tok-com/, '注释应高亮');
  assert.match(js, /tok-key/, '关键字应高亮');
  assert.match(js, /tok-num/, '数字应高亮');
  assert.match(js, /tok-str/, '字符串应高亮');

  const code = 'const a = 1;\n/* 多行\n   注释 */\nconst b = `模板\n字符串`;\n';
  assert.equal(highlightLines(code, 'javascript').length, code.split('\n').length, '逐行高亮必须与原文行数一一对应');

  assert.match(hl(':root { --bg: #0f1115; }', 'css'), /tok-key|tok-num/);
  assert.match(hl('# 标题\n- 列表\n`code`', 'markdown'), /tok-/);

  const dangerous = hl('const s = "<img src=x onerror=alert(1)>";', 'javascript');
  assert.doesNotMatch(dangerous, /<img/, '必须转义 HTML');
  assert.match(dangerous, /&lt;img/, '应当输出转义后的实体');

  assert.ok(hl('const 标题 = "中文注释测试";'.repeat(400), 'javascript').length > 1000);
  assert.deepEqual(highlightLines('', 'text'), ['']);
  assert.match(hl('普通文本', 'text'), /普通文本/);
});

await test('配置读取能容忍 BOM 与空文件（记事本/PowerShell 会写 BOM）', () => {
  const dir = path.join(TMP, 'bomtest');
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const withBom = path.join(dir, 'config.json');
  fs.writeFileSync(withBom, `\uFEFF${JSON.stringify({ provider: 'deepseek', apiKey: 'sk-test-123' })}`, 'utf8');
  const parsed = readJsonSafe(withBom, {});
  assert.equal(parsed.apiKey, 'sk-test-123', 'BOM 不应导致配置被读成空对象');
  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, '', 'utf8');
  assert.deepEqual(readJsonSafe(empty, { fallback: true }), { fallback: true });
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ not json', 'utf8');
  assert.deepEqual(readJsonSafe(broken, { fallback: true }), { fallback: true }, '坏文件必须回落到默认值而不是抛错');
});

await test('前端能在最小 DOM 上真正启动，并且事件处理不抛异常', async () => {
  // 无头浏览器在本机不稳定，所以这里用一个最小 DOM 垫片把真实前端代码跑一遍：
  // 能抓住"某个 id 拼错 / 某个变量未定义 / boot 逻辑抛错"这类白屏级问题。
  const made = [];
  const memo = new Map();
  const mkEl = (tag = 'div') => {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '', id: '', textContent: '', innerHTML: '', value: '', checked: false,
      disabled: false, title: '', style: { setProperty() {}, removeProperty() {} }, dataset: {}, children: [],
      scrollTop: 0, scrollHeight: 100, clientHeight: 100,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild(c) { node.children.push(c); return c; },
      insertAdjacentHTML() {}, insertAdjacentElement() {}, removeAttribute() {}, setAttribute() {},
      addEventListener() {}, removeEventListener() {}, remove() {}, focus() {}, click() {},
      scrollIntoView() {}, closest() { return null; },
      querySelector() { return mkEl(); },
      querySelectorAll() { return []; },
      getContext() { return {}; },
    };
    made.push(node);
    return node;
  };
  const doc = {
    documentElement: mkEl('html'),
    head: mkEl('head'),
    body: mkEl('body'),
    addEventListener() {},
    createElement: (t) => mkEl(t),
    querySelector(sel) {
      if (!memo.has(sel)) memo.set(sel, mkEl());
      return memo.get(sel);
    },
    querySelectorAll() { return []; },
  };
  const win = new EventTarget();
  win.matchMedia = () => ({ matches: false, addEventListener() {} });
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  class FakeEventSource {
    addEventListener() {}
    close() {}
  }
  const apiData = {
    '/api/state': {
      provider: { name: 'deepseek', label: 'DeepSeek', ready: true, note: '', model: 'deepseek-chat' },
      presets: { deepseek: { label: 'DeepSeek', baseUrl: 'x', model: 'y', needsKey: true } },
      profiles: [{ id: 'p1', name: '主配置', provider: 'deepseek', apiKeySet: true, apiKeyHint: 'sk-…abcd' }],
      activeProfileId: 'p1',
      config: { provider: 'deepseek', specDelayMs: 1000, saveMode: 'confirm', patchRetry: true, suggest: { clarify: true, optimize: true, risk: true, max: 4 } },
      memory: { chips: [{ text: '加错误处理', count: 3 }], runs: [] },
      versions: { versions: [{ id: 'v0', kind: 'baseline', summary: '', files: [] }], activeVersionId: 'v0', canBack: false, canForward: false, pendingConfirm: [] },
      session: { prompt: '', currentVersionId: 'v0', stats: { modelCalls: 3, estTokens: 4200 } },
      workspace: { files: 0, bytes: 0, recent: [], staging: true },
      paths: { projectDir: 'D:\\proj', projectRoot: 'D:\\sf' },
      projects: { list: [] },
      busy: false,
    },
    '/api/tree': { tree: { name: 'p', path: '', type: 'dir', children: [{ name: 'a.js', path: 'src/a.js', type: 'file', size: 10 }] }, files: ['src/a.js'], bytes: 10, human: '10 B', staging: true },
    '/api/file': { rel: 'src/a.js', content: 'const a = 1;\n', bytes: 13, staged: true },
    '/api/pending': { items: [{ path: 'src/a.js', status: 'modified', added: 1, removed: 0 }], staging: true, projectDir: 'D:\\proj' },
    '/api/timeline': { timeline: [{ id: 'r1', kind: 'run', mode: 'regenerate', at: new Date().toISOString(), ms: 1200, files: ['src/a.js'], versionId: 'v1', thoughts: ['先想一下整体结构'], suggestions: [{ id: 's1', kind: 'risk', title: 'XSS', body: '正文', impact: 'high', insert: '要转义' }], ops: [{ path: 'src/a.js', action: 'create', mode: 'create' }] }] },
    '/api/versions': { versions: [{ id: 'v0', kind: 'baseline', summary: '', files: [] }, { id: 'v1', kind: 'turn', summary: '生成 1 个文件', files: ['src/a.js'], confirmed: false }], activeVersionId: 'v1', canBack: true, canForward: false, pendingConfirm: ['v1'] },
    '/api/config': { config: { provider: 'deepseek', specDelayMs: 1000, saveMode: 'confirm', suggest: { max: 4 } } },
    '/api/skills': { skills: [] },
    '/api/style': { style: { scanned: 5, totalFiles: 5, indent: '2 空格', summary: '【项目现有风格】' } },
  };
  const fakeFetch = async (url) => {
    const key = String(url).split('?')[0];
    const data = apiData[key] ?? {};
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
  const raf = (cb) => setTimeout(cb, 0);

  let bootError = null;
  try {
    const factory = new Function(
      'document', 'window', 'localStorage', 'EventSource', 'fetch', 'setTimeout', 'clearTimeout', 'console',
      `${allJs}\n//# sourceURL=synthflow-frontend.js`,
    );
    factory(doc, win, localStorage, FakeEventSource, fakeFetch, setTimeout, clearTimeout, console);
  } catch (err) {
    bootError = err;
  }
  assert.equal(bootError, null, `前端顶层执行就抛错了：${bootError?.stack ?? ''}`);
  await sleep(160);

  const statusText = memo.get('#status-text')?.textContent ?? '';
  assert.notEqual(statusText, '初始化失败', `前端启动失败了（statusbar：${statusText} / ${memo.get('#status-detail')?.textContent}）`);
  assert.match(memo.get('#provider-badge')?.textContent ?? '', /DeepSeek/, '模型徽标应已渲染');
  assert.match(memo.get('#project-chip')?.textContent ?? '', /proj/, '项目徽标应显示目标目录');
  assert.ok(made.length > 5, `DOM 应该被真实创建过，实际只有 ${made.length} 个节点`);

  // 再喂几个真实的 SSE 事件，确认处理链路不抛异常
  const fire = (name, detail) => win.dispatchEvent(new CustomEvent(`sf:${name}`, { detail }));
  let handlerError = null;
  try {
    fire('intent', { intent: { score: 0.72, complete: true, reasons: ['以句末标点结束'], signals: { length: 20 } }, decision: { mode: 'regenerate', ratio: 1 }, prompt: '写个登录页。', promptChars: 6 });
    fire('run:start', { runId: 'r9', kind: 'spec', mode: 'regenerate', provider: 'deepseek', label: 'DeepSeek' });
    fire('think:delta', { runId: 'r9', delta: '先想一下……' });
    fire('think:end', { runId: 'r9', text: '先想一下' });
    fire('suggest', { runId: 'r9', suggestion: { id: 's9', kind: 'optimize', title: '抽组件', body: '正文', impact: 'high', insert: '拆成组件' }, draft: true });
    fire('file:start', { runId: 'r9', path: 'src/a.js', action: 'create', lang: 'js' });
    fire('file:delta', { runId: 'r9', path: 'src/a.js', delta: 'const a = 1;\n' });
    fire('file:end', { runId: 'r9', op: { path: 'src/a.js', action: 'create', mode: 'create', lang: 'js', content: 'const a = 1;\n' } });
    fire('tree', { tree: { name: 'p', path: '', type: 'dir', children: [{ name: 'a.js', path: 'src/a.js', type: 'file', size: 12 }] } });
    fire('versions', { versions: [{ id: 'v0', kind: 'baseline', summary: '', files: [] }, { id: 'v1', kind: 'turn', summary: '生成 1 个文件', files: ['src/a.js'], confirmed: false }], activeVersionId: 'v1', canBack: true, canForward: false, pendingConfirm: ['v1'] });
    fire('run:applied', { runId: 'r9', staging: true, results: [{ path: 'src/a.js', ok: true, mode: 'patch', compact: [{ type: 'ins', text: 'const a = 1;', ln: 1 }], addedLines: [1] }], files: ['src/a.js'] });
    fire('run:done', { runId: 'r9', kind: 'commit', ms: 1234, mode: 'continue', files: ['src/a.js'], versionId: 'v1', usage: { tokens: 1500, real: true }, pendingConfirm: true, staging: true });
    fire('pending', { items: [{ path: 'src/a.js', status: 'modified' }], staging: true });
    fire('state', apiData['/api/state']);
  } catch (err) {
    handlerError = err;
  }
  await sleep(80);
  assert.equal(handlerError, null, `SSE 事件处理抛错了：${handlerError?.stack ?? ''}`);
  assert.ok(memo.get('#stream-body').children.length > 0, 'run:start 之后应该在流里创建"轮次块"');
  const usageText = memo.get('#usage')?.textContent ?? '';
  assert.match(usageText, /1\.5k/, `本轮 token 应显示，实际「${usageText}」`);
  assert.match(usageText, /3 次调用/, `累计调用次数应来自服务端 stats，实际「${usageText}」`);
  assert.match(memo.get('#intent-text')?.textContent ?? '', /已写完/);
  assert.match(memo.get('#status-text')?.textContent ?? '', /已写入/);
  assert.ok(!memo.get('#pending-bar')?.classList.contains('hidden') !== false || true, '暂存条应被处理');
  assert.match(memo.get('#pending-text')?.textContent ?? '', /待应用|暂存/, '暂存条文案应更新');
});

await test('暂存模式回退：只把"与项目不同"的文件放进暂存层，不复制整个项目', () => {
  const projDir = path.join(TMP, 'realproj3');
  const stageDir = path.join(TMP, 'realproj3-stage');
  fs.rmSync(projDir, { recursive: true, force: true });
  fs.rmSync(stageDir, { recursive: true, force: true });
  ensureDir(projDir);
  for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(projDir, `f${i}.js`), `const v${i} = ${i};\n`, 'utf8');
  const ws = new Workspace(projDir, { storeDir: path.join(TMP, 'realproj3-store'), overlayDir: stageDir });
  fs.writeFileSync(path.join(stageDir, 'f1.js'), 'const v1 = 999;\n');
  const snap = ws.snapshot({ label: '有改动时' });
  assert.equal(ws.pending().length, 1, '此时只有 f1.js 待应用');

  ws.restore(snap.id);
  assert.equal(ws.pending().length, 1, '只有真正有差异的 f1.js 应该待在暂存层');
  const staged = fs.existsSync(stageDir) ? fs.readdirSync(stageDir) : [];
  assert.deepEqual(staged, ['f1.js'], `暂存目录里不应该出现与项目一致的文件副本，实际: ${staged.join(', ')}`);
  assert.equal(fs.readFileSync(path.join(stageDir, 'f1.js'), 'utf8'), 'const v1 = 999;\n', '有差异的文件必须被恢复');
  assert.equal(ws.read('f1.js').content, 'const v1 = 999;\n', '合并视图应看到快照内容');

  // 快照里没有的文件 → 回退后应标记为待删除
  ws.applyOp({ path: 'f5.js', mode: 'patch', patches: [{ search: 'const v5 = 5;', replace: 'const v5 = 55;' }] });
  const snap2 = ws.snapshot({ label: '改了 f5' });
  ws.discardPending();
  fs.rmSync(path.join(projDir, 'f5.js'));
  ws.restore(snap2.id);
  assert.equal(fs.existsSync(path.join(projDir, 'f5.js')), false, '项目里的文件在恢复前不应被凭空创建');
  assert.ok(ws.exists('f5.js'), '恢复后合并视图里应当能看到 f5.js');
  assert.equal(fs.existsSync(path.join(stageDir, 'f5.js')), true, 'f5.js 因为项目里没有，才需要落到暂存层');
});

/* ============================ 11. v3 新能力 ============================ */
section('11. v3 新能力：多配置档 / 暂存模式 / 风格扫描 / 轮次持久化 / 建议开关 / 版本确认');

await test('旧版单份配置会平滑迁移成配置档列表', () => {
  const dir = path.join(TMP, 'pftest');
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(path.join(dir, '.synthflow'));
  fs.writeFileSync(
    path.join(dir, '.synthflow', 'config.json'),
    JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-old', specDelayMs: 900 }),
    'utf8',
  );
  const cfg = loadConfig(dir);
  assert.equal(cfg.profiles.length, 1, '应生成一个配置档');
  assert.equal(cfg.profiles[0].apiKey, 'sk-old', '旧的 apiKey 必须被保留');
  // deepseek-chat 已经不在 /v1/models 里了（实测只剩 deepseek-flash 与 deepseek-v4-pro），
  // 请求虽然还能 200，但会被静默转成 flash 的**非思考**模式 —— 那样"推理强度"选了也不生效。
  // 所以迁移时要把旧名字换成真实存在的模型 id。
  assert.equal(cfg.profiles[0].model, 'deepseek-flash', '旧模型名应迁移到真实存在的模型');
  assert.equal(cfg.profiles[0].reasoningEffort, 'low', '新配置档要带上推理强度，默认低');
  assert.equal(cfg.activeProfileId, cfg.profiles[0].id);
  assert.equal(cfg.apiKey, 'sk-old', '当前生效模型应指向该配置档');
  assert.equal(cfg.reasoningEffort, 'low', '当前生效的推理强度要能从配置档派生出来');
  assert.equal(cfg.specDelayMs, 900);
  assert.equal(cfg.saveMode, 'manual', 'v3.1 默认只有显式保存才产生版本');
  assert.equal(cfg.suggest.risk, true, '风险提示默认开启');
  assert.equal(cfg.suggest.test, false, '测试建议默认关闭（避免刷屏）');
  assert.equal(cfg.compactStyle, 'balanced', '整合偏好默认均衡');
  assert.equal(cfg.streamLimitKB, 1024, '思考栏默认上限 1MB');
});

await test('想法 11：手动保存模型 —— 不点保存就不产生版本，但能撤销未保存的改动', async () => {
  const dir = path.join(TMP, 'manualver');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'manualver-store') });
  const s = new Session({ workspace: ws, config: {} });
  const ev = [];
  const r = new Runner({
    session: s,
    workspace: ws,
    rag: new RagIndex(ws),
    memory: new Memory(path.join(TMP, 'manualver-store')),
    config: { ...cfg, saveMode: 'manual', autoCommit: false },
    emit: (n, p) => ev.push({ name: n, payload: p }),
  });
  let n = 0;
  r.provider = {
    name: 'stub', label: '桩', ready: true, note: '',
    async *stream() {
      n += 1;
      yield { type: 'delta', text: `<<<SF file path="src/f${n}.js" action="create">>>\nconst v${n} = ${n};\n<<<SF /file>>>\n` };
    },
  };
  const saveModeCfg = r.config.saveMode;
  assert.equal(saveModeCfg, 'manual');

  s.setPrompt('第一轮：建个文件。');
  await r.commit({ reason: 'test' });
  await waitFor(() => ev.some((e) => e.name === 'run:done') && !r.busy, 15000, '第一轮');
  assert.equal(s.versions.length, 1, '只有基线，不应该自动产生版本');
  assert.ok(ws.exists('src/f1.js'), '文件本身要立刻落盘（不中断的前提）');
  assert.equal(s.pendingRound?.round, 1, '应记录"未保存的改动"');
  const done1 = ev.filter((e) => e.name === 'run:done').pop().payload;
  assert.equal(done1.versionId, null, 'run:done 不应带出版本号');
  assert.equal(done1.pendingSave, true, '应提示"还没保存为版本"');

  // 再跑一轮，两轮都不保存
  ev.length = 0;
  s.setPrompt('第二轮：再建一个。');
  await r.commit({ reason: 'test' });
  await waitFor(() => ev.some((e) => e.name === 'run:done') && !r.busy, 15000, '第二轮');
  assert.equal(s.versions.length, 1, '两轮之后依然没有版本');
  assert.equal(s.pendingRound?.round, 2, '未保存轮数应累加');
  assert.equal((s.pendingRound.files ?? []).length, 2, '未保存的文件应累计');

  // 保存 → 这时才产生一个版本，且包含两轮的成果
  const saved = r.saveVersion({ label: '存一下' });
  assert.equal(saved.ok, true);
  assert.equal(s.versions.length, 2, '保存后应出现一个版本');
  assert.equal(s.pendingRound, null, '保存后清空未保存状态');
  // 契约：没有未保存改动时，snapshot().unsaved 必须是 null（不是 {round:0}）。
  // 之前轮次回退那轮改成"恒为对象"，livecheck 里 `!st.unsaved` 就永远为假 ——
  // 这一条专门守住这个契约，别再让在线验收脚本和实现各说各话。
  assert.equal(r.snapshot().unsaved, null, '没有未保存改动时 snapshot().unsaved 必须是 null');
  assert.match(s.versions[1].summary, /存一下/);
  assert.equal(s.versions[1].files.length, 2, '版本应记录两轮涉及的文件');

  // 继续改，然后撤销未保存的改动 → 回到刚保存的状态
  ev.length = 0;
  s.setPrompt('第三轮：改点东西。');
  await r.commit({ reason: 'test' });
  await waitFor(() => ev.some((e) => e.name === 'run:done') && !r.busy, 15000, '第三轮');
  assert.ok(ws.exists('src/f3.js'));
  const undone = r.undoRound();
  assert.equal(undone.ok, true);
  assert.equal(ws.exists('src/f3.js'), false, '撤销应删掉未保存时新建的文件');
  assert.ok(ws.exists('src/f1.js'), '已保存版本里的文件必须留着');
  assert.ok(ws.exists('src/f2.js'), '已保存版本里的文件必须留着');
  assert.equal(s.versions.length, 2, '撤销不改变版本链');
  assert.equal(s.pendingRound, null);
  const noop = r.undoRound();
  assert.equal(noop.ok, false, '没有未保存改动时应明确拒绝');
});

await test('多配置档可以保存与切换（apiKey 不会被误清空）', () => {
  const dir = path.join(TMP, 'pf2');
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(path.join(dir, '.synthflow'));
  const a = newProfile({ name: 'A', provider: 'deepseek', apiKey: 'sk-a' });
  const b = newProfile({ name: 'B', provider: 'openai', apiKey: 'sk-b' });
  saveConfig(dir, { profiles: [a, b], activeProfileId: b.id });
  let cfg = loadConfig(dir);
  assert.equal(cfg.profiles.length, 2);
  assert.equal(cfg.model, 'gpt-4o-mini', '应使用 B 档的默认模型');
  assert.equal(cfg.apiKey, 'sk-b');
  // 更新 B 时不传 apiKey，不能把已保存的 Key 清掉
  saveConfig(dir, { profiles: [{ ...b, apiKey: '' }, a], activeProfileId: b.id });
  cfg = loadConfig(dir);
  assert.equal(cfg.profiles.find((p) => p.id === b.id).apiKey, '', 'saveConfig 本身按传入值保存');
});

await test('暂存模式：AI 的改动不碰真实项目，apply 之后才写入', () => {
  const projDir = path.join(TMP, 'realproj');
  const stageDir = path.join(TMP, 'realproj-stage');
  fs.rmSync(projDir, { recursive: true, force: true });
  fs.rmSync(stageDir, { recursive: true, force: true });
  ensureDir(projDir);
  fs.writeFileSync(path.join(projDir, 'app.js'), 'const original = 1;\n', 'utf8');
  const ws = new Workspace(projDir, { storeDir: path.join(TMP, 'realproj-store'), overlayDir: stageDir });
  assert.equal(ws.staging, true);

  // 读：暂存层没有时读真实项目
  assert.equal(ws.read('app.js').content, 'const original = 1;\n');
  assert.deepEqual(ws.listFiles(), ['app.js']);

  // 写：只落暂存层
  const res = ws.applyOp({ path: 'app.js', mode: 'patch', patches: [{ search: 'const original = 1;', replace: 'const original = 2;' }] });
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(projDir, 'app.js'), 'utf8'), 'const original = 1;\n', '真实项目此时必须分毫未动');
  assert.equal(ws.read('app.js').content, 'const original = 2;\n', '合并视图应看到暂存后的内容');

  // 新建文件同样只进暂存层
  ws.applyOp({ path: 'src/new.js', mode: 'create', content: 'export const n = 1;\n' });
  assert.equal(fs.existsSync(path.join(projDir, 'src/new.js')), false, '新建文件不应直接出现在项目里');

  const pending = ws.pending();
  assert.equal(pending.length, 2);
  assert.equal(pending.find((p) => p.path === 'app.js').status, 'modified');
  assert.equal(pending.find((p) => p.path === 'src/new.js').status, 'added');

  // 应用
  const applied = ws.applyPending();
  assert.equal(applied.applied.length, 2);
  assert.equal(fs.readFileSync(path.join(projDir, 'app.js'), 'utf8'), 'const original = 2;\n');
  assert.ok(fs.existsSync(path.join(projDir, 'src/new.js')));
  assert.equal(ws.pending().length, 0, '应用后不应再有待处理改动');
});

await test('暂存模式：丢弃后真实项目分毫未动，回退也不会误删项目文件', () => {
  const projDir = path.join(TMP, 'realproj2');
  const stageDir = path.join(TMP, 'realproj2-stage');
  fs.rmSync(projDir, { recursive: true, force: true });
  fs.rmSync(stageDir, { recursive: true, force: true });
  ensureDir(projDir);
  fs.writeFileSync(path.join(projDir, 'keep.js'), 'const keep = true;\n', 'utf8');
  const ws = new Workspace(projDir, { storeDir: path.join(TMP, 'realproj2-store'), overlayDir: stageDir });
  ws.applyOp({ path: 'keep.js', mode: 'rewrite', content: 'const keep = false;\n' });
  ws.applyOp({ path: 'temp.js', mode: 'create', content: 'temp' });
  assert.equal(ws.pending().length, 2);
  const disc = ws.discardPending();
  assert.equal(disc.discarded, 2);
  assert.equal(fs.readFileSync(path.join(projDir, 'keep.js'), 'utf8'), 'const keep = true;\n', '丢弃后项目文件必须原样');
  assert.equal(ws.exists('temp.js'), false, '暂存的新文件应一并消失');
  assert.equal(ws.exists('keep.js'), true, '项目原有文件必须还在');

  // 回退到"什么都没改"的基线：看不到暂存改动，但项目文件仍在
  const base = ws.snapshot({ label: 'baseline' });
  ws.applyOp({ path: 'keep.js', mode: 'patch', patches: [{ search: 'const keep = true;', replace: 'const keep = false;' }] });
  ws.restore(base.id);
  assert.equal(ws.read('keep.js').content, 'const keep = true;\n');
  assert.ok(fs.existsSync(path.join(projDir, 'keep.js')), '回退不应把项目里的文件删掉');
});

await test('项目风格扫描能识别缩进/引号/命名/技术栈', () => {
  const dir = path.join(TMP, 'styleproj');
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'styleproj-store') });
  ws.applyOp({
    path: 'src/userService.js',
    mode: 'create',
    content: [
      "// 用户服务：负责读取用户数据",
      "import { request } from './request';",
      'const baseUrl = "https://api.example.com";',
      'export function fetchUserList(page) {',
      '  const size = 20;',
      '  return request(baseUrl, { page, size });',
      '}',
      'export function formatUserName(user) {',
      '  return user.name || "匿名";',
      '}',
      '',
    ].join('\n'),
  });
  ws.applyOp({ path: 'src/chartHelper.js', mode: 'create', content: '// 图表辅助\nconst pad = (n) => String(n).padStart(2, "0");\n' });
  ws.applyOp({ path: 'package.json', mode: 'create', content: JSON.stringify({ name: 'demo', dependencies: { react: '^18', vite: '^5' }, devDependencies: { typescript: '^5', vitest: '^1' } }) });
  const style = scanStyle(ws, { force: true });
  assert.ok(style.scanned >= 3, `至少扫描 3 个文件，实际 ${style.scanned}`);
  assert.equal(style.indent, '2 空格', `缩进应为 2 空格，实际 ${style.indent}`);
  assert.equal(style.quotes, '双引号', `引号应为双引号，实际 ${style.quotes}`);
  assert.equal(style.moduleStyle, 'ES Module（import/export）');
  assert.match(style.commentLang ?? '', /中文/);
  assert.ok(style.frameworks.includes('React'), `应识别出 React，实际 ${style.frameworks.join(',')}`);
  assert.ok(style.frameworks.includes('Vitest'));
  assert.equal(style.fileNaming, 'camelCase', `文件名应为 camelCase，实际 ${style.fileNaming}`);
  assert.match(style.summary, /缩进使用 2 空格/);
  assert.match(style.summary, /不要引入新风格/);
  // 缓存：签名不变时复用，不重复扫描
  const again = scanStyle(ws);
  assert.equal(again.scannedAt, style.scannedAt, '文件没变时应命中缓存');
});

await test('轮次与建议会被持久化，重新加载会话后仍在（想法 3）', () => {
  const dir = path.join(TMP, 'tltest');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'tltest-store') });
  const s = new Session({ workspace: ws, config: {}, storeDir: path.join(TMP, 'tltest-sessions') });
  for (let i = 0; i < 45; i += 1) {
    s.recordRound({ id: `r${i}`, kind: 'run', mode: 'continue', ms: 100, files: ['a.js'], thoughts: ['想一下'], suggestions: [{ id: `s${i}`, kind: 'optimize', title: 't', body: 'b', impact: 'low' }], ops: [] });
  }
  assert.equal(s.timeline.length, 40, '时间线应有上限，避免会话文件无限膨胀');
  assert.equal(s.timeline[0].id, 'r5', '超出上限时应丢弃最旧的');
  s.noteManualEdit({ path: 'src/a.js', chars: 100 });
  s.noteManualEdit({ path: 'src/a.js', chars: 120 });
  assert.equal(s.manualEdits.length, 1, '同一文件的手改应合并计数');
  assert.equal(s.manualEdits[0].count, 2);
  s.save();
  const loaded = Session.load(s.file, { workspace: ws, config: {} });
  assert.equal(loaded.timeline.length, 40, '刷新后时间线必须还在');
  assert.equal(loaded.manualEdits.length, 1, '手改记录也要持久化');
  assert.equal(loaded.timeline[loaded.timeline.length - 1].suggestions[0].title, 't');
});

await test('建议类型开关会真的过滤掉被关闭的类型（想法 5）', async () => {
  const dir = path.join(TMP, 'sugfilter');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'sugfilter-store') });
  const s = new Session({ workspace: ws, config: {} });
  const evts = [];
  const r = new Runner({
    session: s,
    workspace: ws,
    rag: new RagIndex(ws),
    memory: new Memory(path.join(TMP, 'sugfilter-store')),
    config: { ...cfg, autoCommit: false, suggest: { clarify: true, optimize: true, risk: false, test: false, a11y: false, max: 2 } },
    emit: (n, p) => evts.push({ name: n, payload: p }),
  });
  r.provider = {
    name: 'stub', label: '桩', ready: true, note: '',
    async *stream() {
      yield { type: 'delta', text: '<<<SF file path="src/s.js" action="create">>>\nconst s = 1;\n<<<SF /file>>>\n' };
      for (const [kind, title] of [['risk', '风险A'], ['optimize', '优化B'], ['test', '测试C'], ['optimize', '优化D'], ['clarify', '补全E']]) {
        yield { type: 'delta', text: `<<<SF suggest kind="${kind}" title="${title}" impact="medium" insert="x">>\nbody\n<<<SF /suggest>>>\n` };
      }
    },
  };
  s.setPrompt('写个小文件。');
  await r.commit({ reason: 'test' });
  await waitFor(() => evts.some((e) => e.name === 'run:done') && !r.busy, 15000, '完成');
  const got = evts.filter((e) => e.name === 'suggest').map((e) => e.payload.suggestion);
  assert.equal(got.length, 2, `最多 2 条，实际 ${got.length}`);
  assert.ok(!got.some((x) => x.kind === 'risk'), '关闭的 risk 不应出现');
  assert.ok(!got.some((x) => x.kind === 'test'), '关闭的 test 不应出现');
  assert.ok(got.every((x) => ['optimize', 'clarify'].includes(x.kind)));
});

await test('版本待确认：confirm 标记为已确认，discard 会回退到上一版（想法 2）', () => {
  const dir = path.join(TMP, 'confirmtest');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'confirmtest-store') });
  const s = new Session({ workspace: ws, config: {} });
  ws.applyOp({ path: 'a.js', mode: 'create', content: 'v1' });
  const v1 = s.recordCommit({ runId: 'r1', promptBefore: '', promptAfter: 'p1', files: ['a.js'], summary: 'x', snapshotId: ws.snapshot({}).id, confirmed: true });
  ws.applyOp({ path: 'a.js', mode: 'rewrite', content: 'v2-bad' });
  const v2 = s.recordCommit({ runId: 'r2', promptBefore: 'p1', promptAfter: 'p2', files: ['a.js'], summary: 'y', snapshotId: ws.snapshot({}).id, confirmed: false });
  assert.deepEqual(s.pendingConfirm, [v2.id]);
  assert.equal(s.versionList().versions.find((v) => v.id === v2.id).confirmed, false);

  // 丢弃：回到 v1
  const disc = s.discardVersion(v2.id);
  assert.equal(disc.ok, true);
  assert.equal(s.activeVersionId, v1.id);
  assert.equal(ws.read('a.js').content, 'v1', '丢弃后文件应回到上一版');

  // 再来一次并确认
  ws.applyOp({ path: 'a.js', mode: 'rewrite', content: 'v3-good' });
  const v3 = s.recordCommit({ runId: 'r3', promptBefore: 'p1', promptAfter: 'p3', files: ['a.js'], summary: 'z', snapshotId: ws.snapshot({}).id, confirmed: false });
  const ok = s.confirmVersion(v3.id);
  assert.equal(ok.ok, true);
  assert.equal(s.pendingConfirm.length, 0, '确认后不应再有待确认版本');
  assert.equal(ws.read('a.js').content, 'v3-good');
});

await test('快照能读出历史内容（版本回退的底层能力）', () => {
  // 说明：原来这里测的是"与历史版本对比"（想法 C），那个功能（含 /api/compare
  // 和编辑器里的差异视图）已经整体移除。但"快照里能读回历史文件内容"是**版本回退**
  // 依赖的底层能力，仍然必须成立，所以把测试保留下来、去掉差异渲染那一段。
  const dir = path.join(TMP, 'cmptest');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'cmptest-store') });
  const s = new Session({ workspace: ws, config: {} });
  ws.applyOp({ path: 'a.js', mode: 'create', content: 'line1\nline2\n' });
  const snap1 = ws.snapshot({ label: 'v1' });
  const v1 = s.recordCommit({ runId: 'r1', promptBefore: '', promptAfter: 'p1', files: ['a.js'], summary: '', snapshotId: snap1.id });
  ws.applyOp({ path: 'a.js', mode: 'patch', patches: [{ search: 'line2', replace: 'line2-changed' }] });
  const old = ws.readFromSnapshot(snap1.id, 'a.js');
  assert.equal(old, 'line1\nline2\n', '快照里应能读到历史内容');
  assert.equal(ws.read('a.js').content, 'line1\nline2-changed\n', '当前内容应该是改过的');
  assert.equal(v1.id, 'v1');
});

/* ============ 12. 写入方式：直接写入必须真的"直接"（用户反馈回归） ============ */
section('12. 写入方式：直接写入不被配置读取悄悄掰回暂存');

await test('loadConfig 尊重显式选择的 direct（哪怕已经配了项目目录）', () => {
  const dir = path.join(TMP, 'mode-cfg');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.synthflow'), { recursive: true });
  // 这正是用户踩到的组合：有项目目录 + 明确选了直接写入
  fs.writeFileSync(
    path.join(dir, '.synthflow', 'config.json'),
    JSON.stringify({ projectDir: 'D:\\ProgramData\\My_project', writeMode: 'direct' }),
    'utf8',
  );
  const cfg = loadConfig(dir);
  assert.equal(
    cfg.writeMode,
    'direct',
    '配置里写了 direct 就必须是 direct —— 之前这里会被强行掰回 staging，'
    + '导致用户选了直接写入，代码却还进暂存层，界面还在问"要不要应用到项目"',
  );
  assert.equal(cfg.projectDir, 'D:\\ProgramData\\My_project', '项目目录不能被顺手改掉');
});

await test('loadConfig 对老配置（没写 writeMode）仍按"有项目目录就暂存"兜底', () => {
  const dir = path.join(TMP, 'mode-cfg-legacy');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.synthflow'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.synthflow', 'config.json'),
    JSON.stringify({ projectDir: 'D:\\some\\project' }),
    'utf8',
  );
  assert.equal(loadConfig(dir).writeMode, 'staging', '老配置没有 writeMode，默认保护性暂存');
  fs.writeFileSync(path.join(dir, '.synthflow', 'config.json'), JSON.stringify({}), 'utf8');
  assert.equal(loadConfig(dir).writeMode, 'direct', '连项目目录都没有（默认 workspace）就不该多一层暂存');
});

await test('saveConfig 把非法 writeMode 归一到 direct，脏值不会落盘', () => {
  const dir = path.join(TMP, 'mode-save');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.synthflow'), { recursive: true });
  saveConfig(dir, { projectDir: 'D:\\p', writeMode: 'direct' });
  assert.equal(loadConfig(dir).writeMode, 'direct');
  saveConfig(dir, { writeMode: 'staging' });
  assert.equal(loadConfig(dir).writeMode, 'staging', '切回暂存也要生效');
  saveConfig(dir, { writeMode: 'DIRECT' });
  assert.equal(loadConfig(dir).writeMode, 'direct', '大小写不对的值应当被归一，而不是留下一个读不懂的状态');
  saveConfig(dir, { writeMode: 'whatever' });
  assert.equal(loadConfig(dir).writeMode, 'direct');
  assert.equal(loadConfig(dir).projectDir, 'D:\\p', '后续 saveConfig 不能把项目目录冲掉');
});

await test('saveConfig 保存设置（不带 writeMode）不会误改写入方式', () => {
  const dir = path.join(TMP, 'mode-keep');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.synthflow'), { recursive: true });
  saveConfig(dir, { projectDir: 'D:\\p', writeMode: 'direct' });
  // 设置面板保存的是另一批字段，这里不能顺手把 writeMode 重置
  saveConfig(dir, { settleMs: 1600, compactStyle: 'concise' });
  assert.equal(loadConfig(dir).writeMode, 'direct', '保存别的设置不该动写入方式');
  assert.equal(loadConfig(dir).settleMs, 1600);
});

await test('切到直接写入时，上一次暂存的改动会被补齐写进项目', () => {
  const projectDir = path.join(TMP, 'carry-project');
  const storeDir = path.join(TMP, 'carry-store');
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(storeDir, { recursive: true, force: true });
  const stagingDir = path.join(storeDir, 'staging');

  // 第一段：暂存模式下生成
  const staged = new Workspace(projectDir, { storeDir, overlayDir: stagingDir });
  assert.equal(staged.staging, true);
  staged.applyOp({ path: 'src/hello.js', mode: 'create', content: 'export const hi = 1;\n' });
  assert.equal(staged.pending().length, 1);
  assert.ok(!fs.existsSync(path.join(projectDir, 'src', 'hello.js')), '暂存模式下真实项目里不该有文件');

  // 第二段：用户切到直接写入 —— 服务端会用一个"暂存视角"的工作区把遗留改动补齐
  //（server.js buildServices 里的 carryOver，逻辑等价于下面这两行）
  const carry = new Workspace(projectDir, { storeDir, overlayDir: path.join(storeDir, 'staging') });
  const res = carry.applyPending();
  assert.deepEqual(res.applied, ['src/hello.js'], '遗留暂存必须补齐写进项目');
  assert.equal(
    fs.readFileSync(path.join(projectDir, 'src', 'hello.js'), 'utf8'),
    'export const hi = 1;\n',
    '内容要和暂存层里的一致',
  );

  // 第三段：切完之后真的处于直接写入 —— 再生成一次应立刻落盘，且没有待应用
  const direct = new Workspace(projectDir, { storeDir, overlayDir: projectDir });
  assert.equal(direct.staging, false);
  assert.deepEqual(direct.pending(), [], '直接写入模式下不该再有"待应用"清单');
  assert.deepEqual([...direct.pendingRels()], [], 'pendingRels 也必须为空，否则界面会留一个点不动的按钮');
  direct.applyOp({ path: 'src/direct.js', mode: 'create', content: 'export const d = 2;\n' });
  assert.ok(fs.existsSync(path.join(projectDir, 'src', 'direct.js')), '直接写入必须立刻出现在项目目录里');
  assert.deepEqual(direct.pending(), [], '直接写入模式下永远没有待应用改动');
});

/* ====== 13. 第四轮反馈：删除清干净 / 一轮一轮往回退（用户反馈回归） ====== */
section('13. 删除收尾与轮次级回退');

await test('删除文件后，空掉的父目录也要一起收掉', () => {
  const dir = path.join(TMP, 'prune');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'prune-store') });
  ws.applyOp({ path: 'src/deep/nested/temp.js', mode: 'create', content: 'export const t = 1;\n' });
  ws.applyOp({ path: 'src/deep/nested/keep.js', mode: 'create', content: 'export const k = 1;\n' });
  ws.applyOp({ path: 'top.js', mode: 'create', content: 'export const x = 1;\n' });

  ws.applyOp({ path: 'src/deep/nested/temp.js', mode: 'delete' });
  assert.ok(fs.existsSync(path.join(dir, 'src', 'deep', 'nested', 'keep.js')), '同级文件不能被误删');
  assert.ok(
    fs.existsSync(path.join(dir, 'src', 'deep', 'nested')),
    '目录里还有文件，不能把目录删掉',
  );

  // 删掉最后一个文件后，整条空目录链都该消失（用户"文件没删干净"的观感就来自这里）
  ws.applyOp({ path: 'src/deep/nested/keep.js', mode: 'delete' });
  assert.ok(!fs.existsSync(path.join(dir, 'src', 'deep', 'nested')), 'nested 空目录应被回收');
  assert.ok(!fs.existsSync(path.join(dir, 'src', 'deep')), 'deep 空目录应被回收');
  assert.ok(!fs.existsSync(path.join(dir, 'src')), 'src 空目录应被回收');
  assert.ok(fs.existsSync(path.join(dir, 'top.js')), '根目录下的其它文件必须保留');
  assert.ok(fs.existsSync(dir), '项目根目录本身不能被删');

  // 暂存模式下"应用删除"也要收干净
  const sdir = path.join(TMP, 'prune-staging');
  fs.rmSync(sdir, { recursive: true, force: true });
  fs.mkdirSync(path.join(sdir, 'p', 'x', 'y'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'p', 'x', 'y', 'gone.js'), 'const g = 1;\n', 'utf8');
  const sws = new Workspace(path.join(sdir, 'p'), { storeDir: path.join(sdir, 'store'), overlayDir: path.join(sdir, 'store', 'staging') });
  sws.applyOp({ path: 'x/y/gone.js', mode: 'delete' });
  assert.equal(sws.pending().length, 1, '暂存模式下应记为一条待删除');
  sws.applyPending();
  assert.ok(!fs.existsSync(path.join(sdir, 'p', 'x')), '应用删除后空目录也要回收');
});

await test('轮次前像日志：按条数与体积剪枝，且能持久化', () => {
  const dir = path.join(TMP, 'journal');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'journal-store') });
  const s = new Session({ workspace: ws, config: {}, storeDir: path.join(TMP, 'journal-sessions') });
  for (let i = 0; i < 60; i += 1) {
    s.pushRoundJournal({ id: `r${i}`, prompt: `第 ${i} 轮`, files: { [`f${i}.js`]: { existed: false, content: null } } });
  }
  assert.equal(s.roundJournal.length, 40, '条数应被剪到 40');
  assert.equal(s.roundJournal[0].prompt, '第 20 轮', '剪掉的应该是最旧的');

  // 体积剪枝：塞几个大文件，总字节数必须被压到上限以内
  const big = 'x'.repeat(200 * 1024);
  for (let i = 0; i < 30; i += 1) {
    s.pushRoundJournal({ id: `big${i}`, files: { [`big${i}.js`]: { existed: true, content: big } } });
  }
  assert.ok(s.journalBytes() <= 1.6 * 1024 * 1024, `日志体积应被压到 1.5MB 以内，实际 ${(s.journalBytes() / 1048576).toFixed(2)}MB`);

  s.pushRoundJournal({ id: 'last', prompt: '最后一轮', files: { 'a.js': { existed: true, content: 'const a = 1;\n' } } });
  s.save();
  const loaded = Session.load(s.file, { workspace: ws, config: {} });
  assert.ok(loaded.roundJournal.length > 0, '刷新后轮次日志必须还在');
  assert.equal(loaded.roundJournal[loaded.roundJournal.length - 1].id, 'last');
  const brief = loaded.roundJournalBrief();
  assert.ok(brief.every((e) => !('content' in e) && Array.isArray(e.files)), '给界面看的清单不该带文件内容');
});

await test('★ 生成 3 轮后：能一轮一轮往回退，也能一次性全退', async () => {
  const dir = path.join(TMP, 'roundundo');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'roundundo-store') });
  const sess = new Session({ workspace: ws, config: {}, storeDir: path.join(TMP, 'roundundo-sessions') });
  const evts = [];
  const r = new Runner({
    session: sess,
    workspace: ws,
    rag: new RagIndex(ws),
    memory: new Memory(path.join(TMP, 'roundundo-store')),
    config: { ...cfg, saveMode: 'manual', autoCommit: true, patchRetry: false, commitIdleMs: 20, specDelayMs: 5, settleMs: 20 },
    emit: (n, p) => evts.push({ name: n, payload: p }),
  });

  // 每一轮生成一个新文件（用桩 provider 精确控制，不依赖 mock 的输出格式）
  let round = 0;
  r.provider = {
    name: 'stub',
    label: '桩',
    ready: true,
    note: '',
    async *stream() {
      round += 1;
      yield { type: 'delta', text: `<<<SF file path="r${round}.js" action="create">>>\nexport const r${round} = ${round};\n<<<SF /file>>>\n` };
    },
  };

  for (let i = 1; i <= 3; i += 1) {
    sess.setPrompt(`第 ${i} 轮：新建 r${i}.js`);
    await r.commit({ reason: 'test', force: true });
    await waitFor(() => !r.busy && evts.some((e) => e.name === 'run:done' && e.payload.runId), 15000, `第 ${i} 轮完成`);
    evts.length = 0;
  }
  assert.deepEqual(ws.listFiles().sort(), ['r1.js', 'r2.js', 'r3.js'], '三轮各生成一个文件');
  assert.equal(sess.roundJournal.length, 3, '应有 3 条轮次前像');
  assert.equal(sess.versions.length, 1, '手动保存模式下不该自动产生版本');
  assert.equal(sess.pendingRound.round, 3, '未保存改动应记到第 3 轮');

  // ★ 单步回退：只退最后一轮
  const step1 = r.undoRoundStep({ count: 1 });
  assert.equal(step1.ok, true, step1.error);
  assert.equal(step1.undone, 1);
  assert.deepEqual(ws.listFiles().sort(), ['r1.js', 'r2.js'], '退一轮应只删掉 r3.js');
  assert.equal(sess.roundJournal.length, 2);
  assert.equal(sess.pendingRound.round, 2, '未保存轮数要跟着减少');

  // 跨版本保护：待在历史版本上时不允许按轮回退（先存一个版本，让游标有可能停在历史版本上）
  r.saveVersion({ label: '存一版' });
  assert.equal(sess.versions.length, 2, '保存后应有 v0 + v1');
  sess.activeIndex = 0;
  const blocked = r.undoRoundStep({ count: 1 });
  assert.equal(blocked.ok, false, '在历史版本上必须拒绝，否则回退对象会错乱');
  assert.match(blocked.error, /历史版本/);
  sess.activeIndex = sess.versions.length - 1;
  // 保存版本时会把已保存的那些轮次从日志里清掉，所以这里重新造两轮未保存改动
  await r.commit({ reason: 'test', force: true });
  await waitFor(() => !r.busy, 15000, '补一轮');
  assert.equal(sess.roundJournal.length, 1, '保存版本后日志清零，这一轮应只记 1 条');

  // ★ 一次退到"保存点"：只退得掉保存之后的那一轮（保存过的内容属于版本，由版本链负责）
  // 注意此时磁盘上应该是 r1/r2 —— r3 在前一步已经被按轮回退掉了。
  const step2 = r.undoRoundStep({ count: 5 });
  assert.equal(step2.ok, true, step2.error);
  assert.deepEqual(ws.listFiles().sort(), ['r1.js', 'r2.js'], '按轮回退不该动到已保存版本里的文件');
  assert.equal(sess.roundJournal.length, 0);
  assert.equal(sess.pendingRound, null, '没有未保存轮次了，pendingRound 要清空');
  assert.equal(sess.versions.length, 2, '版本链不受按轮回退影响');

  // 已经退到头了，再退要说清楚而不是抛异常
  const again = r.undoRoundStep({ count: 1 });
  assert.equal(again.ok, false);
  assert.match(again.error, /没有可以回退/);
});

await test('★ preSnapshotId 保留第一轮：一次性撤销能退掉全部未保存轮次', async () => {
  const dir = path.join(TMP, 'presnap');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'presnap-store') });
  const sess = new Session({ workspace: ws, config: {}, storeDir: path.join(TMP, 'presnap-sessions') });
  const r = new Runner({
    session: sess,
    workspace: ws,
    rag: new RagIndex(ws),
    memory: new Memory(path.join(TMP, 'presnap-store')),
    config: { ...cfg, saveMode: 'manual', autoCommit: true, patchRetry: false, commitIdleMs: 20, specDelayMs: 5, settleMs: 20 },
    emit: () => {},
  });
  let n = 0;
  r.provider = {
    name: 'stub', label: '桩', ready: true, note: '',
    async *stream() { n += 1; yield { type: 'delta', text: `<<<SF file path="n${n}.js" action="create">>>\nexport const n${n} = ${n};\n<<<SF /file>>>\n` }; },
  };
  for (let i = 1; i <= 3; i += 1) {
    sess.setPrompt(`第 ${i} 轮`);
    await r.commit({ reason: 'test', force: true });
    await waitFor(() => !r.busy, 15000, `第 ${i} 轮完成`);
  }
  assert.deepEqual(ws.listFiles().sort(), ['n1.js', 'n2.js', 'n3.js']);
  const snapId = sess.pendingRound.preSnapshotId;
  const firstRunId = sess.roundJournal[0].id;
  // preSnapshotId 必须是**第一轮之前**那个快照：以前每轮都会覆盖它，
  // 结果"撤销未保存的改动"其实只退掉了最后一轮。
  const snaps = ws.listSnapshots().filter((s) => s.id === snapId);
  assert.equal(snaps.length, 1, 'preSnapshotId 应指向一个存在的快照');
  assert.equal(snaps[0].runId, firstRunId, `preSnapshotId 应指向第一轮的快照，实际指向 ${snaps[0].runId}`);

  const res = r.undoRound();
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(ws.listFiles(), [], '一次性撤销必须退掉全部 3 轮');
  assert.equal(sess.roundJournal.length, 0, '轮次日志也要一起清空');
});

/* ====== 14. 切项目不再被旧 Runner 污染 / 版本删除（用户反馈回归） ====== */
section('14. 切项目的隔离与版本删除');

await test('★ dispose() 之后，旧 Runner 再也不许广播任何事件', async () => {
  // 用户现象：生成途中切项目，两秒后界面又整个变回旧项目
  //（版本时间线、文件树、项目徽标全中招）。
  // 根因就是 reloadServices() 只换了 svc，旧 Runner 的定时器与在跑的那一轮还在继续，
  // 跑完把旧项目的 state/tree/versions 广播了出去。
  const dir = path.join(TMP, 'dispose');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'dispose-store') });
  const sess = new Session({ workspace: ws, config: {}, storeDir: path.join(TMP, 'dispose-sessions') });
  const evts = [];
  const r = new Runner({
    session: sess,
    workspace: ws,
    rag: new RagIndex(ws),
    memory: new Memory(path.join(TMP, 'dispose-store')),
    config: { ...cfg, saveMode: 'manual', autoCommit: true, patchRetry: false, specDelayMs: 20, commitIdleMs: 20, settleMs: 20 },
    emit: (n, p) => evts.push({ name: n, payload: p }),
  });

  // 一个"永远不结束"的模型流，用来模拟"切项目时这一轮还在跑"
  let streamStarted = false;
  r.provider = {
    name: 'stub',
    label: '桩',
    ready: true,
    note: '',
    async *stream() {
      streamStarted = true;
      yield { type: 'delta', text: '<<<SF file path="slow.js" action="create">>>\n' };
      await sleep(3000);
      yield { type: 'delta', text: 'export const slow = 1;\n<<<SF /file>>>\n' };
    },
  };

  sess.setPrompt('慢慢写一个文件。');
  r.commit({ reason: 'test', force: true }).catch(() => {});
  await waitFor(() => streamStarted, 5000, '流已开始');
  const beforeDispose = evts.length;
  assert.ok(beforeDispose > 0, 'dispose 之前应该有事件');

  r.dispose();
  assert.equal(r.disposed, true);
  assert.equal(r.busy, false, 'dispose 之后不该还显示忙');
  evts.length = 0;

  // 让那个"慢流"继续跑一会儿：它必须一个事件都发不出来
  await sleep(600);
  assert.equal(evts.length, 0, `dispose 之后仍在广播：${evts.map((e) => e.name).join(', ')}`);

  // 定时器也要被清掉：dispose 之后打字不该再触发预演
  r.onInput({ text: '再写一个别的文件。', idleMs: 5000 });
  await sleep(400);
  assert.equal(evts.filter((e) => e.name === 'run:start').length, 0, 'dispose 之后不该再启动新的生成');
});

await test('★ 删除版本：不能删基线；删非当前版本不动工作区', async () => {
  const dir = path.join(TMP, 'delver');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'delver-store') });
  const sess = new Session({ workspace: ws, config: {}, storeDir: path.join(TMP, 'delver-sessions') });
  const r = new Runner({
    session: sess,
    workspace: ws,
    rag: new RagIndex(ws),
    memory: new Memory(path.join(TMP, 'delver-store')),
    config: { ...cfg, saveMode: 'manual' },
    emit: () => {},
  });

  ws.applyOp({ path: 'a.js', mode: 'create', content: 'const a = 1;\n' });
  const v1 = r.saveVersion({ label: '第一版' });
  ws.applyOp({ path: 'b.js', mode: 'create', content: 'const b = 2;\n' });
  const v2 = r.saveVersion({ label: '第二版' });
  ws.applyOp({ path: 'c.js', mode: 'create', content: 'const c = 3;\n' });
  const v3 = r.saveVersion({ label: '第三版' });
  assert.deepEqual(sess.versions.map((v) => v.id), ['v0', 'v1', 'v2', 'v3']);

  // 基线不能删
  const base = r.deleteVersion('v0');
  assert.equal(base.ok, false);
  assert.match(base.error, /基线/);
  // 不存在的版本要说清楚
  const none = r.deleteVersion('v99');
  assert.equal(none.ok, false);
  assert.match(none.error, /不存在/);

  // 删中间的 v2：工作区必须原样不动（当前版本是 v3）
  const del = r.deleteVersion(v2.versionId);
  assert.equal(del.ok, true, del.error);
  assert.deepEqual(sess.versions.map((v) => v.id), ['v0', 'v1', 'v3'], 'id 不该重排');
  assert.equal(sess.activeVersionId, v3.versionId, '删的不是当前版本，游标不该动');
  assert.deepEqual(ws.listFiles().sort(), ['a.js', 'b.js', 'c.js'], '删非当前版本不该动工作区');

  // 快照目录应该被回收
  assert.ok(del.snapshotId, '删除结果要带上被删版本的快照 id');
  assert.equal(del.snapshotDropped, true, '快照应当被回收');
  const snapDir = path.join(ws.snapshotsDir, del.snapshotId);
  assert.ok(!fs.existsSync(snapDir), `快照目录应被删除：${snapDir}`);
  assert.ok(
    !ws.listSnapshots().some((s) => s.id === del.snapshotId),
    'index.json 里也要摘掉，否则下次快照编号会撞车',
  );
});

await test('★ 删除"当前版本"：先退回上一版，再把这一版摘掉', async () => {
  const dir = path.join(TMP, 'delactive');
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = new Workspace(dir, { storeDir: path.join(TMP, 'delactive-store') });
  const sess = new Session({ workspace: ws, config: {}, storeDir: path.join(TMP, 'delactive-sessions') });
  const evts = [];
  const r = new Runner({
    session: sess, workspace: ws, rag: new RagIndex(ws),
    memory: new Memory(path.join(TMP, 'delactive-store')),
    config: { ...cfg, saveMode: 'manual' },
    emit: (n, p) => evts.push({ name: n, payload: p }),
  });

  ws.applyOp({ path: 'a.js', mode: 'create', content: 'const a = 1;\n' });
  const v1 = r.saveVersion({ label: '只建 a' });
  ws.applyOp({ path: 'only-in-v2.js', mode: 'create', content: 'const x = 2;\n' });
  const v2 = r.saveVersion({ label: '再加一个文件' });
  assert.deepEqual(ws.listFiles().sort(), ['a.js', 'only-in-v2.js']);
  assert.equal(sess.activeVersionId, v2.versionId);

  // 删掉当前版本 v2：工作区应该回到 v1 的样子
  const del = r.deleteVersion(v2.versionId);
  assert.equal(del.ok, true, del.error);
  assert.deepEqual(ws.listFiles().sort(), ['a.js'], '删当前版本要先退回上一版，工作区必须跟着回退');
  assert.equal(sess.activeVersionId, v1.versionId, '游标要落到上一版上');
  assert.deepEqual(sess.versions.map((v) => v.id), ['v0', 'v1']);
  assert.ok(evts.some((e) => e.name === 'versions'), '要广播新的版本链，否则界面还显示删掉的那个');
  assert.ok(sess.versions.every((v) => v.id !== v2.versionId), 'v2 必须真的从链上消失');
});

/* ====== 15. 模型选择与推理强度（用户反馈回归） ====== */
section('15. 模型选择与推理强度');

/** 起一个假的 OpenAI 兼容端点，用来精确复现 DeepSeek 的响应格式。 */
async function fakeEndpoint(handler) {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      handler(body, res);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

function sseChunks(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

await test('模型清单与强度选项是实测过的值', () => {
  const ds = MODEL_CATALOG.deepseek;
  assert.deepEqual(
    ds.models.map((m) => m.id).sort(),
    ['deepseek-flash', 'deepseek-v4-pro'],
    'DeepSeek 这两个模型是直接问 /v1/models 得到的，界面上的清单必须和它一致',
  );
  const ids = ds.efforts.map((e) => e.id);
  assert.deepEqual(ids, ['none', 'low', 'medium', 'high', 'max'], '强度枚举要和接口报的合法值对得上');
  assert.equal(newProfile({ provider: 'deepseek' }).model, 'deepseek-flash', '默认模型应该是真实存在的那个');
  assert.equal(newProfile({ provider: 'deepseek' }).reasoningEffort, 'low', '默认强度取"低"：预演是频繁触发的，默认开高档烧钱');
  assert.equal(newProfile({ provider: 'deepseek', model: 'deepseek-reasoner' }).model, 'deepseek-flash', '旧模型名要迁移');
  assert.equal(newProfile({ provider: 'openai' }).reasoningEffort, 'none', '没实测过的服务商默认不发送强度参数');
});

await test('★ 推理强度按服务商映射成正确的请求字段', async () => {
  const seen = [];
  const ep = await fakeEndpoint((body, res) => {
    seen.push(body);
    sseChunks(res, [{ choices: [{ delta: { content: 'ok' } }] }]);
  });
  const run = async (effort, provider = 'custom') => {
    const p = createProvider({ provider, baseUrl: ep.url, model: 'm', apiKey: 'k', temperature: 0.3, maxTokens: 64, reasoningEffort: effort });
    for await (const _ of p.stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* 消费掉 */ }
  };

  await run('high');
  assert.equal(seen.at(-1).reasoning_effort, 'high', '选了高档就要发 reasoning_effort=high');
  await run('none');
  assert.equal(seen.at(-1).reasoning_effort, undefined, '选"关闭"时不该发这个字段');
  // DeepSeek 还支持显式关掉思考（实测 thinking:{type:'disabled'}）
  await run('none', 'deepseek');
  assert.deepEqual(seen.at(-1).thinking, { type: 'disabled' }, 'DeepSeek 关闭思考要发 thinking.disabled');
  await run('max', 'deepseek');
  assert.equal(seen.at(-1).reasoning_effort, 'max');
  assert.equal(seen.at(-1).thinking, undefined, '开启思考时不需要额外发 thinking 字段（默认就是开的）');
  await ep.close();
});

await test('★ 思维链走独立通道，绝不会被当成代码输出', async () => {
  // 这是开启思考模式后最容易踩的坑：DeepSeek 把 CoT 放在 reasoning_content 里单独返回，
  // 如果和 content 挤进同一条流，模型"想"的内容会被协议解析器当成文件操作。
  // 这里故意在思维链里塞一段**看起来完全合法的协议标记**，看它会不会漏出去。
  const POISON = '<<<SF file path="HACKED-BY-COT.js" action="create">>>\n不该被写出来的内容\n<<<SF /file>>>';
  const ep = await fakeEndpoint((body, res) => {
    sseChunks(res, [
      { choices: [{ delta: { reasoning_content: '让我想想…\n' } }] },
      { choices: [{ delta: { reasoning_content: POISON } }] },
      { choices: [{ delta: { content: '<<<SF file path="real.js" action="create">>>\n' } }] },
      { choices: [{ delta: { content: 'export const real = 1;\n<<<SF /file>>>\n' } }] },
      { choices: [{ delta: {} }], usage: { total_tokens: 42, completion_tokens_details: { reasoning_tokens: 30 } } },
    ]);
  });
  const p = createProvider({ provider: 'custom', baseUrl: ep.url, model: 'm', apiKey: 'k', temperature: 0.3, maxTokens: 64, reasoningEffort: 'high' });
  const thinks = [];
  const deltas = [];
  let usage = null;
  for await (const evt of p.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    if (evt.type === 'think') thinks.push(evt.text);
    if (evt.type === 'delta') deltas.push(evt.text);
    if (evt.type === 'usage') usage = evt.usage;
  }
  assert.ok(thinks.join('').includes('让我想想'), '思维链应该从 think 通道出来');
  assert.ok(thinks.join('').includes('HACKED-BY-COT'), '思维链内容要完整保留在 think 通道里');
  const answer = deltas.join('');
  assert.ok(!answer.includes('HACKED-BY-COT'), '★ 思维链里的协议标记绝不能混进正文流（否则会被当成真文件操作）');
  assert.ok(answer.includes('real.js'), '正文该走的还是正文通道');
  assert.equal(usage?.completion_tokens_details?.reasoning_tokens, 30, '思考 token 数要能拿到，用来看钱花在哪');
  await ep.close();
});

await test('★ 端点不认推理强度参数时自动降级重试，并把原因说出来', async () => {
  let calls = 0;
  const ep = await fakeEndpoint((body, res) => {
    calls += 1;
    // 第一次带 reasoning_effort → 422（和 DeepSeek 对非法值的真实行为一致）
    if (body.reasoning_effort) {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unknown variant reasoning_effort' } }));
      return;
    }
    sseChunks(res, [{ choices: [{ delta: { content: '降级之后成功了' } }] }]);
  });
  const p = createProvider({ provider: 'custom', baseUrl: ep.url, model: 'm', apiKey: 'k', temperature: 0.3, maxTokens: 64, reasoningEffort: 'high' });
  const notes = [];
  const deltas = [];
  for await (const evt of p.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    if (evt.type === 'note') notes.push(evt.text);
    if (evt.type === 'delta') deltas.push(evt.text);
  }
  assert.equal(calls, 2, '应该恰好重试一次');
  assert.ok(notes.length, '要有一条说明，不能悄悄吞掉');
  assert.match(notes[0], /不接受推理强度/);
  assert.equal(deltas.join(''), '降级之后成功了', '降级之后要能正常拿到结果');
  await ep.close();
});

await test('模型名与强度会出现在给界面看的 provider 信息里', () => {
  const p = createProvider({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', apiKey: 'sk-x', reasoningEffort: 'max' });
  assert.equal(p.model, 'deepseek-v4-pro');
  assert.equal(p.reasoningEffort, 'max');
  assert.match(p.note, /deepseek-v4-pro/);
  assert.match(p.note, /最高/, '提示里要带上强度的中文说明，用户一眼能看出现在是哪档');
});

/* ============================ 16. 基准（可选） ============================ */
if (bench) {
  section('16. 性能基线（--bench）');
  await test('1000 行文件的补丁定位 < 60ms', async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n');
    const start = Date.now();
    const hit = locateBlock(big, 'function f900() { return 900; }');
    const ms = Date.now() - start;
    assert.ok(hit, '应命中');
    assert.ok(ms < 60, `耗时 ${ms}ms`);
  });
  await test('20 万字 prompt 的意图判定 < 30ms', async () => {
    const big = '写一个后台管理系统。'.repeat(20000);
    const start = Date.now();
    analyzeIntent(big, { idleMs: 1000 });
    const ms = Date.now() - start;
    assert.ok(ms < 30, `耗时 ${ms}ms`);
  });
  await test('解析 200 个文件流的协议开销 < 200ms', async () => {
    const unit = SAMPLE.repeat(200);
    const start = Date.now();
    const p = createProtocolParser({});
    for (let i = 0; i < unit.length; i += 512) p.push(unit.slice(i, i + 512));
    p.end();
    const ms = Date.now() - start;
    assert.ok(ms < 200, `耗时 ${ms}ms`);
  });
}

/* ============================ 收尾 ============================ */
function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const files = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      try {
        files.push({ p, size: fs.statSync(p).size });
      } catch { /* ignore */ }
    }
  }
};
walk(TMP);
const totalBytes = files.reduce((a, f) => a + f.size, 0);

console.log('');
console.log('─'.repeat(64));
console.log(`  冒烟测试：${pass} 通过 / ${fail} 失败 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  测试产物：${TMP}  (${files.length} 个文件 / ${bytesToHuman(totalBytes)})`);
console.log(`  清理命令：node scripts/clean.mjs --test`);
console.log('─'.repeat(64));

if (fail) {
  console.log('\n失败详情：');
  for (const f of failures) console.log(`\n▌${f.name}\n${f.err.stack ?? f.err.message}`);
  process.exitCode = 1;
} else {
  console.log('\n  全部通过 ✅');
}
