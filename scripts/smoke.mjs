// SynthFlow 冒烟测试：不依赖浏览器、不依赖网络、不消耗任何模型额度。
//   node scripts/smoke.mjs             跑全部用例
//   node scripts/smoke.mjs --bench     额外跑一次吞吐基线
// 所有测试产物都写在 <项目>/.synthflow/testrun/ 下，跑完自动清理。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bytesToHuman, changedSpan, diffLines, ensureDir, sha1, similarity } from '../src/util.js';
import { createProtocolParser, parseFilePayload, stripFence } from '../src/protocol.js';
import { Workspace, locateBlock } from '../src/workspace.js';
import { Session, analyzeIntent, decidePromptChange } from '../src/session.js';
import { Memory } from '../src/memory.js';
import { RagIndex } from '../src/rag.js';
import { Runner, normalizeTiming } from '../src/runner.js';
import { createServer } from '../src/server.js';

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

  const res = sess.rollback();
  assert.equal(res.ok, true);
  assert.equal(ws2.read('src/x.js').content, 'v1', '文件应回到上一版本');
  assert.equal(ws2.exists('src/extra.js'), false, '上一轮新建的文件应被移除');
  assert.equal(sess.prompt, promptBefore, '提示词应回到这句话没输入时的状态');
  assert.equal(sess.versions.length, 2);
  assert.equal(sess.stats.rollbacks, 1);
});

