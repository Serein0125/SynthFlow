// SynthFlow 前端 · 各种面板：设置（模型/生成/建议/项目/技能）、配置档、技能编辑、风格、项目切换、命令面板。

const Panels = {
  ctx: {},
  bound: false,

  /* ============================ 设置主面板 ============================ */

  async openSettings() {
    try {
      const st = await get('/api/state');
      const cfgRes = await get('/api/config').catch(() => ({ config: st.config }));
      const sk = await get('/api/skills').catch(() => ({ skills: [] }));
      const styleRes = await get('/api/style').catch(() => ({ style: null }));
      this.ctx = {
        state: st,
        config: { ...st.config, ...cfgRes.config },
        presets: st.presets ?? {},
        profiles: st.profiles ?? [],
        activeProfileId: st.activeProfileId,
        projects: st.projects ?? { list: [] },
        skills: sk.skills ?? [],
        style: styleRes.style ?? null,
      };
      this.fill();
      el.modal.classList.remove('hidden');
    } catch (err) {
      toast(`读取设置失败：${err.message}`, 'err');
    }
  },

  fill() {
    const { config, presets, profiles, activeProfileId, projects, skills, style, state } = this.ctx;
    const q = (s) => el.modal.querySelector(s);

    // —— 生成参数 ——
    q('#cfg-specDelayMs').value = config.specDelayMs ?? 1000;
    q('#cfg-commitIdleMs').value = config.commitIdleMs ?? 900;
    q('#cfg-settleMs').value = config.settleMs ?? 1600;
    q('#cfg-intentThreshold').value = config.intentThreshold ?? 0.6;
    q('#cfg-autoCommit').checked = config.autoCommit !== false;
    q('#cfg-autoAdoptHigh').checked = Boolean(config.autoAdoptHigh);
    q('#cfg-patchRetry').checked = config.patchRetry !== false;
    q('#cfg-saveMode').value = config.saveMode === 'auto' ? 'auto' : 'manual';
    q('#cfg-streamLimitKB').value = config.streamLimitKB ?? 1024;
    q('#cfg-compactStyle').value = config.compactStyle ?? 'balanced';

    // —— 建议开关（想法 5）——
    const sug = config.suggest ?? {};
    q('#sg-clarify').checked = sug.clarify !== false;
    q('#sg-optimize').checked = sug.optimize !== false;
    q('#sg-risk').checked = sug.risk !== false;
    q('#sg-test').checked = sug.test === true;
    q('#sg-a11y').checked = sug.a11y === true;
    q('#sg-max').value = sug.max ?? 4;
    q('#cfg-custom').value = config.customInstructions ?? '';

    // —— 项目（想法 4/D）——
    const paths = state.paths ?? {};
    q('#pj-current').textContent = `${paths.projectDir ?? ''}${state.workspace?.staging ? '（暂存模式）' : '（直接写入）'}`;
    q('#pj-dir').value = config.projectDir ?? '';
    q('#pj-mode').value = config.writeMode === 'staging' ? 'staging' : 'direct';
    this.renderProjects();

    // —— 风格扫描（想法 4）——
    this.renderStyle(style);

    // —— 配置档（想法 8）——
    this.renderProfiles(profiles, activeProfileId, presets);

    // —— 技能（想法 6）——
    this.renderSkills(skills);

    if (!this.bound) {
      this.bound = true;
      this.bind();
    }
  },

  bind() {
    const q = (sel) => (el.modal ? el.modal.querySelector(sel) : null);
    const on = (sel, evt, fn) => {
      const node = q(sel);
      if (node) node.addEventListener(evt, fn);
      return node;
    };
    el.modal.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        el.modal.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
        el.modal.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== btn.dataset.tab));
      });
    });
    on('#cfg-close', 'click', () => el.modal.classList.add('hidden'));
    el.modal.addEventListener('click', (e) => {
      if (e.target === el.modal) el.modal.classList.add('hidden');
    });

    on('#cfg-save', 'click', async () => {
      const payload = {
        specDelayMs: Number(q('#cfg-specDelayMs').value),
        commitIdleMs: Number(q('#cfg-commitIdleMs').value),
        settleMs: Number(q('#cfg-settleMs').value),
        intentThreshold: Number(q('#cfg-intentThreshold').value),
        autoCommit: q('#cfg-autoCommit').checked,
        autoAdoptHigh: q('#cfg-autoAdoptHigh').checked,
        patchRetry: q('#cfg-patchRetry').checked,
        saveMode: q('#cfg-saveMode').value,
        streamLimitKB: Number(q('#cfg-streamLimitKB').value),
        compactStyle: q('#cfg-compactStyle').value,
        customInstructions: q('#cfg-custom').value,
        suggest: {
          clarify: q('#sg-clarify').checked,
          optimize: q('#sg-optimize').checked,
          risk: q('#sg-risk').checked,
          test: q('#sg-test').checked,
          a11y: q('#sg-a11y').checked,
          max: Number(q('#sg-max').value),
          timing: 'round-end',
        },
      };
      try {
        await post('/api/config', payload);
        if (typeof payload.streamLimitKB === 'number') S.streamLimitKB = payload.streamLimitKB;
        if (el.compactStyle) el.compactStyle.value = payload.compactStyle;
        setStatus('done', '设置已保存', '');
        toast('设置已生效', 'ok', 2200);
      } catch (err) {
        toast(`保存失败：${err.message}`, 'err');
      }
    });

    // 想法 7：浏览文件夹
    on('#pj-browse', 'click', () => this.openPicker(q('#pj-dir').value.trim()));
    this.bindPicker();

    // 想法 4：定位索引测试
    on('#loc-test', 'click', async () => {
      const query = q('#loc-query').value.trim();
      if (!query) return;
      try {
        const res = await get(`/api/locate?q=${encodeURIComponent(query)}`);
        q('#loc-result').innerHTML = res.hits.length
          ? res.hits
              .map((h) => `<div class="rag-hit"><b>${h.kind === 'page' ? '页面' : '组件'} · ${esc(h.name ?? '')}</b>${h.route ? ` <span class="muted">${esc(h.route)}</span>` : ''}<div><code>${esc(h.file)}</code> <span class="muted">得分 ${h.score}</span></div></div>`)
              .join('')
          : '<p class="muted">没有定位到文件（试试用页面名、组件名或路由路径）</p>';
      } catch (err) {
        toast(`定位失败：${err.message}`, 'err');
      }
    });
    on('#loc-rebuild', 'click', async () => {
      try {
        const res = await post('/api/projectmap');
        toast(`定位索引已重建：${res.stats.pages} 个页面 / ${res.stats.components} 个组件`, 'ok', 3600);
        const pages = (res.pages ?? []).slice(0, 8).map((p) => `<div class="rag-hit"><b>${esc(p.route ?? '')}</b> <code>${esc(p.file)}</code></div>`).join('');
        q('#loc-result').innerHTML = pages || '<p class="muted">没有识别到页面（可能不是 vue-router / react-router 项目）</p>';
      } catch (err) {
        toast(`重建失败：${err.message}`, 'err');
      }
    });

    on('#pj-apply', 'click', async () => {
      const dir = q('#pj-dir').value.trim();
      const mode = q('#pj-mode').value;
      try {
        const res = await post('/api/project', { dir, mode });
        q('#pj-current').textContent = `${res.projectDir}（${res.writeMode === 'staging' ? '暂存模式' : '直接写入'}）`;
        await refreshAll();
        toast('项目目录已切换', 'ok');
      } catch (err) {
        toast(`切换失败：${err.message}`, 'err');
      }
    });

    on('#st-rescan', 'click', async () => {
      try {
        const res = await post('/api/style');
        this.renderStyle(res.style);
        toast(`已重新扫描：${res.style.scanned} 个文件`, 'ok');
      } catch (err) {
        toast(`扫描失败：${err.message}`, 'err');
      }
    });

    on('#rag-test', 'click', async () => {
      const query = q('#rag-query').value.trim();
      if (!query) return;
      try {
        const res = await get(`/api/rag?q=${encodeURIComponent(query)}`);
        q('#rag-result').innerHTML = res.hits.length
          ? res.hits.map((h) => `<div class="rag-hit"><b>${esc(h.source)}:${h.startLine}</b><span class="muted"> ${h.score}</span><pre>${esc(h.text.slice(0, 300))}</pre></div>`).join('')
          : '<p class="muted">没有命中</p>';
      } catch (err) {
        toast(`检索失败：${err.message}`, 'err');
      }
    });
    on('#rag-rebuild', 'click', async () => {
      try {
        const res = await post('/api/rag/rebuild');
        toast(`索引已重建：${res.stats.chunks} 个片段`, 'ok');
      } catch (err) {
        toast(`重建失败：${err.message}`, 'err');
      }
    });

    on('#pf-add', 'click', async () => {
      try {
        const res = await post('/api/profiles', { profile: { name: '新配置', provider: 'deepseek', activate: false } });
        this.ctx.profiles = res.profiles;
        this.ctx.activeProfileId = res.activeProfileId;
        this.renderProfiles(res.profiles, res.activeProfileId, this.ctx.presets);
      } catch (err) {
        toast(`新增失败：${err.message}`, 'err');
      }
    });

    on('#sk-new', 'click', () => this.editSkill({ name: '', triggers: [], description: '', body: '' }));
    on('#sk-cancel', 'click', () => q('#sk-editor').classList.add('hidden'));
    on('#sk-save', 'click', async () => {
      const payload = {
        name: q('#sk-name').value.trim(),
        description: q('#sk-desc').value.trim(),
        triggers: q('#sk-triggers').value,
        body: q('#sk-body').value,
      };
      if (!payload.name || !payload.body.trim()) {
        toast('技能名和内容不能为空', 'warn', 2400);
        return;
      }
      try {
        const res = await post('/api/skills', payload);
        this.ctx.skills = res.skills;
        this.renderSkills(res.skills);
        q('#sk-editor').classList.add('hidden');
        toast(`技能「${payload.name}」已保存`, 'ok');
      } catch (err) {
        toast(`保存失败：${err.message}`, 'err');
      }
    });
  },

  renderProfiles(profiles, activeProfileId, presets) {
    const box = el.modal.querySelector('#pf-list');
    if (!box) return;
    box.innerHTML = '';
    for (const p of profiles) {
      const active = p.id === activeProfileId;
      const row = document.createElement('div');
      row.className = `pf-row${active ? ' active' : ''}`;
      row.innerHTML =
        `<label class="check"><input type="radio" name="pf" ${active ? 'checked' : ''} /></label>` +
        `<input class="pf-name" value="${esc(p.name)}" />` +
        `<select class="pf-provider">${Object.entries(presets).map(([k, v]) => `<option value="${k}"${k === p.provider ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}</select>` +
        `<input class="pf-model" value="${esc(p.model)}" placeholder="模型名" />` +
        `<input class="pf-base" value="${esc(p.baseUrl)}" placeholder="Base URL" />` +
        `<input class="pf-key" type="password" placeholder="${p.apiKeySet ? `已保存 ${esc(p.apiKeyHint)}（留空不改）` : 'API Key'}" />` +
        `<button class="btn ghost small pf-del" title="删除">✕</button>`;
      const collect = () => ({
        id: p.id,
        name: row.querySelector('.pf-name').value.trim() || p.name,
        provider: row.querySelector('.pf-provider').value,
        model: row.querySelector('.pf-model').value.trim(),
        baseUrl: row.querySelector('.pf-base').value.trim(),
        apiKey: row.querySelector('.pf-key').value.trim(),
      });
      const save = async (activate) => {
        try {
          const res = await post('/api/profiles', { profile: { ...collect(), activate } });
          this.ctx.profiles = res.profiles;
          this.ctx.activeProfileId = res.activeProfileId;
          this.renderProfiles(res.profiles, res.activeProfileId, presets);
          await refreshAll();
        } catch (err) {
          toast(`保存失败：${err.message}`, 'err');
        }
      };
      row.querySelector('input[name=pf]').addEventListener('change', () => save(true));
      row.querySelector('.pf-provider').addEventListener('change', () => {
        const preset = presets[row.querySelector('.pf-provider').value];
        if (preset) {
          row.querySelector('.pf-model').value = preset.model ?? '';
          row.querySelector('.pf-base').value = preset.baseUrl ?? '';
        }
      });
      row.querySelectorAll('input,select').forEach((node) => node.addEventListener('change', () => save(false)));
      row.querySelector('.pf-del').addEventListener('click', async () => {
        try {
          const res = await post('/api/profiles/delete', { id: p.id });
          this.ctx.profiles = res.profiles;
          this.ctx.activeProfileId = res.activeProfileId;
          this.renderProfiles(res.profiles, res.activeProfileId, presets);
          await refreshAll();
        } catch (err) {
          toast(`删除失败：${err.message}`, 'err');
        }
      });
      box.appendChild(row);
    }
  },

  renderStyle(style) {
    const box = el.modal.querySelector('#st-result');
    if (!box) return;
    if (!style) {
      box.innerHTML = '<p class="muted">还没扫描过。点「重新扫描」读一遍当前项目的代码风格。</p>';
      return;
    }
    const rows = [
      ['扫描文件', `${style.scanned} / ${style.totalFiles}`],
      ['缩进', style.indent ?? '—'],
      ['引号', style.quotes ?? '—'],
      ['分号', style.semicolons === null ? '—' : style.semicolons ? '写' : '不写'],
      ['注释语言', style.commentLang ?? '—'],
      ['命名', style.symbolNaming ?? '—'],
      ['文件名', style.fileNaming ?? '—'],
      ['模块', style.moduleStyle ?? '—'],
      ['技术栈', (style.frameworks ?? []).join(' / ') || '—'],
      ['有测试', style.hasTests ? '是' : '否'],
    ];
    box.innerHTML =
      `<div class="kv">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` +
      (style.summary ? `<pre class="style-summary">${esc(style.summary)}</pre>` : '<p class="muted">信号不足，暂时不会注入风格约束。</p>');
  },

  renderProjects() {
    const box = el.modal.querySelector('#pj-list');
    if (!box) return;
    const list = this.ctx.projects?.list ?? [];
    if (!list.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML =
      '<p class="muted tiny">最近使用过的目标目录（点击即切换，暂存模式更安全）：</p>' +
      list.map((p) => `<div class="pj-item" data-dir="${esc(p.dir)}"><code>${esc(p.dir)}</code><span class="muted">${esc(p.mode ?? '')}</span></div>`).join('');
    box.querySelectorAll('.pj-item').forEach((node) => {
      node.addEventListener('click', async () => {
        const dir = node.dataset.dir;
        el.modal.querySelector('#pj-dir').value = dir;
        el.modal.querySelector('#pj-mode').value = 'staging';
        try {
          await post('/api/project', { dir, mode: 'staging' });
          await refreshAll();
          toast(`已切换到 ${dir}`, 'ok');
        } catch (err) {
          toast(`切换失败：${err.message}`, 'err');
        }
      });
    });
  },

  renderSkills(skills) {
    const box = el.modal.querySelector('#sk-list');
    if (!box) return;
    if (!skills.length) {
      box.innerHTML = '<p class="muted">还没有技能。技能就是一段会按触发词自动注入模型的规范说明（比如团队的代码风格、组件库用法）。</p>';
      return;
    }
    box.innerHTML = '';
    for (const s of skills) {
      const row = document.createElement('div');
      row.className = 'sk-row';
      row.innerHTML =
        `<div class="sk-main"><b>${esc(s.name)}</b><span class="muted">${esc(s.description ?? '')}</span>` +
        `<div class="sk-triggers">${(s.triggers ?? []).map((t) => `<span class="chip tiny">${esc(t)}</span>`).join('') || '<span class="muted tiny">无触发词（始终生效）</span>'}</div></div>` +
        `<div class="sk-actions"><button class="btn ghost small sk-edit">编辑</button><button class="btn ghost small sk-del">删除</button></div>`;
      row.querySelector('.sk-edit').addEventListener('click', () => this.editSkill(s));
      row.querySelector('.sk-del').addEventListener('click', async () => {
        try {
          const res = await post('/api/skills/delete', { name: s.name });
          this.ctx.skills = res.skills;
          this.renderSkills(res.skills);
          toast(`已删除技能「${s.name}」`, 'ok');
        } catch (err) {
          toast(`删除失败：${err.message}`, 'err');
        }
      });
      box.appendChild(row);
    }
  },

  editSkill(s) {
    const q = (x) => el.modal.querySelector(x);
    q('#sk-editor').classList.remove('hidden');
    q('#sk-name').value = s.name ?? '';
    q('#sk-desc').value = s.description ?? '';
    q('#sk-triggers').value = (s.triggers ?? []).join(', ');
    q('#sk-body').value = s.body ?? '';
    q('#sk-name').focus();
  },

  /* ============================ 目录选择弹窗（想法 7） ============================ */

  pickerDir: '',

  async openPicker(dir) {
    if (!el.pickerModal) return;
    el.pickerModal.classList.remove('hidden');
    await this.browse(dir ?? this.pickerDir ?? '');
  },

  closePicker() {
    el.pickerModal?.classList.add('hidden');
  },

  async browse(dir) {
    try {
      const data = await get(`/api/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);
      this.pickerDir = data.dir;
      el.pickerPath.value = data.dir;
      el.pickerHint.textContent = data.isProject
        ? '看起来是个项目根目录（检测到 package.json 或 .git）'
        : '继续往下找，或者直接点下面「用这个目录」';
      el.pickerDrives.innerHTML = (data.drives ?? [])
        .map((d) => `<button class="btn ghost tiny pick-drive" data-dir="${esc(d)}">${esc(d)}</button>`)
        .join('');
      el.pickerDrives.querySelectorAll('.pick-drive').forEach((b) => b.addEventListener('click', () => this.browse(b.dataset.dir)));
      el.pickerList.innerHTML = (data.dirs ?? [])
        .map((d) => `<li class="picker-item" data-dir="${esc(d.path)}"><span class="pi-icon">📁</span><span class="pi-name">${esc(d.name)}</span></li>`)
        .join('') || '<li class="muted" style="padding:8px">（没有子目录）</li>';
      el.pickerList.querySelectorAll('.picker-item').forEach((li) => {
        li.addEventListener('click', () => this.browse(li.dataset.dir));
      });
      el.pickerUp.disabled = !data.parent;
      el.pickerUp.dataset.parent = data.parent ?? '';
    } catch (err) {
      toast(`读取目录失败：${err.message}`, 'err', 5000);
    }
  },

  async usePickerDir(mode) {
    const dir = el.pickerPath.value.trim();
    if (!dir) return;
    try {
      const res = await post('/api/project', { dir, mode });
      this.closePicker();
      toast(`已切换到 ${res.projectDir}（${res.writeMode === 'staging' ? '暂存模式' : '直接写入'}）`, 'ok', 4200);
    } catch (err) {
      toast(`切换失败：${err.message}`, 'err', 6000);
    }
  },

  bindPicker() {
    if (!el.pickerModal || this.pickerBound) return;
    this.pickerBound = true;
    el.pickerClose.addEventListener('click', () => this.closePicker());
    el.pickerModal.addEventListener('click', (e) => {
      if (e.target === el.pickerModal) this.closePicker();
    });
    el.pickerUp.addEventListener('click', () => {
      const p = el.pickerUp.dataset.parent;
      if (p) this.browse(p);
    });
    el.pickerGo.addEventListener('click', () => this.browse(el.pickerPath.value.trim()));
    el.pickerPath.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.browse(el.pickerPath.value.trim());
    });
    el.pickerUse.addEventListener('click', () => this.usePickerDir('staging'));
    el.pickerDirect.addEventListener('click', () => {
      if (window.confirm('直接写入模式下，AI 生成的内容会立刻改你的项目文件（不打草稿）。确定吗？')) this.usePickerDir('direct');
    });
  },

  /* ============================ 命令面板 ============================ */

  paletteItems: [],
  paletteIndex: 0,

  openPalette() {
    const files = Object.keys(S.files).length ? Object.keys(S.files) : S.tree ? flattenFiles(S.tree) : [];
    if (!files.length) {
      toast('还没有文件可以跳转', 'warn', 2000);
      return;
    }
    el.palette.classList.remove('hidden');
    el.paletteInput.value = '';
    this.paletteIndex = 0;
    this.renderPalette(files);
    el.paletteInput.focus();
  },

  closePalette() {
    el.palette.classList.add('hidden');
  },

  renderPalette(files) {
    const q = el.paletteInput.value.trim().toLowerCase();
    this.paletteItems = files
      .filter((f) => !q || f.toLowerCase().includes(q))
      .sort((a, b) => {
        const ai = a.toLowerCase().indexOf(q);
        const bi = b.toLowerCase().indexOf(q);
        return ai === bi ? a.length - b.length : ai - bi;
      })
      .slice(0, 40);
    this.paletteIndex = Math.min(this.paletteIndex, Math.max(0, this.paletteItems.length - 1));
    el.paletteList.innerHTML = this.paletteItems
      .map((p, i) => {
        const dir = p.split('/').slice(0, -1).join('/');
        return `<li class="palette-item${i === this.paletteIndex ? ' active' : ''}" data-path="${esc(p)}">${
          dir ? `<span class="p-dir">${esc(dir)}/</span>` : ''
        }<span>${esc(p.split('/').pop())}</span></li>`;
      })
      .join('');
    el.paletteList.querySelectorAll('.palette-item').forEach((li) => {
      li.addEventListener('click', () => {
        openFile(li.dataset.path);
        this.closePalette();
      });
    });
  },

  bindPalette() {
    if (!el.palette) return;
    el.paletteInput.addEventListener('input', () => {
      this.paletteIndex = 0;
      const all = Object.keys(S.files).length ? Object.keys(S.files) : flattenFiles(S.tree ?? {});
      this.renderPalette(all);
    });
    el.paletteInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.paletteIndex = Math.min(this.paletteItems.length - 1, this.paletteIndex + 1);
        this.renderPalette(this.paletteItems);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.paletteIndex = Math.max(0, this.paletteIndex - 1);
        this.renderPalette(this.paletteItems);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = this.paletteItems[this.paletteIndex];
        if (pick) {
          openFile(pick);
          this.closePalette();
        }
      }
    });
    el.palette.addEventListener('click', (e) => {
      if (e.target === el.palette) this.closePalette();
    });
  },
};

function flattenFiles(node) {
  return (node.children ?? []).flatMap((c) => (c.type === 'file' ? [c.path] : flattenFiles(c)));
}

async function refreshAll() {
  // 想法 15：不再把整个项目的文件内容一次性拉下来（大项目会卡死），只刷新树与元数据
  const tree = await get('/api/tree');
  renderTree(tree.tree);
  updateWorkspaceStats();
  const pending = await get('/api/pending');
  renderPending(pending);
  const versions = await get('/api/versions');
  renderVersions(versions);
  // 当前打开的文件重新拉一次；其它文件等用户点开时再按需加载
  if (S.current) {
    await pullFile(S.current);
    await renderCode();
  } else {
    const first = flattenFiles(tree.tree ?? {})[0];
    if (first) await openFile(first);
  }
}
