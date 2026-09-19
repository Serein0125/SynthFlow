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
  { key: 'snapshots', flag: 'snapshots', dir: path.join(ROOT, '.synthflow', 'snapshots'), desc: '版本快照（回退用）' },
  { key: 'history', flag: 'history', dir: path.join(ROOT, '.synthflow', 'history'), desc: '提示词历史' },
  { key: 'memory', flag: 'memory', dir: path.join(ROOT, '.synthflow', 'memory'), desc: '习惯记忆' },
  { key: 'sessions', flag: 'sessions', dir: path.join(ROOT, '.synthflow', 'sessions'), desc: '会话上下文栈' },
  { key: 'index', flag: 'index', dir: path.join(ROOT, '.synthflow', 'index.json'), desc: 'RAG 索引', file: true },
  { key: 'testrun', flag: 'test', dir: path.join(ROOT, '.synthflow', 'testrun'), desc: '冒烟测试产物' },
  { key: 'testrun', flag: 'testrun', dir: path.join(ROOT, '.synthflow', 'testrun'), desc: '冒烟测试产物' },
];

const seenKeys = new Set();
const uniqueTargets = targets.filter((t) => {
  if (seenKeys.has(t.key)) return false;
  seenKeys.add(t.key);
  return true;
});

const jobs = [];
if (flags.has('--all')) {
  for (const t of uniqueTargets) if (t.key !== 'testrun') jobs.push(t);
} else {
  for (const t of uniqueTargets) if (flags.has(`--${t.flag}`)) jobs.push(t);
}

console.log('\nSynthFlow 磁盘占用：');
for (const t of uniqueTargets) {
  const exists = fs.existsSync(t.dir);
  const size = exists ? (t.file ? fs.statSync(t.dir).size : dirSize(t.dir).total) : 0;
  const count = exists && !t.file ? dirSize(t.dir).count : exists ? 1 : 0;
  console.log(`  ${t.key.padEnd(10)} ${String(t.desc).padEnd(14)} ${bytesToHuman(size).padStart(10)}  ${count} 个文件${exists ? '' : '  (不存在)'}`);
}

if (!jobs.length) {
  console.log('\n未指定删除目标，什么都没删。可选：--test --history --snapshots --workspace --all');
  console.log('提示：.synthflow/config.json（你的模型配置）永远不会被本脚本删除。\n');
  process.exit(0);
}

let freed = 0;
console.log('\n开始清理：');
for (const t of jobs) {
  if (!fs.existsSync(t.dir)) {
    console.log(`  - ${t.desc}：不存在，跳过`);
    continue;
  }
  const size = t.file ? fs.statSync(t.dir).size : dirSize(t.dir).total;
  fs.rmSync(t.dir, { recursive: true, force: true });
  freed += size;
  console.log(`  ✓ 已删除 ${t.desc}（${bytesToHuman(size)}）`);
}
console.log(`\n共释放 ${bytesToHuman(freed)}。工作区外无任何改动。\n`);
