// SynthFlow 前端 · 界面布局（想法 7）：面板宽度可拖拽、字号可调、面板可隐藏、布局预设。
// 所有偏好都存 localStorage，刷新后保持；参考 Photoshop 的工作区概念。

const Layout = {
  defaults: {
    sidebar: 260,
    stream: 340,
    composer: 190,
    fontUI: 13,
    fontCode: 12.5,
    showSidebar: true,
    showStream: true,
    preset: 'default',
  },
  presets: {
    default: { sidebar: 260, stream: 340, composer: 190, showSidebar: true, showStream: true },
    code: { sidebar: 210, stream: 240, composer: 150, showSidebar: true, showStream: true },
    chat: { sidebar: 200, stream: 420, composer: 280, showSidebar: true, showStream: true },
    zen: { sidebar: 0, stream: 0, composer: 200, showSidebar: false, showStream: false },
  },
  s: null,

  init() {
    this.s = { ...this.defaults, ...LS.get('layout', {}) };
    this.apply();
    this.bindSplitters();
    this.bindPanel();
  },

  apply() {
    const s = this.s;
    const root = document.documentElement;
    root.style.setProperty('--sidebar-w', `${s.sidebar}px`);
    root.style.setProperty('--stream-w', `${s.stream}px`);
    root.style.setProperty('--composer-h', `${s.composer}px`);
    root.style.setProperty('--composer-min-h', `${s.composer}px`);
    root.style.setProperty('--font-size-ui', `${s.fontUI}px`);
    root.style.setProperty('--font-size-code', `${s.fontCode}px`);
    document.body.classList.toggle('hide-sidebar', !s.showSidebar);
    document.body.classList.toggle('hide-stream', !s.showStream);
    if (typeof Editor !== 'undefined') Editor.setFontSize(s.fontCode);
    this.syncPanel();
  },

  set(key, value) {
    this.s[key] = value;
    this.s.preset = 'custom';
    LS.set('layout', this.s);
    this.apply();
  },

  usePreset(name) {
    const p = this.presets[name];
    if (!p) return;
    this.s = { ...this.s, ...p, preset: name };
    LS.set('layout', this.s);
    this.apply();
  },

  reset() {
    this.s = { ...this.defaults };
    LS.set('layout', this.s);
    this.apply();
    toast('界面布局已恢复默认', 'ok', 2000);
  },

  bindSplitters() {
    if (typeof document === 'undefined') return;
    const drag = (node, handler) => {
      if (!node) return;
      node.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const { clientX, clientY } = e;
        document.body.classList.add('resizing');
        const move = (ev) => handler(ev.clientX - clientX, ev.clientY - clientY);
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.classList.remove('resizing');
          Editor.layout();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      // 双击恢复该分栏的默认宽度
      node.addEventListener('dblclick', () => {
        if (node.dataset.reset) this.set(node.dataset.reset, this.defaults[node.dataset.reset]);
      });
    };
    const left = this.s.sidebar;
    const stream = this.s.stream;
    drag($('#split-left'), (dx) => {
      const base = this.s.preset === 'custom' ? this.s.sidebar : left;
      this.set('sidebar', Math.max(140, Math.min(520, base + dx)));
    });
    drag($('#split-right'), (dx) => {
      const base = this.s.preset === 'custom' ? this.s.stream : stream;
      this.set('stream', Math.max(180, Math.min(640, base - dx)));
    });
    drag($('#split-composer'), (dy) => {
      this.set('composer', Math.max(96, Math.min(520, this.s.composer - dy)));
    });
    const sl = $('#split-left');
    const sr = $('#split-right');
    if (sl) sl.dataset.reset = 'sidebar';
    if (sr) sr.dataset.reset = 'stream';
  },

  bindPanel() {
    const panel = el.layoutPanel;
    if (!panel || !el.btnLayout) return;
    el.btnLayout.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('hidden');
      this.syncPanel();
    });
    document.addEventListener('click', (e) => {
      if (panel.classList.contains('hidden')) return;
      if (panel.contains(e.target) || el.btnLayout.contains(e.target)) return;
      panel.classList.add('hidden');
    });
  },

  syncPanel() {
    const panel = el.layoutPanel;
    if (!panel) return;
    const q = (id) => panel.querySelector(id);
    const bind = (id, key, fmt) => {
      const node = q(id);
      if (!node) return;
      if (node.type === 'checkbox') node.checked = Boolean(this.s[key]);
      else node.value = this.s[key];
      const out = q(`${id}-val`);
      if (out && fmt) out.textContent = fmt(this.s[key]);
    };
    bind('#ly-sidebar', 'sidebar', (v) => `${v}px`);
    bind('#ly-stream', 'stream', (v) => `${v}px`);
    bind('#ly-composer', 'composer', (v) => `${v}px`);
    bind('#ly-font-ui', 'fontUI', (v) => `${v}px`);
    bind('#ly-font-code', 'fontCode', (v) => `${v}px`);
    bind('#ly-show-sidebar', 'showSidebar');
    bind('#ly-show-stream', 'showStream');
    panel.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === this.s.preset));
    if (!this.bound) {
      this.bound = true;
      const onChange = (id, key, numeric = true, scale = 1) => {
        const node = q(id);
        if (!node) return;
        node.addEventListener('input', () => {
          const v = node.type === 'checkbox' ? node.checked : Number(node.value) * scale;
          this.set(key, numeric ? v : node.checked);
          this.syncPanel();
        });
      };
      onChange('#ly-sidebar', 'sidebar');
      onChange('#ly-stream', 'stream');
      onChange('#ly-composer', 'composer');
      onChange('#ly-font-ui', 'fontUI');
      onChange('#ly-font-code', 'fontCode');
      onChange('#ly-show-sidebar', 'showSidebar', false);
      onChange('#ly-show-stream', 'showStream', false);
      panel.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => this.usePreset(b.dataset.preset)));
      const reset = q('#ly-reset');
      if (reset) reset.addEventListener('click', () => this.reset());
    }
  },
};
