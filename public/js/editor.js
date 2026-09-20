// SynthFlow 前端 · 代码面板：Monaco（VS Code 内核）优先，失败时降级为只读高亮。
// 对外暴露一个 Editor 对象，其他模块只跟它打交道，不关心底层是 Monaco 还是降级渲染。

const Editor = {
  mode: 'fallback', // monaco | fallback
  monaco: null,
  inst: null,
  path: null,
  dirty: false,
  loading: false,
  added: [],
  decorations: null,
  suppressChange: false,
  onDirtyChange: null,
  onSelectionChange: null,
  onSaveRequest: null,
  handlersBound: false,

  async init() {
    if (this.mode === 'monaco' || this.loading) return this.mode === 'monaco';
    if (typeof document === 'undefined' || !el.editorHost || window.__SF_NO_MONACO) return false;
    this.loading = true;
    try {
      await loadScript('/vendor/monaco/vs/loader.js');
      const req = window.require;
      if (!req || typeof req.config !== 'function') throw new Error('monaco loader 不可用');
      req.config({ paths: { vs: '/vendor/monaco/vs' } });
      // Monaco 0.5x 的 AMD 构建把语言服务 worker 打成了带哈希的模块（vs/json.worker-XXXX）。
      // getWorkerUrl 会把解析好的 moduleId 传进来，直接 require 它即可，不用去猜哈希。
      // 万一 worker 起不来（CSP、data: 受限等），Monaco 会自动退回主线程执行，不会崩。
      window.MonacoEnvironment = {
        getWorkerUrl(moduleId) {
          const bootstrap =
            `self.MonacoEnvironment = { baseUrl: '/vendor/monaco/' };` +
            `importScripts('/vendor/monaco/vs/loader.js');` +
            `require.config({ paths: { vs: '/vendor/monaco/vs' } });` +
            `require([${JSON.stringify(moduleId)}], function () {});`;
          return `data:text/javascript;charset=utf-8,${encodeURIComponent(bootstrap)}`;
        },
      };
      await new Promise((resolve, reject) => req(['vs/editor/editor.main'], resolve, reject));
      this.monaco = window.monaco;
      this.createInternal();
      this.mode = 'monaco';
      S.monacoReady = true;
      return true;
    } catch (err) {
      console.warn('[SynthFlow] Monaco 加载失败，降级为只读高亮：', err.message);
      this.mode = 'fallback';
      return false;
    } finally {
      this.loading = false;
    }
  },

  createInternal() {
    const M = this.monaco;
    const dark = document.documentElement.dataset.theme !== 'light';
    const common = {
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: LS.get('fontCode', 12.5),
      lineHeight: 1.6,
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Cascadia Code", monospace',
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      padding: { top: 10, bottom: 10 },
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
      roundedSelection: false,
      theme: dark ? 'vs-dark' : 'vs',
    };
    this.inst = M.editor.create(el.editorHost, {
      ...common,
      value: '',
      language: 'plaintext',
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'off',
      glyphMargin: false,
      folding: true,
      lineNumbersMinChars: 3,
      fixedOverflowWidgets: true,
      readOnly: false,
    });
    this.decorations = this.inst.createDecorationsCollection([]);
    this.inst.onDidChangeModelContent(() => {
      if (this.suppressChange) return;
      this.setDirty(true);
    });
    this.inst.onDidChangeCursorSelection((e) => {
      if (!this.onSelectionChange) return;
      const model = this.inst.getModel();
      if (!model) return;
      const sel = e.selection;
      if (sel.isEmpty()) {
        this.onSelectionChange(null);
        return;
      }
      this.onSelectionChange({
        path: this.path,
        startLine: sel.startLineNumber,
        endLine: sel.endLineNumber,
        text: model.getValueInRange(sel),
        lang: model.getLanguageId(),
      });
    });
    this.inst.addCommand(M.KeyMod.CtrlCmd | M.KeyCode.KeyS, () => {
      if (this.onSaveRequest) this.onSaveRequest();
    });
    // 这里以前额外绑了 Ctrl+D 去切差异视图 —— 那是 Monaco 的
    // 「选中下一个相同项」（多光标）快捷键，占了它就没法做多选。
    // 差异视图已移除，Ctrl+D 交还给 Monaco 自己处理。
  },

  setDirty(v) {
    if (this.dirty === v) return;
    this.dirty = v;
    if (el.dirtyDot) el.dirtyDot.classList.toggle('hidden', !v);
    if (el.btnSave) el.btnSave.classList.toggle('primary', v);
    if (this.onDirtyChange) this.onDirtyChange(v);
  },

  /** 切换显示哪个主机：'code' 显示编辑器，'none' 全藏起来（比如没选文件时）。 */
  showHost(which) {
    const useMonaco = this.mode === 'monaco';
    const codeHost = useMonaco ? el.editorHost : el.codePre;
    const showCode = which === 'code';
    for (const node of [el.editorHost, el.codePre]) {
      if (node) node.classList.toggle('hidden', !showCode || node !== codeHost);
    }
    if (useMonaco && showCode && this.inst) this.inst.layout();
  },

  /** 打开一个文件（内容来自服务端缓存）。focus 只在你主动点文件时才为 true。 */
  async open(path, content, { added = [], focus = false } = {}) {
    this.path = path;
    const lang = monacoLangOf(path);
    this.setDirty(false);
    if (this.mode === 'monaco') {
      const M = this.monaco;
      // 想法 10：Monaco 的 setModel() 会自己去抢焦点（Chromium 下表现为 native-edit-context），
      // 所以先记下当前焦点，切完模型再还回去 —— 否则你打字打到一半就被踢出输入框。
      const prevActive = typeof document !== 'undefined' ? document.activeElement : null;
      let model = M.editor.getModel(M.Uri.parse(`inmemory://sf/${path}`));
      if (!model) model = M.editor.createModel(content, lang, M.Uri.parse(`inmemory://sf/${path}`));
      else model.setValue(content);
      this.suppressChange = true;
      this.inst.setModel(model);
      this.suppressChange = false;
      this.applyAddedLines(added);
      if (focus) {
        this.inst.focus();
      } else {
        this.restoreFocus(prevActive);
      }
    } else {
      this.renderFallback(content, added);
    }
    this.showHost('code');
  },

  /** 把焦点还给"本来该拿着焦点"的元素（通常是输入框）。 */
  restoreFocus(prevActive) {
    if (typeof document === 'undefined') return;
    if (!prevActive || prevActive === document.body || !document.contains(prevActive)) return;
    const restore = () => {
      try {
        prevActive.focus({ preventScroll: true });
      } catch { /* ignore */ }
    };
    restore();
    // Monaco 有时会在下一帧才把焦点拿走，所以再补一次
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
  },

  /**
   * 外部刷新内容（AI 写入 / 回退），不标记为脏。
   *
   * focus：只有"用户主动点文件"时才为 true。默认 false —— 生成过程中会不停刷新，
   * 那时绝不能把焦点从输入框抢走（想法 10）。
   */
  async refresh(content, { added = [], force = false, focus = false } = {}) {
    if (!this.path) return;
    if (!force && this.dirty && this.mode === 'monaco' && this.inst) {
      // 用户有未保存改动时不覆盖编辑器内容，只更新缓存（内容见 S.files）
      // 但"主动点文件"这个动作仍然要把焦点交进去
      if (focus) this.inst.focus();
      return;
    }
    const prevActive = typeof document !== 'undefined' ? document.activeElement : null;
    if (this.mode === 'monaco' && this.inst && this.inst.getModel()) {
      this.suppressChange = true;
      this.inst.getModel().setValue(content);
      this.suppressChange = false;
      this.applyAddedLines(added);
      // 生成过程中不断刷新内容，也绝不能顺手把焦点抢走
      if (prevActive && prevActive !== document.activeElement) this.restoreFocus(prevActive);
      // 但用户主动点文件时，焦点就该进编辑器 —— 放在 restoreFocus 之后，让它胜出
      if (focus) this.inst.focus();
    } else {
      this.renderFallback(content, added);
    }
  },

  renderFallback(content, added = []) {
    if (!el.code) return;
    const lines = content.split('\n');
    const showLn = lines.length <= 1500;
    el.code.classList.toggle('with-lines', showLn);
    const addSet = new Set(added ?? []);
    el.code.innerHTML = highlightLines(content, langOf(this.path ?? 'x.txt'))
      .map((h, i) => {
        const mark = addSet.has(i + 1) ? ' mark-added' : '';
        return `<div class="line${mark}">${showLn ? `<span class="ln">${i + 1}</span>` : ''}${h || ' '}</div>`;
      })
      .join('');
  },

  applyAddedLines(lines) {
    if (this.mode !== 'monaco' || !this.decorations) return;
    this.added = lines ?? [];
    this.decorations.set(
      this.added.map((ln) => ({
        range: new this.monaco.Range(ln, 1, ln, 1),
        options: { isWholeLine: true, className: 'sf-added-line', linesDecorationsClassName: 'sf-added-gutter' },
      })),
    );
  },

  getValue() {
    if (this.mode === 'monaco' && this.inst?.getModel()) return this.inst.getModel().getValue();
    return S.files[this.path] ?? '';
  },

  setTheme(dark) {
    if (this.mode === 'monaco' && this.monaco) this.monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
  },

  setFontSize(px) {
    if (this.mode === 'monaco' && this.inst) this.inst.updateOptions({ fontSize: px });
  },

  layout() {
    this.inst?.layout();
  },
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || !document.head) return reject(new Error('no document'));
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`脚本加载失败: ${src}`));
    document.head.appendChild(s);
  });
}

function monacoLangOf(filePath, hint) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown',
    css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    php: 'php', sh: 'shell', ps1: 'powershell', sql: 'sql', yml: 'yaml', yaml: 'yaml',
    xml: 'xml', vue: 'html', svelte: 'html', toml: 'ini', ini: 'ini',
  };
  return map[ext] ?? hint ?? 'plaintext';
}
