// SynthFlow 流协议解析器
//
// 设计目标：让模型可以在**同一条流**里并行产出
//   1) 思考/推理（think）      2) 建议卡片（suggest）    3) 文件改动（file）   4) 记忆（memory）
// 前端按通道分流渲染 —— 这就是"边打字边出代码 + 并行思考给建议"的底层协议。
//
// 标记语法（容忍空格/缺闭合/`</x>` 变体）：
//   <<<SF think>>>            ... <<<SF /think>>>
//   <<<SF suggest kind="optimize" title="...">>> ... <<<SF /suggest>>>
//   <<<SF file path="src/a.js" action="create|update|rewrite|delete" lang="js">>> ... <<<SF /file>>>
//   <<<SF memory key="style.indent">>>2<<<SF /memory>>>
//
// file 通道内支持 Aider 风格 search/replace 块，可实现真正的"增量补丁"而非整文件重写：
//   <<<<<<< SEARCH
//   旧代码
//   =======
//   新代码
//   >>>>>>> REPLACE

// 容忍模型写成 ">>" 或 ">>>"（真实模型经常少打一个尖括号）。
const MARKER_RE = /^<<<\s*SF\s*(\/)?\s*([a-zA-Z_]+)\s*([^>]*?)>>>?/;
const MAX_MARKER_SCAN = 400;

/**
 * 判断缓冲区开头是不是"还没收全的标记"。
 * 标记一定以 <<<SF / <<< SF 开头，所以只有两种情况需要继续等：
 *   1) 已经出现 <<<SF，只是在等剩下的部分（含属性、结尾尖括号）
 *   2) 目前只有 1~4 个字符，还可能是 <<<SF 的前缀
 * 其它情况（例如代码里的 <<<<<<< SEARCH）必须立刻当普通文本吐出去，否则会破坏内容。
 */
function isMarkerAttempt(rest) {
  if (!rest.startsWith('<')) return false;
  if (/^<<<\s*SF/.test(rest)) return rest.length < MAX_MARKER_SCAN;
  return rest.length <= 4 && /^<{1,3}S?F?$/.test(rest);
}

const SEARCH_RE = /<{5,9}\s*SEARCH\s*\n([\s\S]*?)\n?={5,9}\s*\n([\s\S]*?)\n?>{5,9}\s*REPLACE/g;

function parseAttrs(raw) {
  const attrs = {};
  if (!raw) return attrs;
  const re = /([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s]+))|([a-zA-Z_][\w-]*)/g;
  let m;
  while ((m = re.exec(raw))) {
    if (m[1]) attrs[m[1]] = m[3] ?? m[4] ?? m[5] ?? '';
    else if (m[6]) attrs[m[6]] = 'true';
  }
  return attrs;
}

/** 去掉包裹整个内容的 ```lang 围栏。 */
export function stripFence(text) {
  const s = String(text ?? '');
  const m = s.match(/^\s*```[a-zA-Z0-9_+#.-]*\s*\n([\s\S]*?)\n?\s*```\s*$/);
  return m ? m[1] : s;
}

/**
 * 把 file 通道内容解析成一次文件操作。
 * @returns {{path:string, action:string, lang:string, mode:'patch'|'rewrite'|'delete',
 *            patches:Array<{search:string,replace:string}>, content:string, note:string}}
 */
export function parseFilePayload(meta, rawContent) {
  const action = (meta.action || 'create').toLowerCase();
  const body = stripFence(rawContent);
  const patches = [];
  SEARCH_RE.lastIndex = 0;
  let m;
  while ((m = SEARCH_RE.exec(body))) patches.push({ search: m[1], replace: m[2] });

  let mode;
  let content = body;
  if (action === 'delete') {
    mode = 'delete';
    content = '';
  } else if (patches.length > 0) {
    mode = 'patch';
    content = '';
  } else {
    mode = action === 'create' ? 'create' : 'rewrite';
  }
  return {
    path: (meta.path || '').trim(),
    action,
    lang: meta.lang || guessLang(meta.path || ''),
    mode,
    patches,
    content: content.replace(/\s+$/, '\n'),
    note: meta.note || '',
  };
}

export function guessLang(filePath) {
  const ext = String(filePath).split('.').pop()?.toLowerCase() ?? '';
  return (
    {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'typescript', vue: 'vue', svelte: 'svelte',
      json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less',
      html: 'html', htm: 'html', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
      java: 'java', kt: 'kotlin', php: 'php', sh: 'bash', ps1: 'powershell',
      sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml',
    }[ext] ?? 'text'
  );
}

/**
 * 增量流解析器。
 * handlers: {
 *   onText(delta), onThinkStart(), onThinkDelta(delta), onThinkEnd(text),
 *   onSuggestionStart(meta), onSuggestionDelta(delta), onSuggestionEnd(obj),
 *   onFileStart(meta), onFileDelta(delta), onFileEnd(op),
 *   onMemory({key,value}), onRaw(evt)
 * }
 */
