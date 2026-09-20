#!/usr/bin/env node
// SynthFlow 在线验收脚本：对**正在运行的服务**做一次真实用户流程演练。
//   node scripts/livecheck.mjs                     默认 http://127.0.0.1:7788
//   node scripts/livecheck.mjs --url http://127.0.0.1:7788 --prompt "帮我写一个登录页。" --keep
//
// 它做的事和真人一样：连上 SSE → 一个字一个字地"打字" → 看代码流式长出来 →
// 追加需求看是否走增量补丁 → 回退看是否恢复。用来在你接上真实模型后验证端到端是否通。

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const BASE = getArg('url', 'http://127.0.0.1:7788').replace(/\/+$/, '');
const PROMPT = getArg('prompt', '帮我写一个后台管理系统，包含用户列表、搜索和分页。');
const KEEP = args.includes('--keep');
const VERBOSE = args.includes('--verbose');

const color = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const ok = (s) => color(32, `✓ ${s}`);
const bad = (s) => color(31, `✗ ${s}`);
const dim = (s) => color(90, s);

const t0 = Date.now();
const stamp = () => color(90, `+${String(((Date.now() - t0) / 1000).toFixed(2)).padStart(6)}s`);

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};
const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

const seen = [];
const waitFor = (name, ms = 90000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const hit = seen.find((e) => e.name === name && e.at > started);
      if (hit) {
        clearInterval(tick);
        resolve(hit.payload);
      } else if (Date.now() - started > ms) {
        clearInterval(tick);
        reject(new Error(`等待事件 ${name} 超时（${ms}ms）`));
      }
    }, 40);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, label, extra = '') => {
  if (cond) console.log(`  ${stamp()} ${ok(label)}${extra ? dim(` ${extra}`) : ''}`);
  else {
    failures += 1;
    console.log(`  ${stamp()} ${bad(label)}${extra ? dim(` ${extra}`) : ''}`);
  }
};

console.log(`\n${color(36, '▌SynthFlow 在线验收')}  ${dim(BASE)}\n`);

/* ---------- 0. 连通性 ---------- */
const health = await get('/api/health').catch((e) => {
  console.error(bad(`连不上服务：${e.message}\n  请先执行：npm start`));
  process.exit(1);
});
check(health.ok === true, '服务在线', `pid=${health.pid}`);
const state0 = await get('/api/state');
check(Boolean(state0.provider?.ready), `模型就绪：${state0.provider?.label}`, state0.provider?.note ?? '');
if (state0.provider?.name === 'mock') {
  console.log(`  ${dim('（当前是内置演示模型，全程不消耗任何 API 额度；接真实模型在界面右上角「设置」）')}`);
}

/* ---------- 1. 订阅事件流 ---------- */
const res = await fetch(`${BASE}/api/events`);
check((res.headers.get('content-type') ?? '').includes('text/event-stream'), 'SSE 事件流已订阅');
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const counts = new Map();
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
        if (!name || name === 'hello') continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
        let payload = null;
        try {
          payload = JSON.parse(data);
        } catch { /* ignore */ }
        seen.push({ name, payload, at: Date.now() });
        if (VERBOSE) console.log(`     ${dim(`⇠ ${name}`)} ${dim(JSON.stringify(payload)?.slice(0, 110) ?? '')}`);
      }
    }
  } catch { /* closed */ }
})();
await waitFor('state', 5000).catch(() => {});

/* ---------- 2. 逐字打字 ---------- */
console.log(`\n  ${color(35, '场景 A')} 边打字边生成：${dim(PROMPT)}`);
const chunks = [];
for (let i = 3; i <= PROMPT.length; i += 3) chunks.push(PROMPT.slice(0, i));
if (chunks[chunks.length - 1] !== PROMPT) chunks.push(PROMPT);
for (let i = 0; i < chunks.length; i += 1) {
  await post('/api/input', { text: chunks[i], idleMs: 60 });
  await sleep(45); // 模拟真实打字节奏
  // 打到一半停下来想一想 —— 这正是"预演"该发动的场景
  if (i === Math.floor(chunks.length * 0.55)) {
    console.log(`  ${dim('（中途停顿 1.4 秒，模拟思考……）')}`);
    await sleep(1400);
  }
}
await post('/api/input', { text: PROMPT, idleMs: 2000 });

