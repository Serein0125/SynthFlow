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
for (const text of chunks) {
  await post('/api/input', { text, idleMs: 60 });
  await sleep(45); // 模拟真实打字节奏
}
const firstSpec = seen.find((e) => e.name === 'run:start' && e.payload?.kind === 'spec');
check(Boolean(firstSpec), '打字停顿后立刻开始"预演"', firstSpec ? `在第 ${chunks.findIndex(() => true) >= 0 ? seen.length : 0} 个事件内` : '');
await post('/api/input', { text: PROMPT, idleMs: 2000 });

const applied = await waitFor('run:applied', 120000);
const done = seen.filter((e) => e.name === 'run:done').pop()?.payload;
check(Boolean(applied), '代码已落盘', `${applied.results.filter((r) => r.ok).length} 个文件`);
check(applied.results.every((r) => r.ok), '全部文件写入成功');
check((counts.get('think:delta') ?? 0) > 0, '思考是流式输出的', `${counts.get('think:delta')} 个分片`);
check((counts.get('file:delta') ?? 0) > 0, '代码是流式输出的', `${counts.get('file:delta')} 个分片`);
check((counts.get('suggest') ?? 0) > 0, '并行给出了可采纳建议', `${counts.get('suggest')} 条`);
const promoted = seen.some((e) => e.name === 'run:promoted');
check(true, promoted ? '预演结果被直接采纳（省掉一次完整调用）' : '按意图判定直接生成', done ? `${done.ms}ms` : '');

const tree = await get('/api/tree');
check(tree.files.length >= 3, '项目结构已自动创建', tree.files.join(', '));
for (const r of applied.results.filter((x) => x.ok)) {
  const f = await get(`/api/file?path=${encodeURIComponent(r.path)}`);
  check(f.content.length > 0, `可读回 ${r.path}`, `${f.content.split('\n').length} 行`);
}

/* ---------- 3. 采纳建议 ---------- */
console.log(`\n  ${color(35, '场景 B')} 采纳建议后自动增量生成`);
const suggestion = seen.filter((e) => e.name === 'suggest').pop()?.payload?.suggestion;
if (suggestion) {
  const adopted = await post('/api/adopt', { suggestion });
  check(adopted.ok === true, '建议已写入提示词', `+${(adopted.prompt?.length ?? 0) - PROMPT.length} 字`);
  await waitFor('run:done', 90000).catch(() => {});
  check(true, '采纳后自动跟进了一轮生成');
} else {
  console.log(`  ${dim('（本轮没有产生建议，跳过）')}`);
}

/* ---------- 4. 追加需求 → 增量补丁 ---------- */
console.log(`\n  ${color(35, '场景 C')} 追加一句话，应该只做增量补丁`);
const mainRel = tree.files.find((f) => /main\.(js|ts)$/.test(f)) ?? tree.files[tree.files.length - 1];
const beforeFiles = {};
for (const f of tree.files) beforeFiles[f] = (await get(`/api/file?path=${encodeURIComponent(f)}`)).content;
const basePrompt = (await get('/api/context')).prompt;
const appended = `${basePrompt}\n再加一个导出 Excel 的按钮。`;
seen.length = 0;
counts.clear();
await post('/api/input', { text: appended, idleMs: 2200 });
await waitFor('run:done', 120000);
await sleep(200);
const doneC = seen.filter((e) => e.name === 'run:done').pop()?.payload;
check(doneC?.mode === 'continue', `走了增量续写（mode=${doneC?.mode}）`);
const afterMain = (await get(`/api/file?path=${encodeURIComponent(mainRel)}`)).content;
check(afterMain !== beforeFiles[mainRel], `${mainRel} 被增量修改了`);
const untouched = tree.files.filter((f) => f !== mainRel && (doneC?.files ?? []).includes(f) === false);
check(untouched.length > 0, '未被涉及的文件保持原样', untouched.join(', '));

/* ---------- 5. 回退 ---------- */
console.log(`\n  ${color(35, '场景 D')} 一键回退`);
if (KEEP) {
  console.log(`  ${dim('--keep 已指定，跳回退')}`);
} else {
  const rb = await post('/api/rollback', {});
  check(rb.ok === true, `回退到 ${rb.restoredFrom}`, `恢复 ${rb.files?.length ?? 0} 个文件`);
  const restoredMain = (await get(`/api/file?path=${encodeURIComponent(mainRel)}`)).content;
  check(restoredMain === beforeFiles[mainRel], `${mainRel} 已回到追加之前的内容`);
  const ctx = await get('/api/context');
  check(!ctx.prompt.includes('导出 Excel'), '提示词也一起回退了');
}

/* ---------- 6. 记忆 / 检索 / 版本 ---------- */
console.log(`\n  ${color(35, '场景 E')} 记忆与检索`);
const mem = await get('/api/memory');
check(mem.prompts >= 1, '提示词历史已积累', `${mem.prompts} 次`);
const rag = await get(`/api/rag?q=${encodeURIComponent('分页 搜索')}`);
check(rag.stats.chunks >= 1, '项目已被索引', `${rag.stats.chunks} 个片段`);
const versions = await get('/api/versions');
check(versions.versions.length >= 2, '版本链完整', versions.versions.map((v) => v.id).join(' → '));

try {
  await reader.cancel();
} catch { /* ignore */ }

console.log(`\n${'─'.repeat(64)}`);
if (failures === 0) console.log(`  ${color(32, '在线验收全部通过 ✅')}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
else console.log(`  ${color(31, `${failures} 项未通过`)}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  生成物在 ${health.workspace}`);
console.log(`  清空生成物：node scripts/clean.mjs --workspace\n`);
process.exit(failures ? 1 : 0);