export function createProtocolParser(handlers = {}) {
  const call = (name, ...args) => {
    try {
      handlers[name]?.(...args);
    } catch (err) {
      handlers.onError?.(err);
    }
  };

  let buffer = '';
  let channel = null; // null | {name, meta, content}
  let textBuf = '';
  let ended = false;
  const suggestions = [];

  function openChannel(name, attrs) {
    closeChannel();
    channel = { name, meta: attrs, content: '' };
    if (name === 'think') call('onThinkStart');
    else if (name === 'suggest') call('onSuggestionStart', attrs);
    else if (name === 'file') call('onFileStart', attrs);
  }

  function closeChannel() {
    if (!channel) return;
    const { name, meta, content } = channel;
    channel = null;
    if (name === 'think') call('onThinkEnd', content.trim());
    else if (name === 'suggest') {
      const obj = {
        id: meta.id || `sg_${suggestions.length + 1}`,
        kind: (meta.kind || 'optimize').toLowerCase(),
        title: (meta.title || firstLine(content)).trim(),
        body: content.trim(),
        impact: (meta.impact || 'medium').toLowerCase(),
        insert: meta.insert || '',
        auto: meta.auto !== 'false',
      };
      suggestions.push(obj);
      call('onSuggestionEnd', obj);
    } else if (name === 'file') call('onFileEnd', parseFilePayload(meta, content));
    else if (name === 'memory') {
      if (meta.key) call('onMemory', { key: meta.key.trim(), value: (meta.value ?? content).trim() });
      else {
        const idx = content.search(/[:=]/);
        const key = idx >= 0 ? content.slice(0, idx).trim() : content.trim();
        const value = idx >= 0 ? content.slice(idx + 1).trim() : '';
        call('onMemory', { key, value });
      }
    }
  }

  function emitContent(delta) {
    if (!delta) return;
    if (!channel) {
      textBuf += delta;
      call('onText', delta);
      return;
    }
    channel.content += delta;
    if (channel.name === 'think') call('onThinkDelta', delta);
    else if (channel.name === 'suggest') call('onSuggestionDelta', delta);
    else if (channel.name === 'file') call('onFileDelta', delta);
  }

  function push(chunk) {
    if (ended) return;
    buffer += String(chunk ?? '');
    let guard = 0;
    for (;;) {
      if (guard++ > 100000) break;
      const i = buffer.indexOf('<<<');
      if (i < 0) {
        // 末尾可能是标记前缀（如 "<"、"<<"），保留住等待后续 chunk。
        const tail = buffer.match(/<{1,2}$/);
        const keep = tail ? tail[0].length : 0;
        emitContent(buffer.slice(0, buffer.length - keep));
        buffer = keep ? buffer.slice(buffer.length - keep) : '';
        return;
      }
      emitContent(buffer.slice(0, i));
      const rest = buffer.slice(i);
      const m = rest.match(MARKER_RE);
      if (m) {
        buffer = rest.slice(m[0].length);
        const isClose = Boolean(m[1]);
        const name = m[2].toLowerCase();
        if (isClose) closeChannel();
        else openChannel(name, parseAttrs(m[3]));
        continue;
      }
      // 还没收全标记：只有确实像标记开头时才继续等，否则逐字当文本吐出。
      if (isMarkerAttempt(rest)) {
        buffer = rest;
        return;
      }
      emitContent(rest[0]);
      buffer = rest.slice(1);
    }
  }

  function end() {
    if (ended) return;
    ended = true;
    if (buffer) {
      emitContent(buffer);
      buffer = '';
    }
    closeChannel();
    call('onEnd', { text: textBuf, suggestions });
  }

  return { push, end, suggestions };
}

function firstLine(text) {
  const l = String(text ?? '').trim().split('\n')[0] ?? '';
  return l.slice(0, 80);
}

/** 生成给模型看的协议说明（放进 system prompt）。 */
export const PROTOCOL_SPEC = `你必须使用 SynthFlow 流协议输出。同一份回复里可以交替出现以下通道，顺序不限：

<<<SF think>>>
（推理、需求补全、取舍说明。可以随时穿插出现，用户会实时看到）
<<<SF /think>>>

<<<SF suggest kind="clarify|optimize|risk|test|a11y" title="一句话标题" impact="high|medium|low" insert="可直接粘进用户提示词的一句话">>>
建议正文，说明为什么、怎么改。
<<<SF /suggest>>>

<<<SF file path="相对路径/文件名" action="create|update|rewrite|delete" lang="js">>>
文件内容或补丁
<<<SF /file>>>

规则：
- path 必须是相对路径，禁止绝对路径与 ..。
- action="update" 时优先使用 search/replace 补丁块实现**增量修改**（SEARCH 段落必须与文件现有内容逐字一致，包含缩进）：
  <<<<<<< SEARCH
  旧代码
  =======
  新代码
  >>>>>>> REPLACE
- 只有当文件几乎整体重写时才用 action="rewrite"。
- 新建文件用 action="create"，文件内容不要带 markdown 围栏。
- 不要输出协议之外的代码块；所有代码都必须放在 file 通道里。`;
