// SynthFlow 前端 · 界面布局（想法 7）：面板宽度可拖拽、字号可调、面板可隐藏、布局预设。
// 所有偏好都存 localStorage，刷新后保持；参考 Photoshop 的工作区概念。

const Layout = {
  defaults: {
    sidebar: 260,
    stream: 340,
    composer: 205,
    treePane: 380,
    fontUI: 13,
    fontCode: 12.5,
    showSidebar: true,
    showStream: true,
    preset: 'default',
  },
  /**
   * 各栏位的允许区间。下限不是随便写的，是"再小就会坏"的实测值：
   * - composer 的内容天然要 201px（意图条 18 + 输入行 92 + 工具行 22 + 状态条 26
   *   + 3 个间距 24 + 内边距 19），低于它控件就会挤在一起 ——
   *   之前滑块允许拉到 120，一拉就重叠。
   * - sidebar / stream / treePane 低于下面的值，文件名和时间线就没法看了。
   * 另外 CSS 里 .composer 只设了 min-height，内容更高时盒子会自己长起来兜底。
   */
  limits: {
    sidebar: [140, 520],
    stream: [180, 640],
    composer: [205, 560],
    treePane: [120, 900],
  },
  /** 时间线面板的下限，和 CSS 里 .sidebar 的 minmax 保持一致 */
  MIN_TIMELINE: 110,
  /** 分栏线粗细，和 --splitter 保持一致 */
  SPLITTER: 5,
  /** 滚轮一格改多少 */
  WHEEL_STEP: { wide: 16, high: 12 },
  presets: {
    default: { sidebar: 260, stream: 340, composer: 205, showSidebar: true, showStream: true },
    code: { sidebar: 210, stream: 240, composer: 205, showSidebar: true, showStream: true },
    chat: { sidebar: 200, stream: 420, composer: 280, showSidebar: true, showStream: true },
    // 注意：zen 只是"不显示"，宽度仍然保留成正常值。
    // 以前这里写的是 sidebar:0 / stream:0 —— 于是取消隐藏之后你得到一根 0 宽的空栏，
    // 除了拖那条 5px 的分栏线，没有任何办法把它找回来。
    zen: { sidebar: 260, stream: 340, composer: 205, showSidebar: false, showStream: false },
  },
  s: null,

  clamp(key, value) {
    const [lo, hi] = this.limits[key] ?? [0, Infinity];
    const n = Number(value);
    if (!Number.isFinite(n)) return this.defaults[key] ?? lo;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  },

  init() {
    this.s = { ...this.defaults, ...LS.get('layout', {}) };
    // localStorage 里可能留着老版本存下的越界值（比如 composer 120），
    // 直接夹回来，不然刷新一次就又是一屏重叠的控件。
    for (const k of Object.keys(this.limits)) this.s[k] = this.clamp(k, this.s[k]);
    this.apply();
    this.bindSplitters();
    this.bindPanel();
  },

  /** 文件树面板最多能多高：得给时间线和那条分界线留下位置。窗口越小上限越低。 */
  treeCeiling() {
    const [, hi] = this.limits.treePane;
    if (typeof document === 'undefined') return hi;
    const sidebar = document.querySelector('.sidebar');
    const total = sidebar?.clientHeight ?? 0;
    // 侧栏还没布局出来（或被隐藏）时不做限制，免得把用户设的值压成最小值
    if (!total) return hi;
    return Math.max(this.limits.treePane[0], Math.min(hi, total - this.MIN_TIMELINE - this.SPLITTER));
  },

  apply() {
    const s = this.s;
    const root = document.documentElement;
    // 面板要显示时宽度至少有下限，否则"显示"出来的是一根 0 宽的柱子，
    // 用户除了拖分栏线没办法找回来（localStorage 里的旧值、旧预设都可能留下 0）。
    if (s.showSidebar && s.sidebar < this.limits.sidebar[0]) s.sidebar = this.defaults.sidebar;
    if (s.showStream && s.stream < this.limits.stream[0]) s.stream = this.defaults.stream;
    if (s.composer < this.limits.composer[0]) s.composer = this.defaults.composer;
    root.style.setProperty('--sidebar-w', `${s.sidebar}px`);
    root.style.setProperty('--stream-w', `${s.stream}px`);
    root.style.setProperty('--composer-h', `${s.composer}px`);
    root.style.setProperty('--composer-min-h', `${s.composer}px`);
    // 写入前夹一次：窗口变小时文件树不能把时间线整个挤没。
    // 注意只夹"写进 CSS 的值"，不动 s.treePane —— 否则窗口缩一次，用户设的偏好就永久变小了。
    root.style.setProperty('--tree-h', `${Math.min(s.treePane, this.treeCeiling())}px`);
    root.style.setProperty('--font-size-ui', `${s.fontUI}px`);
    root.style.setProperty('--font-size-code', `${s.fontCode}px`);
    document.body.classList.toggle('hide-sidebar', !s.showSidebar);
    document.body.classList.toggle('hide-stream', !s.showStream);
    if (typeof Editor !== 'undefined') Editor.setFontSize(s.fontCode);
    this.syncPanel();
  },

  set(key, value) {
    let v = key in this.limits ? this.clamp(key, value) : value;
    // 文件树还要额外受"当前窗口能给出多少高度"的限制：
    // 不然拖到 900px 会把下面的时间线整个顶出可视区。
    if (key === 'treePane') v = Math.min(v, this.treeCeiling());
    this.s[key] = v;
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

  /**
   * 绑定面板之间的分栏线。
   *
   * 这里以前是"增量式"写法：每个 mousemove 都拿 `this.s[key] + dx` 去 set，
   * 而 dx 是**从按下那一刻算起的累计位移** —— 于是位移被反复累加：
   * 拉 10px 变 +10，再拉 10px 变 +30，再拉 10px 变 +60……
   * 越拉越快，轻轻一动整栏就飞出去，这就是"拉动灵敏度不对"的根因。
   * 现在改成**绝对式**：按下时记住基准值，之后每一帧都算 `基准值 + 累计位移`。
   */
  bindSplitters() {
    if (typeof document === 'undefined') return;
    const drag = (node, key, { axis = 'x', invert = 1 } = {}) => {
      if (!node) return;
      node.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const base = Number(this.s[key]) || this.defaults[key];
        document.body.classList.add('resizing');
        const move = (ev) => {
          const raw = axis === 'x' ? ev.clientX - startX : startY - ev.clientY;
          this.set(key, base + invert * raw);
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.classList.remove('resizing');
          Editor.layout();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      // 双击恢复该分栏的默认值
      node.addEventListener('dblclick', () => {
        this.set(key, this.defaults[key]);
        toast(`已把该分栏恢复到默认值（${this.defaults[key]}px）`, 'ok', 1800);
      });
      // 滚轮也能调：鼠标停在分界线上滚，不用先精确按住再拖。
      // 统一语义 —— **往上滚 = 变大**（改的是这条线对应的那个面板的尺寸）。
      node.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.leashWheel({ key, axis, node }, e.deltaY);
      }, { passive: false });
    };
    drag($('#split-left'), 'sidebar', { axis: 'x' });
    drag($('#split-right'), 'stream', { axis: 'x', invert: -1 });
    // 输入区的分界线在它**上方**：往下拖 = 边界下移 = 输入区变矮，所以是 base - dy。
    // （axis:'y' 时 raw = startY - clientY = -dy，因此这里 invert 取 1）
    drag($('#split-composer'), 'composer', { axis: 'y', invert: 1 });
    // 左栏里"文件树 / 版本时间线"之间的那条线。它在文件树**下方**：
    // 往下拖 = 文件树变高（raw = -dy，所以 invert 取 -1 得到 base + dy）。
    drag($('#split-tree'), 'treePane', { axis: 'y', invert: -1 });
  },

  /**
   * 在分界线上滚轮调尺寸 —— 这里有个绕不开的矛盾：
   * 滚一格，分界线自己就移动了（它跟着尺寸走），光标立刻不在它上面了，
   * 第二格滚轮就落到旁边的面板上，表现为"滚一下有反应，再滚就没反应"。
   *
   * 解决办法是滚过一次之后短暂"接管"窗口的滚轮事件（700ms 内没有新的滚轮就放开），
   * 这样一口气滚七八格都是连续的；手一停就恢复正常，不会长期劫持别处的滚动。
   */
  leashWheel(target, deltaY) {
    this.wheelTarget = target;
    clearTimeout(this.wheelLeash);
    if (typeof window !== 'undefined' && !this.wheelLeashBound) {
      this.wheelLeashBound = true;
      // 捕获阶段：要抢在别的滚动手势之前拿到事件
      window.addEventListener('wheel', (e) => {
        if (!this.wheelTarget) return;
        e.preventDefault();
        this.applyWheelDelta(this.wheelTarget, e.deltaY);
        clearTimeout(this.wheelLeash);
        this.wheelLeash = setTimeout(() => { this.wheelTarget = null; }, 700);
      }, { passive: false, capture: true });
    }
    this.applyWheelDelta(target, deltaY);
    this.wheelLeash = setTimeout(() => { this.wheelTarget = null; }, 700);
  },

  applyWheelDelta({ key, axis, node }, deltaY) {
    const step = axis === 'x' ? this.WHEEL_STEP.wide : this.WHEEL_STEP.high;
    const dir = deltaY < 0 ? 1 : -1;
    this.set(key, (Number(this.s[key]) || this.defaults[key]) + dir * step);
    this.flash(node);
  },

  /** 滚轮调尺寸时闪一下分界线，让人知道"这一下是有用的"。 */
  flash(node) {
    node.classList.add('wheel-flash');
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => node.classList.remove('wheel-flash'), 180);
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
    bind('#ly-tree', 'treePane', (v) => `${v}px`);
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
        // 滚轮直接改数值：不用先精确点中那个小圆点再拖。
        // preventDefault 是必须的 —— 否则滚轮会顺带把布局面板本身滚走。
        if (node.type === 'range') {
          node.addEventListener('wheel', (e) => {
            e.preventDefault();
            const step = Number(node.step) || 1;
            const dir = e.deltaY < 0 ? 1 : -1;
            this.set(key, Number(node.value) + dir * step);
            this.syncPanel();
          }, { passive: false });
          node.title = '拖动或滚轮调整';
        }
      };
      onChange('#ly-sidebar', 'sidebar');
      onChange('#ly-tree', 'treePane');
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