await test('回退后再次提交可正常推进版本号', () => {
  const snap = ws2.snapshot({ label: 'v1-again' });
  const v = sess.recordCommit({ runId: 'r3', promptBefore: sess.prompt, promptAfter: sess.prompt, files: [], summary: '再来一次', snapshotId: snap.id });
  assert.equal(v.id, `v${sess.versions.length - 1}`);
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
  assert.equal(t.specDelayMs, 320);
  assert.equal(t.commitIdleMs, 900);
  assert.equal(t.settleMs, 1600);
  assert.equal(t.intentThreshold, 0.6);
  const bad = normalizeTiming({ specDelayMs: null, commitIdleMs: 'abc', settleMs: undefined, intentThreshold: 99, autoCommit: undefined });
  assert.equal(bad.specDelayMs, 320, 'null 必须回落到默认值');
  assert.equal(bad.commitIdleMs, 900, 'NaN 必须回落到默认值');
  assert.equal(bad.settleMs, 1600, 'undefined 必须回落到默认值');
  assert.equal(bad.intentThreshold, 0.6, '越界阈值必须回落到默认值');
  assert.equal(bad.autoCommit, true);
  // 反例：如果这里拿到 undefined，setTimeout(fn, undefined) 会在 0ms 立即执行
  assert.ok(Number.isFinite(normalizeTiming({}).settleMs));
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
  const mainBeforeRollback = runWs.read('src/main.js').content;
  assert.match(mainBeforeRollback, /增量新增/);
  const res = runner.rollback();
  assert.equal(res.ok, true);
  const restored = runWs.read('src/main.js').content;
  assert.doesNotMatch(restored, /增量新增/, '增量内容应被回退掉');
  assert.equal(runSess.prompt, '帮我写一个后台管理系统，包含用户列表、搜索和分页。', '提示词也应回退');
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
  app = createServer({ projectRoot: HTTP_ROOT, port: 0, log: () => {} });
  const addr = await app.listen();
  port = addr.port;
  assert.ok(port > 0);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.workspace, path.join(HTTP_ROOT, 'workspace'));
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
  assert.ok(intents.length >= 3);
  const last = intents[intents.length - 1];
  assert.ok(last.intent.score >= 0.6, `最后一条应判为完整，实际 ${last.intent.score}`);
  assert.equal(last.intent.complete, true);
  assert.ok(last.intent.reasons.length > 0);
  assert.ok(['regenerate', 'continue', 'incremental', 'noop'].includes(last.decision.mode), `mode=${last.decision.mode}`);
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

await test('HTTP 回退：文件与提示词一起回滚', async () => {
  const before = await fetch(`http://127.0.0.1:${port}/api/versions`).then((r) => r.json());
  const rollback = await fetch(`http://127.0.0.1:${port}/api/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }).then((r) => r.json());
  assert.equal(rollback.ok, true);
  const after = await fetch(`http://127.0.0.1:${port}/api/versions`).then((r) => r.json());
  assert.ok(after.versions.length < before.versions.length);
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
section('10. 前端契约（防"打开就是白屏"）');

const PUBLIC = path.join(ROOT, 'public');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

await test('app.js 里 $(\'#id\') 引用的每个 id 都在 index.html 中存在', () => {
  const used = new Set([...appJs.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
  const defined = new Set([...indexHtml.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `index.html 缺少这些 id: ${missing.join(', ')}`);
  assert.ok(used.size >= 20, `只检查到 ${used.size} 个 id，正则可能失效`);
});

await test('app.js 的 el.* 字段都在 el 对象里声明过', () => {
  const block = appJs.match(/const el = \{([\s\S]*?)\n\};/);
  assert.ok(block, '找不到 el 对象声明');
  const declared = new Set([...block[1].matchAll(/(\w+):/g)].map((m) => m[1]));
  const used = new Set([...appJs.matchAll(/\bel\.(\w+)\b/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !declared.has(k));
  assert.deepEqual(missing, [], `el 对象缺少字段: ${missing.join(', ')}`);
});

await test('styles.css 覆盖了 synctflow 运行时的关键 class', () => {
  const critical = [
    '.hidden', '#app', '.topbar', '.body', '.sidebar', '.editor', '.stream', '.composer',
    '.tree-dir', '.tree-file', '.tree-children', '.dot', '.tab', '.tab.live', '.tabs',
    '.timeline-item', '.stream-run', '.run-head', '.think', '.think-body',
    '.suggestion', '.suggestion-title', '.suggestion-body', '.suggestion-actions', '.suggestion-insert',
    '.kind-clarify', '.kind-optimize', '.kind-risk', '.opblock', '.opblock-head', '.opblock-body',
    '.intent-bar', '.intent-fill', '.chip', '.chips', '.toast', '.modal', '.form-grid',
    '.d-ins', '.d-del', '.tok-key', '.tok-str', '.tok-com', '.badge', '.btn', '.muted', '.empty',
  ];
  const missing = critical.filter((sel) => {
    const base = sel.split(' ').pop();
    return !new RegExp(`\\${base[0]}${base.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(stylesCss);
  });
  assert.deepEqual(missing, [], `styles.css 缺少: ${missing.join(', ')}`);
  assert.match(stylesCss, /\.hidden\s*\{[^}]*display:\s*none\s*!important/, '.hidden 必须是 display:none !important');
});

await test('index.html 引入的资源都能被服务端路由到', () => {
  const hrefs = [...indexHtml.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 2, 'index.html 应该引用 styles.css 与 app.js');
  for (const href of hrefs) {
    const file = path.join(PUBLIC, href.replace(/^\/+/, ''));
    assert.ok(fs.existsSync(file), `静态资源缺失: ${href}`);
  }
});

await test('app.js 是纯浏览器可用语法（无 import / require / TS 注解）', () => {
  assert.doesNotMatch(appJs, /^\s*import\s/m, 'app.js 不应有 import 语句');
  assert.doesNotMatch(appJs, /\brequire\(/, 'app.js 不应有 require');
  assert.doesNotMatch(appJs, /:\s*(string|number|boolean|any)\b/, 'app.js 不应有 TypeScript 注解');
});

await test('语法高亮器（直接跑 app.js 里的真实实现）', () => {
  // 把 app.js 中自包含的高亮相关源码切出来，在 Node 里执行，验证的是真正会上线的代码。
  const start = appJs.indexOf('const esc = ');
  const end = appJs.indexOf('/* ============================ 渲染：文件树');
  assert.ok(start > 0 && end > start, '找不到高亮器源码区间');
  const src = appJs.slice(start, end);
  const { highlight } = new Function(`${src}\nreturn { highlight };`)();

  const js = highlight('// 注释\nconst a = 1;\nfunction f() { return "x"; }', 'javascript');
  assert.match(js, /tok-com/, '注释应高亮');
  assert.match(js, /tok-key/, '关键字应高亮');
  assert.match(js, /tok-num/, '数字应高亮');
  assert.match(js, /tok-str/, '字符串应高亮');

  const css = highlight(':root { --bg: #0f1115; }', 'css');
  assert.match(css, /tok-key|tok-num/, 'CSS 变量/颜色应高亮');

  const md = highlight('# 标题\n- 列表\n`code`', 'markdown');
  assert.match(md, /tok-/, 'Markdown 应有高亮输出');

  // 安全：高亮前必须转义，否则生成出来的代码会把工作台自己 XSS 掉
  const dangerous = highlight('const s = "<img src=x onerror=alert(1)>";', 'javascript');
  assert.doesNotMatch(dangerous, /<img/, '必须转义 HTML');
  assert.match(dangerous, /&lt;img/, '应当输出转义后的实体');

  // 中文与超长输入不能崩
  const cn = highlight('const 标题 = "中文注释测试";'.repeat(400), 'javascript');
  assert.ok(cn.length > 1000);
  assert.match(highlight('', 'text'), /^$/);
  assert.match(highlight('普通文本', 'text'), /普通文本/);
});

/* ============================ 11. 基准（可选） ============================ */
if (bench) {
  section('11. 性能基线（--bench）');
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