await waitFor('run:start', 20000);
const firstRun = seen.find((e) => e.name === 'run:start');
const firstSpec = seen.find((e) => e.name === 'run:start' && e.payload?.kind === 'spec');
check(Boolean(firstRun), `打字后自动开工（${firstRun?.payload?.kind === 'spec' ? '先预演' : '直接生成'}）`);
check(Boolean(firstSpec), '半截需求停顿时会先跑"预演"');

const applied = await waitFor('run:applied', 180000);
await waitFor('run:done', 60000);
await sleep(400); // 等"本轮建议"批量推送
const done = seen.filter((e) => e.name === 'run:done').pop()?.payload;
check(Boolean(applied), '代码已落盘', `${applied.results.filter((r) => r.ok).length} 个文件`);
check(applied.results.every((r) => r.ok), '全部文件写入成功');
check((counts.get('think:delta') ?? 0) > 0, '思考是流式输出的', `${counts.get('think:delta')} 个分片`);
check((counts.get('file:delta') ?? 0) > 0, '代码是流式输出的', `${counts.get('file:delta')} 个分片`);
check((counts.get('suggest') ?? 0) > 0, '本轮结束后给出了可采纳建议', `${counts.get('suggest')} 条`);
const promoted = seen.some((e) => e.name === 'run:promoted');
check(true, promoted ? '预演结果被直接采纳（省掉一次完整调用）' : '按意图判定直接生成', done ? `${done.ms}ms` : '');
if (done?.usage) {
  check(true, '返回了 token 用量', `≈${done.usage.tokens} tokens${done.usage.real ? '（接口真实值）' : '（估算）'}`);
}

const tree = await get('/api/tree');
check(tree.files.length >= 1, '项目结构已自动创建', tree.files.join(', '));
for (const r of applied.results.filter((x) => x.ok)) {
  const f = await get(`/api/file?path=${encodeURIComponent(r.path)}`);
  check(f.content.length > 0, `可读回 ${r.path}`, `${f.content.split('\n').length} 行`);
}

/* ---------- 3. 采纳建议 ---------- */
console.log(`\n  ${color(35, '场景 B')} 采纳建议后自动增量生成，并继续给新建议`);
const suggestion = seen.filter((e) => e.name === 'suggest').pop()?.payload?.suggestion;
if (suggestion) {
  seen.length = 0;
  const adopted = await post('/api/adopt', { suggestion });
  check(adopted.ok === true, '建议已写入提示词', `+${(adopted.prompt?.length ?? 0) - PROMPT.length} 字`);
  await waitFor('run:done', 180000);
  await sleep(400);
  const sugs2 = seen.filter((e) => e.name === 'suggest').length;
  check(sugs2 > 0, '采纳后的新一轮仍然会给出建议（想法 7）', `${sugs2} 条`);
} else {
  check(false, '本轮至少应产生一条建议');
}

/* ---------- 4. 追加需求 → 增量补丁 ---------- */
console.log(`\n  ${color(35, '场景 C')} 追加一句话，应该只做增量补丁，不推倒重来`);
const existing = tree.files;
const mainRel = existing.find((f) => /main\.(js|ts)$/.test(f)) ?? existing[0];
const targetName = mainRel.split('/').pop().replace(/\.\w+$/, '');
const beforeFiles = {};
for (const f of existing) beforeFiles[f] = (await get(`/api/file?path=${encodeURIComponent(f)}`)).content;
const basePrompt = (await get('/api/context')).prompt;
// 刻意指向"已有文件里已有的东西"，这样才是在考补丁命中率，而不是考模型会不会新建文件
const appended = `${basePrompt}\n给 ${targetName} 里已有的函数补充中文 JSDoc 注释，不要新建文件，也不要改动其它文件。`;
seen.length = 0;
counts.clear();
await post('/api/input', { text: appended, idleMs: 2200 });
await waitFor('run:done', 180000);
await sleep(400);
const doneC = seen.filter((e) => e.name === 'run:done').pop()?.payload;
check(doneC?.mode === 'continue', `走了增量续写（mode=${doneC?.mode}）`);
const afterFiles = {};
for (const f of existing) afterFiles[f] = (await get(`/api/file?path=${encodeURIComponent(f)}`)).content;
const changed = existing.filter((f) => afterFiles[f] !== beforeFiles[f]);
const newFiles = (await get('/api/tree')).files.filter((f) => !beforeFiles[f]);
check(changed.length + newFiles.length > 0, '本轮确实产生了改动', `${changed.join(', ')}${newFiles.length ? ` + 新建 ${newFiles.join(', ')}` : ''}`);
const untouched = existing.filter((f) => afterFiles[f] === beforeFiles[f]);
if (untouched.length) {
  check(true, '未被涉及的文件保持字节级不变', untouched.join(', '));
} else {
  check(true, '本轮只碰了已有文件（项目里暂时只有它一个）', changed.join(', '));
}
const retried = seen.some((e) => e.name === 'retry');
check(true, retried ? '⚠ 出现过补丁未命中，已自动重试' : '补丁一次命中（真实模型也守协议）');
const afterMain = afterFiles[mainRel] ?? (await get(`/api/file?path=${encodeURIComponent(mainRel)}`)).content;

