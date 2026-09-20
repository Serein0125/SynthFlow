// SynthFlow 清理工具：把磁盘占用降回零，且绝不碰工作区之外的东西。
//   node scripts/clean.mjs            查看占用，不做任何删除
//   node scripts/clean.mjs --test     删除冒烟测试产物 .synthflow/testrun
//   node scripts/clean.mjs --history  删除历史与记忆（.synthflow/history、memory、sessions、index.json）
//   node scripts/clean.mjs --snapshots 删除版本快照（回退能力会重置）
//   node scripts/clean.mjs --workspace 清空生成出来的代码（workspace/ 目录内所有文件）
//   node scripts/clean.mjs --all      以上全部（配置 config.json 会保留）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHuman } from '../src/util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));

const dirSize = (dir) => {
  let total = 0;
  let count = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
          count += 1;
        } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return { total, count };
};

const targets = [
  { key: 'workspace', flag: 'workspace', dir: path.join(ROOT, 'workspace'), desc: '生成的代码' },
  { key: 'projects', flag: 'projects', dir: path.join(ROOT, '.synthflow', 'projects'), desc: '各项目的快照/会话/暂存' },
  { key: 'snapshots', flag: 'snapshots', dir: path.join(ROOT, '.synthflow', 'snapshots'), desc: '版本快照（旧版位置）' },
  { key: 'history', flag: 'history', dir: path.join(ROOT, '.synthflow', 'history'), desc: '提示词历史' },
  { key: 'memory', flag: 'memory', dir: path.join(ROOT, '.synthflow', 'memory'), desc: '习惯记忆' },
  { key: 'sessions', flag: 'sessions', dir: path.join(ROOT, '.synthflow', 'sessions'), desc: '会话上下文栈（旧版位置）' },
  { key: 'index', flag: 'index', dir: path.join(ROOT, '.synthflow', 'index.json'), desc: 'RAG 索引（旧版位置）', file: true },
  { key: 'testrun', flag: 'test', dir: path.join(ROOT, '.synthflow', 'testrun'), desc: '冒烟测试产物' },
  { key: 'testrun', flag: 'testrun', dir: path.join(ROOT, '.synthflow', 'testrun'), desc: '冒烟测试产物' },
  { key: 'vendor', flag: 'vendor', dir: path.join(ROOT, 'node_modules', 'monaco-editor'), desc: 'Monaco 用不到的构建（裁掉省 ~70MB）' },
];

const seenKeys = new Set();
const uniqueTargets = targets.filter((t) => {
  if (seenKeys.has(t.key)) return false;
  seenKeys.add(t.key);
  return true;
});

const jobs = [];
if (flags.has('--all')) {
  for (const t of uniqueTargets) if (t.key !== 'testrun' && t.key !== 'vendor') jobs.push(t);
} else {
  for (const t of uniqueTargets) if (flags.has(`--${t.flag}`)) jobs.push(t);
}

console.log('\nSynthFlow 磁盘占用：');
for (const t of uniqueTargets) {
  if (t.key === 'vendor') continue; // 单独处理，见下
  const exists = fs.existsSync(t.dir);
  const size = exists ? (t.file ? fs.statSync(t.dir).size : dirSize(t.dir).total) : 0;
  const count = exists && !t.file ? dirSize(t.dir).count : exists ? 1 : 0;
  console.log(`  ${t.key.padEnd(10)} ${String(t.desc).padEnd(20)} ${bytesToHuman(size).padStart(10)}  ${count} 个文件${exists ? '' : '  (不存在)'}`);
}
// Monaco 单独展示，方便看清哪部分是可以裁掉的
const monacoDir = path.join(ROOT, 'node_modules', 'monaco-editor');
if (fs.existsSync(monacoDir)) {
  for (const sub of ['min', 'esm', 'dev']) {
    const d = path.join(monacoDir, sub);
    if (fs.existsSync(d)) console.log(`  monaco/${sub.padEnd(5)} ${'（只有 min 是运行时需要的）'.padEnd(20)} ${bytesToHuman(dirSize(d).total).padStart(10)}`);
  }
}

if (!jobs.length) {
  console.log('\n未指定删除目标，什么都没删。可选：--test --projects --history --snapshots --workspace --vendor --all');
  console.log('提示：.synthflow/config.json（你的模型配置）与 .synthflow/skills（技能）永远不会被本脚本删除。\n');
  process.exit(0);
}

let freed = 0;
console.log('\n开始清理：');
for (const t of jobs) {
  if (!fs.existsSync(t.dir)) {
    console.log(`  - ${t.desc}：不存在，跳过`);
    continue;
  }
  if (t.key === 'vendor') {
    // 只删掉运行时用不到的构建，保留 min（浏览器加载的就是它）
    let saved = 0;
    for (const sub of ['dev', 'esm']) {
      const d = path.join(t.dir, sub);
      if (!fs.existsSync(d)) continue;
      const size = dirSize(d).total;
      fs.rmSync(d, { recursive: true, force: true });
      saved += size;
    }
    const types = path.join(t.dir, 'monaco.d.ts');
    if (fs.existsSync(types)) {
      saved += fs.statSync(types).size;
      fs.rmSync(types, { force: true });
    }
    freed += saved;
    console.log(`  ✓ 已裁掉 Monaco 的 dev/esm 构建（保留 min，省 ${bytesToHuman(saved)}）`);
    console.log('    注意：再跑一次 npm install 会把它们装回来，需要时重新执行本命令即可。');
    continue;
  }
  const size = t.file ? fs.statSync(t.dir).size : dirSize(t.dir).total;
  fs.rmSync(t.dir, { recursive: true, force: true });
  freed += size;
  console.log(`  ✓ 已删除 ${t.desc}（${bytesToHuman(size)}）`);
}
console.log(`\n共释放 ${bytesToHuman(freed)}。工作区外无任何改动。\n`);
