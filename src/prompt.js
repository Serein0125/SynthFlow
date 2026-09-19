// 组装送给模型的上下文：角色、协议、项目地图、RAG 召回、技能、用户习惯、按模式裁剪的现有文件。
import { PROTOCOL_SPEC } from './protocol.js';
import { truncate } from './util.js';

const MAX_CONTEXT_FILES = 6;
const MAX_CONTEXT_CHARS = 24000;

const MODE_GUIDE = {
  regenerate: '这是**首轮/全新生成**。请完整产出可运行的文件，动作要果断。',
  continue:
    '这是**增量续写**：用户在原提示词后面追加了内容。已有代码保持不动，只做必要的**新增**（新函数/新模块/新文件），' +
    '优先使用 search/replace 补丁把新能力挂到既有结构上，禁止重新输出整个文件。',
  incremental:
    '这是**定点增量修改**：用户改写了提示词中的某一段。只修改受影响的部分，用 search/replace 补丁，' +
    '不要重写整个文件，更不要动无关文件。',
};

const SPECULATIVE_NOTE =
  '注意：用户**可能还在打字**（这一轮是预演）。所以请：先给一句结论性思考 → 尽早抛出可采纳的建议 → 再产代码；' +
  '代码优先做"能站得住的最小完整版本"，后续用户补字时你会被要求增量续写。';

export function buildMessages(ctx) {
  const {
    prompt,
    mode = 'regenerate',
    speculative = false,
    instruction = '',
    repoMap = '',
    ragHits = [],
    skills = [],
    memoryBriefing = '',
    existingFiles = {},
    recentFiles = [],
    adopted = [],
    config = {},
    previousPrompt = '',
  } = ctx;

  const sys = [];
  sys.push(
    `你是 SynthFlow —— 一个"预生成式"编程协作引擎。用户不需要点发送按钮：他一边打字，你一边实时产出代码、思考与建议。\n` +
      `因此你的输出要**尽早开始**、**结构化**、**可被增量修正**。用户会随时改写前面的提示词，你必须支持定点增量更新而不是推倒重来。`,
  );
  sys.push(PROTOCOL_SPEC);
  sys.push(
    `工作方式要求：\n` +
      `1. 先用 think 通道用一句话确认理解，然后**边想边写**，不要在结尾才一次性交付。\n` +
      `2. 主动补全需求：信息缺失时，用 suggest(kind="clarify") 给出可直接采纳的补充，而不是反问等待。\n` +
      `3. 主动指出风险与更优方案：用 suggest(kind="risk"/"optimize")，每条都要短、可执行、可一键采纳。\n` +
      `4. 每个文件写完立刻关闭 file 通道，然后再开下一个，用户可以边看边改。\n` +
      `5. 建议总数控制在 2~4 条，宁精勿滥。`,
  );
  if (repoMap) sys.push(`当前工作区已有的文件（项目地图）：\n\`\`\`\n${repoMap}\n\`\`\``);
  if (memoryBriefing) sys.push(`关于这位用户的长期习惯（来自本地记忆，请顺着他的习惯写）：\n${memoryBriefing}`);
  if (skills.length) {
    sys.push(
      `本次命中的技能（必须遵守）：\n${skills.map((s) => `### ${s.name}\n${truncate(s.body, 1200)}`).join('\n\n')}`,
    );
  }
  if (ragHits.length) {
    sys.push(
      `从项目里检索到的相关片段（供你复用风格与接口，不要照抄无关部分）：\n` +
        ragHits.map((h) => `--- ${h.source}:${h.startLine} ---\n${truncate(h.text, 1500)}`).join('\n'),
    );
  }
  if (config.systemPromptExtra) sys.push(String(config.systemPromptExtra));

  const user = [];
  user.push(`【用户完整提示词（会话上下文栈已自动拼接）】\n${prompt}`);
  if (adopted.length) user.push(`【用户已采纳的建议】\n${adopted.map((a) => `- ${a.text}`).join('\n')}`);
  if (previousPrompt && previousPrompt !== prompt) user.push(`【上一轮生成时使用的提示词】\n${truncate(previousPrompt, 2000)}`);
  user.push(`【本轮模式】${MODE_GUIDE[mode] ?? MODE_GUIDE.regenerate}`);
  if (speculative) user.push(`【预演提示】${SPECULATIVE_NOTE}`);
  if (instruction) user.push(`【增量指令】\n${instruction}`);

  const fileTexts = selectContextFiles(existingFiles, recentFiles);
  if (fileTexts.length) {
    user.push(
      `【现有文件内容（做更新时 SEARCH 片段必须与下面内容逐字一致，含缩进）】\n` +
        fileTexts.map(([rel, content]) => `##### ${rel}\n\`\`\`\n${truncate(content, 8000)}\n\`\`\``).join('\n'),
    );
  }
  user.push(`现在开始输出。记住：think 与 suggest 通道穿插出现，文件用 file 通道。`);

  return [
    { role: 'system', content: sys.join('\n\n') },
    { role: 'user', content: user.join('\n\n') },
  ];
}

function selectContextFiles(existingFiles, recentFiles) {
  const entries = Object.entries(existingFiles ?? {});
  if (!entries.length) return [];
  const priority = (rel) => {
    const idx = recentFiles.indexOf(rel);
    if (idx >= 0) return idx; // 最近碰过的优先
    if (/main|index|app|server/i.test(rel)) return 50;
    return 100;
  };
  entries.sort((a, b) => priority(a[0]) - priority(b[0]));
  const out = [];
  let total = 0;
  for (const [rel, content] of entries.slice(0, MAX_CONTEXT_FILES)) {
    if (total + content.length > MAX_CONTEXT_CHARS) continue;
    total += content.length;
    out.push([rel, content]);
  }
  return out;
}