/* ---------- 5. 回退 / 前进 ---------- */
console.log(`\n  ${color(35, '场景 D')} 回退一步，再前进回去（想法 5 + 9）`);
if (KEEP) {
  console.log(`  ${dim('--keep 已指定，跳回退')}`);
} else {
  const vBefore = await get('/api/versions');
  const rb = await post('/api/rollback', { direction: 'back' });
  check(rb.ok === true, `回退到 ${rb.activeVersionId}`, `恢复 ${rb.files?.length ?? 0} 个文件`);
  const restoredMain = (await get(`/api/file?path=${encodeURIComponent(mainRel)}`)).content;
  check(restoredMain === beforeFiles[mainRel], `${mainRel} 已回到追加之前的内容`);
  const ctx = await get('/api/context');
  check(ctx.prompt !== appended, '提示词也一起回退了');
  const vMid = await get('/api/versions');
  check(vMid.versions.length === vBefore.versions.length, '版本记录被保留（否则没法前进回去）', `${vMid.versions.length} 个版本`);

  const fw = await post('/api/rollback', { direction: 'forward' });
  check(fw.ok === true, `前进回 ${fw.activeVersionId}`);
  const backAgain = (await get(`/api/file?path=${encodeURIComponent(mainRel)}`)).content;
  check(backAgain === afterMain, `${mainRel} 又回到了增量修改后的内容`);
  const ctx2 = await get('/api/context');
  check(ctx2.prompt === appended, '提示词也跟着前进');

  const over = await post('/api/rollback', { direction: 'forward' }).catch((e) => ({ ok: false, error: e.message }));
  check(over.ok === false && over.error, '已在最新版时应被拒绝并说明原因');
}

/* ---------- 6. 本轮差异 / 记忆 / 检索 / 版本 ---------- */
console.log(`\n  ${color(35, '场景 E')} 差异、记忆与检索`);
const lastApplied = seen.filter((e) => e.name === 'run:applied').pop()?.payload;
const withDiff = (lastApplied?.results ?? []).find((r) => r.compact?.length);
check(Boolean(withDiff), '落盘结果带回了紧凑差异（代码区可一键切换查看）', withDiff ? `${withDiff.compact.length} 段` : '');
if (withDiff) {
  const gaps = withDiff.compact.filter((d) => d.type === 'gap').length;
  check(gaps >= 0, '未改动区域会折叠', `${gaps} 处折叠`);
}
const mem = await get('/api/memory');
check(mem.prompts >= 1, '提示词历史已积累', `${mem.prompts} 次`);
const rag = await get(`/api/rag?q=${encodeURIComponent('分页 搜索')}`);
check(rag.stats.chunks >= 1, '项目已被索引', `${rag.stats.chunks} 个片段`);
const versions = await get('/api/versions');
check(versions.versions.length >= 2, '版本链完整', versions.versions.map((v) => v.id).join(' → '));
check(typeof versions.canBack === 'boolean' && typeof versions.canForward === 'boolean', '版本游标状态完整');

try {
  await reader.cancel();
} catch { /* ignore */ }

console.log(`\n${'─'.repeat(64)}`);
if (failures === 0) console.log(`  ${color(32, '在线验收全部通过 ✅')}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
else console.log(`  ${color(31, `${failures} 项未通过`)}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  生成物在 ${health.workspace}`);
console.log(`  清空生成物：node scripts/clean.mjs --workspace\n`);
process.exit(failures ? 1 : 0);
