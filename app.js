/* 架构板 Archboard —— 单文件实现（无依赖）
 * 作者：maidong · github.com/Mr-Maidong · 15557111679@163.com
 * 模型：elements 数组，坐标为画布逻辑坐标（默认 2560 x 1160）
 * 渲染：DOM 定位 + 一层 SVG 画箭头
 *
 * 这份源码没有压缩、没有转译、没有 source map —— 你读到的就是运行的逻辑。
 * 导出的 .archboard / JSON 里也会带上 AUTHOR，便于追溯出处。
 */
(() => {
  'use strict';

  // 出处信息：写进导出文件与控制台，界面里不显示
  const AUTHOR = Object.freeze({
    app: 'Archboard',
    name: 'maidong',
    github: 'Mr-Maidong',
    email: '15557111679@163.com',
    homepage: 'https://github.com/Mr-Maidong',
    version: 1,
    sig: 'AB-FP-8d83683e',
  });

  /* ── 出处指纹 ────────────────────────────────────────────────────────────
     标识串 → FNV-1a 32 位 → "AB-FP-xxxxxxxx"，是可复算的哈希，不是随手编的
     随机串：
         "maidong|Mr-Maidong|15557111679@163.com" → AB-FP-8d83683e

     任何人都能用下面这十行重新算一遍来验证出处；反过来，如果这份代码出现
     在别处而这里写着别人的名字，那就是被整体搬走的。指纹不影响任何功能。 */
  const SIG_SOURCE = 'maidong|Mr-Maidong|15557111679@163.com';
  const SIG = 'AB-FP-8d83683e';
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (const b of new TextEncoder().encode(str)) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
  function checkSig() {
    const want = SIG.slice(6);
    const got = fnv1a(SIG_SOURCE);
    if (got !== want) console.warn('[Archboard] 出处指纹不匹配：', SIG_SOURCE, '→', got, '≠', want);
    return got === want;
  }

  const W = 2560, H = 1160;
  const LS_KEY = 'arch-editor-v1';
  const FONT = '-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif';

  const $ = (s, r = document) => r.querySelector(s);
  const stage = $('#stage');
  const layer = $('#layer');
  const svg = $('#arrows');
  const arrowLayer = $('#arrowLayer');
  const arrowPreviewLayer = $('#arrowPreviewLayer');
  const anchorsBox = $('#anchors');
  const guidesBox = $('#guides');
  const marquee = $('#marquee');
  const viewport = $('#viewport');
  const inspector = $('#inspector');

  let state = { elements: [], bg: null, canvases: [], layers: [] };
  let sel = new Set();
  let selCanvas = null;          // 当前选中的画布 id
  const enteredGroup = new Set(); // 双击进入的图层（组），进入后可按单元素操作
  let showMinimap = true;
  let tool = 'select';
  let zoom = 0.5, panX = 0, panY = 0;
  const nodes = new Map();      // id -> DOM
  const imgCache = new Map();   // src -> HTMLImageElement
  let history = [], histIndex = -1;
  let drag = null;
  let snapOn = true;
  const arrowPick = { from: null };

  /* ------------------------------------------------------------------ 工具 */
  let seq = 1;
  const uid = (p = 'e') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const round = (v) => Math.round(v * 100) / 100;

  function getEl(id) { return state.elements.find((e) => e.id === id); }
  function bounds(e) { return { x: e.x, y: e.y, w: e.w, h: e.h }; }
  function unionBounds(list) {
    if (!list.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const e of list) {
      x1 = Math.min(x1, e.x); y1 = Math.min(y1, e.y);
      x2 = Math.max(x2, e.x + e.w); y2 = Math.max(y2, e.y + e.h);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  const selEls = () => state.elements.filter((e) => sel.has(e.id));

  function loadImage(src) {
    if (imgCache.has(src)) return imgCache.get(src);
    const im = new Image();
    im.src = src;
    imgCache.set(src, im);
    return im;
  }

  /* ---------------------------------------------------------------- 历史 */
  function snapshot() {
    return JSON.stringify({
      elements: state.elements, bg: state.bg,
      canvases: state.canvases || [], layers: state.layers || [],
    });
  }
  function pushHistory() {
    const s = snapshot();
    if (history[histIndex] === s) return;
    history = history.slice(0, histIndex + 1);
    history.push(s);
    if (history.length > 60) history.shift();
    histIndex = history.length - 1;
    updateHistButtons();
  }
  function restore(json) {
    const d = JSON.parse(json);
    state.elements = d.elements || [];
    state.bg = d.bg || null;
    state.canvases = d.canvases || [];
    state.layers = d.layers || [];
    sel.clear(); selCanvas = null;
    migrateModel();
    renderAll();
    saveSoon();
  }
  // 修改前 pushHistory() 记录旧态；修改完成后再调 commit() 记录新态，
  // 否则撤销之后 redo 没有可前进的目标。
  function commit() { pushHistory(); }
  function undo() { if (histIndex > 0) { histIndex--; restore(history[histIndex]); updateHistButtons(); } }
  function redo() { if (histIndex < history.length - 1) { histIndex++; restore(history[histIndex]); updateHistButtons(); } }
  function updateHistButtons() {
    $('#undoBtn').disabled = histIndex <= 0;
    $('#redoBtn').disabled = histIndex >= history.length - 1;
  }
  const setStatus = (t) => { $('#status').textContent = t || ''; };
  let toastTimer = null;
  function toast(msg, ms = 2800) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  }


  /* ============================================================ 画布 / 图层 */
  const canvases = () => state.canvases || (state.canvases = []);
  const layers = () => state.layers || (state.layers = []);
  const canvasById = (id) => canvases().find((c) => c.id === id) || null;
  const layerById = (id) => layers().find((l) => l.id === id) || null;

  const canvasRect = (c) => ({ x: c.x, y: c.y, w: c.w, h: c.h });
  const inside = (b, r) =>
    b.x >= r.x - 0.5 && b.y >= r.y - 0.5 &&
    b.x + b.w <= r.x + r.w + 0.5 && b.y + b.h <= r.y + r.h + 0.5;

  // 元素归属哪个画布：必须「完整落在画布内」才算，拖出去就自动脱离。
  // 多个画布嵌套时取面积最小的那个。
  // 取消画布选中时必须重绘画布层，否则虚线手柄会残留在画面上
  function dropCanvasSel() {
    if (selCanvas == null) return false;
    selCanvas = null;
    renderCanvases();
    renderInspector();     // 选中元素时面板必须立刻切走，否则会停在「画布」
    return true;
  }

  // 某个点落在哪个画布上：取面积最小的，支持画布嵌套
  function canvasAtPoint(p) {
    let best = null;
    for (const c of canvases()) {
      if (c.visible === false) continue;
      if (p.x < c.x || p.y < c.y || p.x > c.x + c.w || p.y > c.y + c.h) continue;
      if (!best || c.w * c.h < best.w * best.h) best = c;
    }
    return best;
  }

  function canvasOfElement(e) {
    let best = null;
    for (const c of canvases()) {
      if (c.visible === false) continue;
      if (!inside(e, canvasRect(c))) continue;
      if (!best || c.w * c.h < best.w * best.h) best = c;
    }
    return best;
  }

  const membersOf = (l) => state.elements.filter((e) => e.layerId === l.id && e.type !== 'arrow');
  const canvasOfLayer = (l) => {
    const mem = membersOf(l);
    for (const m of mem) { const c = canvasOfElement(m); if (c) return c; }
    return null;
  };

  // 可见 / 锁定：元素自身的标记，叠加所属图层的标记
  function isVisible(e) {
    if (e.visible === false) return false;
    const l = e.layerId ? layerById(e.layerId) : null;
    if (l && l.visible === false) return false;
    return true;
  }
  function isLocked(e) {
    if (e.locked === true) return true;
    const l = e.layerId ? layerById(e.layerId) : null;
    return !!(l && l.locked === true);
  }
  const selectable = (e) => isVisible(e) && !isLocked(e);

  function canvasHandlesHTML() {
    return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
      .map((h) => `<div class="cv-handle" data-h="${h}"></div>`).join('');
  }

  // 拖动/缩放画布时只改这一个元素的几何，绝不重建 DOM。
  // 重建会让背景图（data URL）每帧重新解码，整片画布连同上面的元素一起闪。
  function applyCanvasBox(c) {
    const box = $('#canvasLayer');
    const d = box && box.querySelector(`.canvas-region[data-cid="${c.id}"]`);
    if (!d) { renderCanvases(); return; }
    d.style.left = c.x + 'px';
    d.style.top = c.y + 'px';
    d.style.width = Math.max(20, c.w) + 'px';
    d.style.height = Math.max(20, c.h) + 'px';
    const nm = d.querySelector('.cv-name');
    const txt = `${c.name || '画布'} · ${Math.round(c.w)}×${Math.round(c.h)}`;
    if (nm && nm.textContent !== txt) nm.textContent = txt;   // 纯移动时不写文本，避免每帧改动 DOM
  }

  function renderCanvases() {
    const box = $('#canvasLayer');
    if (!box) return;
    box.innerHTML = '';
    for (const c of canvases()) {
      const d = document.createElement('div');
      d.className = 'canvas-region' + (selCanvas === c.id ? ' sel' : '') + (c.locked ? ' locked' : '');
      d.dataset.cid = c.id;
      d.style.left = c.x + 'px';
      d.style.top = c.y + 'px';
      d.style.width = Math.max(20, c.w) + 'px';
      d.style.height = Math.max(20, c.h) + 'px';
      if (c.visible === false) d.style.display = 'none';
      if (c.bgColor && c.bgColor !== 'transparent') d.style.background = c.bgColor;
      if (c.bgImage) {
        d.style.backgroundImage = `url("${c.bgImage}")`;
        d.style.backgroundSize = c.bgFit === 'fill' ? '100% 100%' : 'cover';
        d.style.backgroundPosition = 'center';
      }
      if (!c.bgColor && !c.bgImage) d.classList.add('plain');
      d.innerHTML = `<div class="cv-name">${esc(c.name || '画布')} · ${Math.round(c.w)}×${Math.round(c.h)}</div>`
        + (selCanvas === c.id ? canvasHandlesHTML() : '');
      box.appendChild(d);
    }
  }

  /* ------------------------------------------------------------ 图层树渲染 */
  const ICON = {
    canvas: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2.6" width="12" height="10.8" rx="1.6"/><path d="M2 5.6h12"/></svg>',
    layer: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 2.2 14 5.6 8 9 2 5.6z"/><path d="M2 8.6 8 12l6-3.4"/></svg>',
    panel: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="4" width="12" height="8" rx="1.4"/></svg>',
    card: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.2" y="4.4" width="9.6" height="7.2" rx="1.2"/></svg>',
    text: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.5 4h9M8 4v8.5M6 12.5h4"/></svg>',
    image: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.4"/><circle cx="6" cy="6.6" r="1.1"/><path d="m3.4 11.6 3-2.8 2.2 2 1.8-1.6 2.2 2"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 12.5 13.5 3.5"/><path d="M9 3.5h4.5V8"/></svg>',
  };
  const EYE = {
    on: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.9"/></svg>',
    off: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.4 2.4l11.2 11.2"/><path d="M6.2 4.2A8.8 8.8 0 0 1 8 3.8c4 0 6.4 4.2 6.4 4.2a12 12 0 0 1-2.1 2.7M4.1 5.9A12.2 12.2 0 0 0 1.6 8S4 12.2 8 12.2c.7 0 1.3-.1 1.9-.3"/></svg>',
  };
  const LOCK = {
    on: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4"/><path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7"/></svg>',
    off: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4"/><path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.6-.8"/></svg>',
  };
  const TWIST = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5 5 6.5 8 3.5"/></svg>';

  const collapsedSet = new Set();

  function rowHTML(opts) {
    const { id, kind, name, depth, hasKids, hidden, locked, selected, sub, parent, tip } = opts;
    const kidCls = hasKids ? (collapsedSet.has(id) ? 'lp-twist collapsed' : 'lp-twist') : 'lp-twist leaf';
    return `<div class="lp-row ${kind}${selected ? ' sel' : ''}${hidden ? ' hidden-node' : ''}${locked ? ' locked-node' : ''}"
        data-node="${id}" data-kind="${kind}"${parent ? ` data-parent="${parent}"` : ''}${tip ? ` title="${tip}"` : ''} style="padding-left:${4 + depth * 12}px">
      <span class="${kidCls}" data-act="twist" data-id="${id}">${hasKids ? TWIST : TWIST}</span>
      <span class="lp-ico">${ICON[kind] || ICON.card}</span>
      <span class="lp-name" data-id="${id}" title="${esc(name)} · 双击重命名">${esc(name)}</span>
      ${sub ? `<span class="lp-sub">${esc(sub)}</span>` : ''}
      <button class="lp-act${hidden ? ' on' : ''}" data-act="vis" data-id="${id}" data-kind="${kind}" title="显示 / 隐藏">${hidden ? EYE.off : EYE.on}</button>
      <button class="lp-act${locked ? ' on' : ''}" data-act="lock" data-id="${id}" data-kind="${kind}" title="锁定 / 解锁">${locked ? LOCK.on : LOCK.off}</button>
    </div>`;
  }

  function renderLayerTree() {
    const box = $('#layerTree');
    if (!box) return;
    const rows = [];
    const pushEl = (e, depth, parent) => {
      const kind = e.type === 'arrow' ? 'arrow' : e.type;
      const TYPE_CN = { panel: '面板', card: '卡片', text: '文字', image: '图片', arrow: '连线' };
      const label = e.label || e.title || e.text || TYPE_CN[e.type] || '元素';
      rows.push(rowHTML({
        id: e.id, kind: e.type === 'arrow' ? 'arrow' : kind, depth,
        name: String(label).slice(0, 40),
        hasKids: false, hidden: !isVisible(e), locked: isLocked(e),
        selected: sel.has(e.id), parent, tip: '拖动可调整上下顺序',
      }));
    };
    const pushLayer = (l, depth) => {
      const mem = membersOf(l);
      rows.push(rowHTML({
        id: l.id, kind: 'layer', depth, name: l.name || '图层',
        hasKids: mem.length > 0, hidden: l.visible === false, locked: l.locked === true,
        selected: mem.length > 0 && mem.every((m) => sel.has(m.id)),
        sub: mem.length ? String(mem.length) : '',
      }));
      if (!collapsedSet.has(l.id)) for (const m of mem) pushEl(m, depth + 1, 'L:' + l.id);
    };

    const usedLayers = new Set();
    for (const c of canvases()) {
      const inCanvas = state.elements.filter((e) => e.type !== 'arrow' && canvasOfElement(e) === c);
      rows.push(rowHTML({
        id: c.id, kind: 'canvas', depth: 0, name: c.name || '画布',
        hasKids: inCanvas.length > 0, hidden: c.visible === false, locked: c.locked === true,
        selected: selCanvas === c.id, sub: `${Math.round(c.w)}×${Math.round(c.h)}`,
      }));
      if (collapsedSet.has(c.id)) continue;
      for (const l of layers()) {
        if (usedLayers.has(l.id)) continue;
        if (canvasOfLayer(l) !== c) continue;
        usedLayers.add(l.id); pushLayer(l, 1);
      }
      for (const e of inCanvas) {
        if (e.layerId && layerById(e.layerId)) continue;
        pushEl(e, 1, 'C:' + c.id);
      }
    }
    // 不属于任何画布的图层 → 也在第一层展示
    for (const l of layers()) {
      if (usedLayers.has(l.id)) continue;
      usedLayers.add(l.id); pushLayer(l, 0);
    }
    for (const e of state.elements) {
      if (e.type === 'arrow') continue;
      if (e.layerId && layerById(e.layerId)) continue;
      if (canvasOfElement(e)) continue;
      pushEl(e, 0, 'root');
    }

    box.innerHTML = rows.join('') || '<div class="lp-empty">还没有内容</div>';
    const cnt = $('#layerCount');
    if (cnt) cnt.textContent = `${canvases().length} 画布 · ${layers().length} 图层`;
  }

  // 同一分组内换序：按显示顺序重排数组并重编 z。
  // 约定：第一行在最底层，往下依次向前——和现有数据的层级关系一致。
  function reorderGroup(orderedIds) {
    const ids = new Set(orderedIds);
    const pos = [];
    state.elements.forEach((e, i) => { if (ids.has(e.id)) pos.push(i); });
    if (pos.length !== orderedIds.length) return false;
    // 先取快照再回写：一边写数组一边 getEl 会把还没复制的元素写丢
    const members = orderedIds.map(getEl);
    if (members.some((e) => !e)) return false;
    const zMin = Math.min(...members.map((e) => (e.z == null ? 0 : e.z)));
    orderedIds.forEach((id, k) => { state.elements[pos[k]] = members[k]; });
    members.forEach((e, i) => { e.z = zMin + i; });
    return true;
  }

  // 画布上选中 → 图层树跟着亮，并把它滚进可视区。
  // 若元素所在画布/图层是折叠的，先展开（否则树里根本没有这一行）。
  function revealTreeSelection() {
    let need = false;
    for (const id of sel) {
      const e = getEl(id);
      if (!e) continue;
      const c = canvasOfElement(e);
      if (c && collapsedSet.has(c.id)) { collapsedSet.delete(c.id); need = true; }
      if (e.layerId) {
        const l = layerById(e.layerId);
        if (l && collapsedSet.has(l.id)) { collapsedSet.delete(l.id); need = true; }
      }
    }
    if (need) renderLayerTree();
    updateTreeSelection();
    const box = $('#layerTree');
    const row = box && box.querySelector('.lp-row.sel');
    if (!box || !row) return;
    const rb = row.getBoundingClientRect(), bb = box.getBoundingClientRect();
    if (rb.top < bb.top) box.scrollTop -= bb.top - rb.top + 8;
    else if (rb.bottom > bb.bottom) box.scrollTop += rb.bottom - bb.bottom + 8;
  }

  // 只更新行的选中态，不重建树：重建会让双击的第二次点击落到已脱离的节点上
  function updateTreeSelection() {
    for (const row of document.querySelectorAll('#layerTree .lp-row')) {
      const id = row.dataset.node;
      const kind = row.dataset.kind;
      let on = false;
      if (kind === 'canvas') on = selCanvas === id;
      else if (kind === 'layer') {
        const l = layerById(id);
        const mem = l ? membersOf(l) : [];
        on = mem.length > 0 && mem.every((m) => sel.has(m.id));
      } else on = sel.has(id);
      row.classList.toggle('sel', on);
    }
  }

  /* --------------------------------------------------------------- 鸟瞰图 */
  function worldBounds() {
    let x0 = 0, y0 = 0, x1 = W, y1 = H, any = false;
    const take = (b) => {
      if (!any) { x0 = b.x; y0 = b.y; x1 = b.x + b.w; y1 = b.y + b.h; any = true; }
      else {
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
      }
    };
    for (const c of canvases()) take(canvasRect(c));
    for (const e of state.elements) {
      if (e.type === 'arrow' || !isVisible(e)) continue;
      take(bounds(e));
    }
    if (!any) return { x: 0, y: 0, w: W, h: H };
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  let mmScale = 1, mmOff = { x: 0, y: 0 };

  function renderMinimap() {
    const mm = $('#minimap'), cv = $('#mmCanvas');
    if (!mm || !cv) return;
    const block = $('#mmBlock');
    if (!showMinimap) { mm.classList.add('hidden'); if (block) block.classList.add('off'); return; }
    if (block) block.classList.remove('off');
    mm.classList.remove('hidden');
    const r = mm.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.round(r.width * dpr), bh = Math.round(r.height * dpr);
    if (cv.width !== bw) cv.width = bw;      // 只在真的变尺寸时重建位图，
    if (cv.height !== bh) cv.height = bh;    // 每帧重建会强制重分配 + 全清
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);

    // 范围 = 内容 ∪ 当前视口，保证蓝色视口框始终完整可见而不是被裁掉
    const wb = worldBounds();
    const vr0 = viewport.getBoundingClientRect();
    const vx0 = -panX / zoom, vy0 = -panY / zoom, vw0 = vr0.width / zoom, vh0 = vr0.height / zoom;
    const x0 = Math.min(wb.x, vx0), y0 = Math.min(wb.y, vy0);
    const x1 = Math.max(wb.x + wb.w, vx0 + vw0), y1 = Math.max(wb.y + wb.h, vy0 + vh0);
    const pad = 8;
    const s = Math.min((r.width - pad * 2) / Math.max(1, x1 - x0), (r.height - pad * 2) / Math.max(1, y1 - y0));
    mmScale = s;
    mmOff = {
      x: (r.width - (x1 - x0) * s) / 2 - x0 * s,
      y: (r.height - (y1 - y0) * s) / 2 - y0 * s,
    };
    const px = (x) => mmOff.x + x * s;
    const py = (y) => mmOff.y + y * s;

    // 画布
    for (const c of canvases()) {
      if (c.visible === false) continue;
      ctx.fillStyle = 'rgba(255,255,255,.09)';
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 1;
      ctx.fillRect(px(c.x), py(c.y), c.w * s, c.h * s);
      ctx.strokeRect(px(c.x) + .5, py(c.y) + .5, c.w * s, c.h * s);
    }
    // 元素
    for (const e of state.elements) {
      if (e.type === 'arrow' || !isVisible(e)) continue;
      const fill = e.type === 'panel' ? 'rgba(230,230,230,.55)'
        : e.type === 'card' ? 'rgba(210,210,210,.42)'
        : e.type === 'text' ? 'rgba(240,240,240,.5)'
        : 'rgba(200,200,200,.4)';
      ctx.fillStyle = fill;
      ctx.fillRect(px(e.x), py(e.y), Math.max(1, e.w * s), Math.max(1, e.h * s));
    }
    // 视口框：只画在 canvas 上，并裁剪到鸟瞰图范围内，
    // 免得视野比内容还大时矩形跑到边框外面
    const vr = viewport.getBoundingClientRect();
    const vx = -panX / zoom, vy = -panY / zoom, vw = vr.width / zoom, vh = vr.height / zoom;
    const bx = Math.max(0, px(vx));
    const by = Math.max(0, py(vy));
    const bx2 = Math.min(r.width, px(vx + vw));
    const by2 = Math.min(r.height, py(vy + vh));
    if (bx2 - bx > 1 && by2 - by > 1) {
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx + .5, by + .5, bx2 - bx - 1, by2 - by - 1);
    }
  }

  // 鸟瞰图点击/拖动 → 视图瞬移
  function minimapGoto(ev) {
    const mm = $('#minimap');
    const r = mm.getBoundingClientRect();
    const wx = (ev.clientX - r.left - mmOff.x) / mmScale;
    const wy = (ev.clientY - r.top - mmOff.y) / mmScale;
    const vr = viewport.getBoundingClientRect();
    panX = vr.width / 2 - wx * zoom;
    panY = vr.height / 2 - wy * zoom;
    applyView();
    renderMinimap();
  }

  /* ------------------------------------------------------- 画布选中 / 变换 */
  function selectCanvas(id) {
    selCanvas = id;
    sel.clear();
    syncSelection();
    renderCanvases();
    renderLayerTree();
    renderInspector();
  }

  // 面板里点画布：原地更新即可，保持行 DOM 稳定以支持双击改名
  function selectCanvasInPlace(id) {
    selCanvas = id;
    sel.clear();
    syncSelection();
    renderCanvases();
    updateTreeSelection();
    renderInspector();
  }

  function startCanvasMove(ev, c) {
    if (c.locked) { setStatus('画布已锁定，先在检查器里解锁'); return; }
    const start = toStage(ev.clientX, ev.clientY);
    const o = { x: c.x, y: c.y };
    let moved = false;
    // 拖动期间用 transform 走合成层：背景图不会被重新布局/重绘，
    // 松手时再落回 left/top（数据与 DOM 保持一致）
    const el = () => document.querySelector(`.canvas-region[data-cid="${c.id}"]`);
    const move = (e2) => {
      const p = toStage(e2.clientX, e2.clientY);
      const dx = p.x - start.x, dy = p.y - start.y;
      if (!moved && Math.abs(dx) * zoom < 3 && Math.abs(dy) * zoom < 3) return;   // 抖动不算拖动
      if (!moved) { moved = true; pushHistory(); }
      c.x = round(o.x + dx);
      c.y = round(o.y + dy);
      const d = el();
      if (d) {
        // 位移对齐到设备像素：不落在半像素上，边界/细线不会被反复重新抗锯齿
        const dpr = window.devicePixelRatio || 1;
        const unit = zoom * dpr;
        const snap = (v) => Math.round(v * unit) / unit;
        d.style.willChange = 'transform';
        d.style.transform = `translate(${snap(c.x - o.x)}px, ${snap(c.y - o.y)}px)`;
      } else {
        applyCanvasBox(c);
      }
      renderInspectorLight();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const d = el();
      if (d) { d.style.transform = ''; d.style.willChange = ''; }
      if (moved) { applyCanvasBox(c); saveSoon(); commit(); renderAll(); renderMinimap(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    ev.stopPropagation();
  }

  function startCanvasResize(ev, c, dir) {
    if (c.locked) { setStatus('画布已锁定，先在检查器里解锁'); return; }
    const start = toStage(ev.clientX, ev.clientY);
    const o = { x: c.x, y: c.y, w: c.w, h: c.h };
    pushHistory();
    const move = (e2) => {
      const p = toStage(e2.clientX, e2.clientY);
      const dx = p.x - start.x, dy = p.y - start.y;
      let x = o.x, y = o.y, w = o.w, h = o.h;
      if (dir.includes('e')) w = o.w + dx;
      if (dir.includes('s')) h = o.h + dy;
      if (dir.includes('w')) { x = o.x + dx; w = o.w - dx; }
      if (dir.includes('n')) { y = o.y + dy; h = o.h - dy; }
      if (c.lockRatio && o.w && o.h) {
        const ratio = o.w / o.h;
        if (dir.includes('e') || dir.includes('w')) h = w / ratio;
        else w = h * ratio;
      }
      c.x = round(x); c.y = round(y);
      c.w = Math.max(80, round(w)); c.h = Math.max(60, round(h));
      applyCanvasBox(c); renderInspectorLight(); renderMinimap();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveSoon(); commit(); renderAll();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    ev.stopPropagation();
  }

  function createCanvas(p) {
    pushHistory();
    const c = {
      id: uid('cv'), name: '画布 ' + (canvases().length + 1),
      x: round(p.x), y: round(p.y), w: 1600, h: 900,
      bgColor: '#0a0a0a', bgImage: null, bgFit: 'cover',
      lockRatio: false, visible: true, locked: false,
    };
    canvases().push(c);
    selectCanvas(c.id);
    renderAll();
    commit();
    setStatus('已创建画布：可在右侧改尺寸 / 比例 / 背景色 / 背景图');
  }

  function createCanvasAtViewCenter() {
    const vr = viewport.getBoundingClientRect();
    const cx = (vr.width / 2 - panX) / zoom;
    const cy = (vr.height / 2 - panY) / zoom;
    createCanvas({ x: cx - 800, y: cy - 450 });
  }

  /* ------------------------------------------------------------ 分组 / 取消 */
  function groupSelection() {
    const list = selEls().filter((e) => e.type !== 'arrow');
    if (!list.length) { setStatus('先选中要分组的元素'); return; }
    pushHistory();
    const l = {
      id: uid('L'), name: '图层 ' + (layers().length + 1),
      visible: true, locked: false,
    };
    layers().push(l);
    for (const e of list) e.layerId = l.id;
    enteredGroup.delete(l.id);   // 分组后保持「点一下就选中整组」，想单独编辑再双击进入
    renderAll();
    commit();
    setStatus(`已分组 ${list.length} 个元素`);
  }

  function ungroupSelection() {
    const ids = new Set();
    for (const e of selEls()) if (e.layerId) ids.add(e.layerId);
    if (selCanvas) {
      const c = canvasById(selCanvas);
      if (c) for (const l of layers()) if (canvasOfLayer(l) === c) ids.add(l.id);
    }
    if (!ids.size) { setStatus('当前选中没有分组'); return; }
    pushHistory();
    for (const e of state.elements) if (ids.has(e.layerId)) e.layerId = null;
    state.layers = layers().filter((l) => !ids.has(l.id));
    for (const id of ids) enteredGroup.delete(id);
    renderAll();
    commit();
    setStatus('已取消分组');
  }

  // 点组内元素 → 选中整组；Alt 或双击进入编辑
  function selectGroupFor(el, ev) {
    const l = el.layerId ? layerById(el.layerId) : null;
    if (!l) return false;
    if (ev && ev.altKey) return false;
    if (enteredGroup.has(l.id)) return false;
    sel.clear();
    for (const m of membersOf(l)) if (selectable(m)) sel.add(m.id);
    dropCanvasSel();
    syncSelection();
    return true;
  }

  /* --------------------------------------------------------- 颜色选择器
     HSV 面板 + 色相条 + 透明度条 + 十六进制输入，输出 #rrggbb 或 #rrggbbaa。 */
  const CP = { h: 220, s: .65, v: .95, a: 1, cb: null, anchor: null, pop: null, touched: false };
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  const hx2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

  function hsv2rgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return [h, max ? d / max : 0, max];
  }

  function parseColor(str) {
    const s = String(str == null ? '' : str).trim();
    let m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (p.length >= 3 && p.every((n) => !isNaN(n))) {
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? clamp01(p[3]) : 1 };
      }
    }
    return null;
  }

  function cpValue() {
    const [r, g, b] = hsv2rgb(CP.h, CP.s, CP.v);
    return CP.a >= 0.999 ? `#${hx2(r)}${hx2(g)}${hx2(b)}` : `#${hx2(r)}${hx2(g)}${hx2(b)}${hx2(CP.a * 255)}`;
  }

  function cpRender() {
    const pop = CP.pop;
    if (!pop) return;
    const [r, g, b] = hsv2rgb(CP.h, CP.s, CP.v);
    const R = Math.round(r), G = Math.round(g), B = Math.round(b);
    pop.querySelector('.cp-sv').style.background =
      `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${CP.h},100%,50%))`;
    const sc = pop.querySelector('.cp-sv .cp-cur');
    sc.style.left = CP.s * 100 + '%';
    sc.style.top = (1 - CP.v) * 100 + '%';
    pop.querySelector('.cp-hue .cp-cur').style.left = (CP.h / 360) * 100 + '%';
    pop.querySelector('.cp-alpha').style.background =
      `linear-gradient(to right, rgba(${R},${G},${B},0), rgb(${R},${G},${B})),` +
      `repeating-conic-gradient(#2a2a2a 0% 25%, #1c1c1c 0% 50%) 0 0 / 8px 8px`;
    pop.querySelector('.cp-alpha .cp-cur').style.left = CP.a * 100 + '%';
    pop.querySelector('.cp-chip').style.background = cpValue();
    if (document.activeElement !== pop.querySelector('.cp-hex')) pop.querySelector('.cp-hex').value = cpValue();
    if (document.activeElement !== pop.querySelector('.cp-num')) pop.querySelector('.cp-num').value = Math.round(CP.a * 100);
    pop.querySelector('.cp-prev').style.background = `rgba(${R},${G},${B},${CP.a})`;
    pop.querySelector('.cp-prev').style.color = CP.v > .55 ? '#000000' : '#f2f2f2';
    pop.querySelector('.cp-prev').textContent = Math.round(CP.a * 100) + '%';
  }

  function cpEmit() {
    if (!CP.touched) { CP.touched = true; pushHistory(); }
    cpRender();
    if (CP.cb) CP.cb(cpValue());
  }

  function cpBuild() {
    if (CP.pop) return CP.pop;
    const pop = document.createElement('div');
    pop.id = 'cpPop';
    pop.className = 'cp-pop';
    pop.innerHTML = `
      <div class="cp-sv"><div class="cp-cur"></div></div>
      <div class="cp-hue"><div class="cp-cur"></div></div>
      <div class="cp-alpha"><div class="cp-cur"></div></div>
      <div class="cp-foot">
        <span class="cp-chip"></span>
        <input class="cp-hex" maxlength="9" spellcheck="false" />
        <span class="cp-prev"></span>
        <input class="cp-num" type="number" min="0" max="100" step="1" title="不透明度 %" />
      </div>`;
    document.body.appendChild(pop);
    CP.pop = pop;

    const drag2 = (el, fn) => {
      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const rect = el.getBoundingClientRect();
        const apply = (e2) => {
          fn(clamp01((e2.clientX - rect.left) / rect.width), clamp01((e2.clientY - rect.top) / rect.height));
          cpEmit();
        };
        apply(ev);
        const mv = (e2) => apply(e2);
        const up = () => {
          document.removeEventListener('pointermove', mv);
          document.removeEventListener('pointerup', up);
        };
        document.addEventListener('pointermove', mv);
        document.addEventListener('pointerup', up);
      });
    };

    drag2(pop.querySelector('.cp-sv'), (x, y) => { CP.s = x; CP.v = 1 - y; });
    drag2(pop.querySelector('.cp-hue'), (x) => { CP.h = x * 360; });
    drag2(pop.querySelector('.cp-alpha'), (x) => { CP.a = x; });

    pop.querySelector('.cp-hex').addEventListener('change', (ev) => {
      const c = parseColor(ev.target.value);
      if (!c) { cpRender(); return; }
      const [h, s, v] = rgb2hsv(c.r, c.g, c.b);
      CP.h = h; CP.s = s; CP.v = v; CP.a = c.a;
      cpEmit();
    });
    pop.querySelector('.cp-num').addEventListener('input', (ev) => {
      CP.a = clamp01(Number(ev.target.value) / 100);
      cpEmit();
    });
    pop.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    return pop;
  }

  function openColorPicker(anchor, color, cb) {
    const pop = cpBuild();
    const c = parseColor(color) || { r: 20, g: 28, b: 45, a: 1 };
    const [h, s, v] = rgb2hsv(c.r, c.g, c.b);
    CP.h = h; CP.s = s; CP.v = v; CP.a = c.a;
    CP.cb = cb;
    CP.anchor = anchor;
    CP.touched = false;
    cpRender();
    pop.classList.add('on');
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 208, ph = pop.offsetHeight || 240;
    let left = Math.min(r.right - pw, window.innerWidth - pw - 10);
    if (left < 10) left = 10;
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 10) top = Math.max(10, r.top - ph - 6);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function closeColorPicker() {
    if (!CP.pop || !CP.pop.classList.contains('on')) return;
    CP.pop.classList.remove('on');
    if (CP.touched) { commit(); CP.touched = false; }
    CP.cb = null;
  }

  document.addEventListener('pointerdown', (ev) => {
    if (!CP.pop || !CP.pop.classList.contains('on')) return;
    if (CP.pop.contains(ev.target)) return;
    if (CP.anchor && CP.anchor.contains(ev.target)) return;
    closeColorPicker();
  }, true);

  // 取色按钮：棋盘格底 + 内层色块，半透明时能一眼看出来
  function colorSwatch(k, val) {
    return `<button class="csw" data-color="${k}" title="颜色与透明度"><i style="background:${val}"></i></button>`;
  }

  // 面板底板：fill 是外部导入的原始值，其余由 fillColor + fillAlpha 合成
  function panelFill(e) {
    if (e.fill) return e.fill;
    return hexA(e.fillColor || '#0a0a0a', e.fillAlpha == null ? 0.55 : e.fillAlpha);
  }

  /* ---------------------------------------------------------------- 渲染 */
  function renderAll() {
    nodes.clear();
    layer.innerHTML = '';
    const sorted = [...state.elements].sort((a, b) => (a.z || 0) - (b.z || 0));
    for (const e of sorted) {
      // 连线是 SVG，不建 DOM 节点：否则会在世界坐标 (0,0) 留一个 0 尺寸的 .el，
      // 悬停时四个锚点全部叠在同一点，看着就像「0,0 处有个锚点」
      if (e.type === 'arrow') continue;
      if (!isVisible(e)) continue;                          // 隐藏的元素不建 DOM
      const n = buildNode(e);
      nodes.set(e.id, n);
      layer.appendChild(n);
    }
    renderCanvases();
    renderArrows();
    syncSelection();
    renderInspector();
    renderLayerTree();
    applyView();
    renderMinimap();
    saveSoon();
  }

  function buildNode(e) {
    const n = document.createElement('div');
    n.className = `el el-${e.type}`;
    n.dataset.id = e.id;
    n.style.left = e.x + 'px';
    n.style.top = e.y + 'px';
    n.style.width = e.w + 'px';
    n.style.height = e.h + 'px';
    if (e.z) n.style.zIndex = e.z;
    if (e.opacity != null && e.opacity < 1) n.style.opacity = e.opacity;
    if (e.type !== 'text' && e.type !== 'image') {
      const acc0 = e.accent || '#d0d0d0';
      n.style.setProperty('--accent', hexA(acc0, 0.92));   // 角标取元素强调色
      n.style.background = e.type === 'panel' ? panelFill(e) : (e.fill || 'rgba(10,10,10,.55)');
      n.style.border = `${e.strokeW || 1}px solid ${e.stroke || hexA(acc0, 0.55)}`;
      n.style.borderRadius = (e.radius == null ? 0 : e.radius) + 'px';
    }
    if (e.type === 'text') {
      n.style.color = e.color || '#f2f2f2';
      n.style.fontSize = (e.size || 24) + 'px';
      n.style.fontWeight = e.weight || 500;
      n.style.textAlign = e.align || 'left';
    }

    if (e.type === 'panel') {
      const accent = e.accent || '#7ea6ff';
      if (e.corners === false) n.classList.add('no-corners');
      if (e.shadow) n.style.boxShadow = SHADOW[e.shadow] || '';
      n.innerHTML = `
        <div class="content">
          <div class="col">
            ${e.icon ? `<div class="ico-box" style="border-color:${hexA(accent, 0.34)};background:${hexA(accent, 0.06)}">
              <img src="${e.icon}" alt="">
            </div>` : ''}
            <div class="label" style="font-size:${clampNum(e.labelSize, 15, 8, 64)}px;color:${e.labelColor || '#d4d4d4'}">${esc(e.label || '')}</div>
          </div>
          <div class="body"></div>
        </div>`;
      n.style.borderColor = e.stroke || hexA(accent, 0.6);
      if (e.bg) {                      // 面板上传的图片是背景图，铺满整个面板
        n.style.backgroundImage = `url("${e.bg}")`;
        n.style.backgroundSize = 'cover';
        n.style.backgroundPosition = 'center';
        n.style.backgroundRepeat = 'no-repeat';
      }
    } else if (e.type === 'card') {
      const accent = e.accent || '#7ea6ff';
      const edge = e.stroke || hexA(accent, 0.5);
      n.style.borderColor = edge;
      n.style.setProperty('--accent', edge);            // 角标跟随边框色
      if (e.layout === 'stack') n.classList.add('stack');
      if (e.corners === false) n.classList.add('no-corners');
      if (e.shadow) n.style.boxShadow = SHADOW[e.shadow] || '';
      const ts = clampNum(e.titleSize, 23, 8, 96);
      const ss = clampNum(e.subSize, 15, 8, 72);
      n.innerHTML = `
        <div class="content">
          ${e.icon ? `<img class="ico" src="${e.icon}" alt="">` : ''}
          <div class="txt">
            <div class="title" style="font-size:${ts}px;color:${e.titleColor || '#f5f5f5'}">${esc(e.title || '')}</div>
            ${e.sub ? `<div class="sub" style="font-size:${ss}px;color:${e.subColor || '#a3a3a3'}">${esc(e.sub)}</div>` : ''}
          </div>
        </div>`;
    } else if (e.type === 'text') {
      // 对齐要落在 .content 上：它是真正的 flex 容器，设在 .el 上不生效
      const al = e.align || 'left';
      const jc = al === 'center' ? 'center' : al === 'right' ? 'flex-end' : 'flex-start';
      n.innerHTML = `<div class="content" style="justify-content:${jc};text-align:${al}">${esc(e.text || '')}</div>`;
    } else if (e.type === 'image') {
      const fit = e.fit || 'cover';
      if (fit === 'tile') {
        n.innerHTML = `<div class="tile" style="background-image:url('${e.src}')"></div>`;
      } else {
        n.innerHTML = `<img src="${e.src}" alt="" draggable="false" style="object-fit:${fit === 'fill' ? 'fill' : 'cover'}">`;
      }
    }

    if (sel.has(e.id)) n.classList.add('selected');
    if (sel.has(e.id) && e.type !== 'arrow') n.insertAdjacentHTML('beforeend', handlesHTML());
    return n;
  }

  const handlesHTML = () =>
    `<div class="handles">${
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
        .map((h) => `<div class="handle" data-h="${h}"></div>`)
        .join('')
    }</div>`;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  // 卡片外阴影档位（DOM 与导出共用同一套视觉）
  const SHADOW = ['none',
    '0 2px 8px rgba(0,0,0,.45)',
    '0 6px 20px rgba(0,0,0,.55)',
    '0 14px 36px rgba(0,0,0,.65)'];

  function clampNum(v, dflt, lo, hi) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  function hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    const v = parseInt(m[1], 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
  }

  function syncSelection(reveal) {
    for (const [id, n] of nodes) {
      const on = sel.has(id);
      n.classList.toggle('selected', on);
      const h = n.querySelector('.handle');
      if (on && !h) n.insertAdjacentHTML('beforeend', handlesHTML());
      if (!on && h) n.querySelectorAll('.handle').forEach((x) => x.remove());
    }
    renderInspector();
    renderArrows();
    paintReadout();
    updateTreeSelection();          // 画布 ↔ 图层树：选中态双向同步
    if (reveal && sel.size) revealTreeSelection();
  }

  /* -------------------------------------------------------------- 箭头绘制 */
  // 四条边的外法线，连线锚点用 (x, y, nx, ny) 表示：点在边上，法线朝外
  const SIDE_N = { t: [0, -1], r: [1, 0], b: [0, 1], l: [-1, 0] };

  function sidePoint(el, side) {
    const [nx, ny] = SIDE_N[side] || SIDE_N.r;
    return {
      x: el.x + el.w / 2 + (nx * el.w) / 2,
      y: el.y + el.h / 2 + (ny * el.h) / 2,
      nx, ny,
    };
  }

  // 没指定边时按「朝对方中心」自动挑一条边
  function autoSide(el, toward) {
    const dx = (toward.x - (el.x + el.w / 2)) / Math.max(1, el.w / 2);
    const dy = (toward.y - (el.y + el.h / 2)) / Math.max(1, el.h / 2);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'r' : 'l';
    return dy >= 0 ? 'b' : 't';
  }

  function arrowEnd(el, side, toward) {
    return sidePoint(el, side || autoSide(el, toward));
  }

  function arrowGeometry(a) {
    const from = a.from ? getEl(a.from) : null;
    const to = a.to ? getEl(a.to) : null;
    const fc = from ? { x: from.x + from.w / 2, y: from.y + from.h / 2 } : { x: a.fx || 0, y: a.fy || 0 };
    const tc = to ? { x: to.x + to.w / 2, y: to.y + to.h / 2 } : { x: a.tx || 0, y: a.ty || 0 };
    const p1 = from ? arrowEnd(from, a.fromSide, tc) : { ...fc, nx: 0, ny: 0 };
    const p2 = to ? arrowEnd(to, a.toSide, fc) : { ...tc, nx: 0, ny: 0 };
    return { p1, p2 };
  }

  // 三次贝塞尔：控制点沿两端法线方向外推，距离随连线长度自适应
  // （屏幕渲染和 PNG 导出都用这一份控制点，保证两边长得一样）
  function curvePts(p1, p2) {
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const k = Math.min(240, Math.max(46, dist * 0.5));
    return {
      p1, p2,
      c1: { x: p1.x + p1.nx * k, y: p1.y + p1.ny * k },
      c2: { x: p2.x + p2.nx * k, y: p2.y + p2.ny * k },
    };
  }

  // 两端留一小段直线（长度 ≈ 箭头长度）。贝塞尔的控制点本来就落在边的法线上，
  // 末端切向沿法线，所以曲线接直线不会出现折角；但如果不留这段，曲线在箭头长度
  // 范围内还在弯，视觉上就会「从箭头偏下方斜着戳进来」。留直线后线正好穿过箭头中线。
  function bezierD(p1, p2, t1 = 0, t2 = 0, trim1 = 0, trim2 = 0) {
    const { c1, c2 } = curvePts(p1, p2);
    const cap = Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.34;
    const a1 = Math.min(Math.max(t1, 0), cap);
    const a2 = Math.min(Math.max(t2, 0), cap);
    const n1x = p1.nx || 0, n1y = p1.ny || 0, n2x = p2.nx || 0, n2y = p2.ny || 0;
    // 收线点：沿法线往回退 trim，让线头埋进箭头里（否则圆头会从箭头顶戳出来）
    const e1 = { x: p1.x + n1x * trim1, y: p1.y + n1y * trim1 };
    const e2 = { x: p2.x + n2x * trim2, y: p2.y + n2y * trim2 };
    const s1 = a1 > trim1 + 0.2 ? { x: p1.x + n1x * a1, y: p1.y + n1y * a1 } : e1;
    const s2 = a2 > trim2 + 0.2 ? { x: p2.x + n2x * a2, y: p2.y + n2y * a2 } : e2;
    let d = `M ${e1.x} ${e1.y}`;
    if (s1 !== e1) d += ` L ${s1.x} ${s1.y}`;
    d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${s2.x} ${s2.y}`;
    if (s2 !== e2) d += ` L ${e2.x} ${e2.y}`;
    return d;
  }

  // o = { start, end }：两端直线的世界长度；o = { trimStart, trimEnd }：两端收线长度
  function arrowPathD(a, o) {
    const { p1, p2 } = arrowGeometry(a);
    const q = o || {};
    const tr1 = q.trimStart || 0, tr2 = q.trimEnd || 0;
    if (a.mode === 'elbow') return elbowPath(p1, p2, tr1, tr2);
    if (a.mode === 'straight') {
      const dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy) || 1;
      const ux = dx / L, uy = dy / L;
      const c1t = Math.min(tr1, L * 0.4), c2t = Math.min(tr2, L * 0.4);
      const x1 = p1.x + ux * c1t, y1 = p1.y + uy * c1t;
      const x2 = p2.x - ux * c2t, y2 = p2.y - uy * c2t;
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    return bezierD(p1, p2, q.start || 0, q.end || 0, tr1, tr2);
  }

  // 虚线样式按屏幕像素定义（渲染时再 ÷ zoom 换成世界坐标）
  const ARROW_DASH = { solid: null, dash: [9, 7], dot: [1.6, 6] };
  let arrowsRenderZoom = 0;   // 上一次渲染连线时用的倍率（变了要重画线宽/箭头）

  function markerShape(kind, col) {
    if (kind === 'triangle') return `<path d="M 0.4 0.6 L 9.6 5 L 0.4 9.4 z" fill="${col}"/>`;
    if (kind === 'circle') return `<circle cx="5.4" cy="5" r="3.3" fill="${col}"/>`;
    if (kind === 'arrow')
      return `<path d="M 1 1.3 L 9.2 5 L 1 8.7" fill="none" stroke="${col}" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round"/>`;
    return '';
  }

  function renderArrows() {
    const arrows = state.elements.filter((e) => e.type === 'arrow');
    const defs = $('#arrowDefs');
    // 线宽 / 虚线 / 箭头都按「屏幕像素」定义，这里统一 ÷ zoom 换算成世界坐标。
    // 之前用 vector-effect: non-scaling-stroke 让线不随缩放变粗，但描边在设备空间
    // 单独栅格化，放大后边缘会发虚发毛刺；改成真实几何 + 自定义宽度后，画法和其他
    // 元素完全一致，任何倍率都是正常抗锯齿。
    const z = zoom || 1;
    let html = '', df = '';
    for (const a of arrows) {
      const col = a.color || '#c8c8c8';
      // 线宽按「屏幕像素」定义，但放大时略微跟着变粗：1~2px 的细线在任何渲染器里
      // 放大后都是一串台阶，2.5px 以上才顺眼。低倍率下有 0.8 的下限，缩到 40% 也看得见。
      const wBase = a.strokeW == null ? 1 : Math.max(0.5, Number(a.strokeW) || 1);
      const wScale = Math.min(2, Math.max(0.8, Math.pow(z, 0.65)));
      const w = wBase * wScale;                                                   // 实际屏幕宽度
      const head = a.head || 'triangle';
      const tail = a.double ? head : 'none';
      const dash = ARROW_DASH[a.dash || 'solid'];
      // 箭头长度：屏幕像素 → marker 单位（marker 盒子 = markerWidth × strokeWidth）
      const headLen = 8 + 2.2 * w;
      // 两端在箭头长度内保持直线，线才会从箭头中线穿过去
      const tailW = (headLen / z) * 1.15;
      // 线要在箭头里提前收住：收线量 ≈ 一个线宽多一点，正好落在箭头三角还够宽的位置
      const trim = 1.55 * w + 1.2;                                   // 屏幕像素
      const refX = (9.6 - (10 * trim) / headLen).toFixed(2);          // 箭头整体前移 trim
      const d = arrowPathD(a, {
        start: tail !== 'none' ? tailW : 0,
        end: head !== 'none' ? tailW : 0,
        trimStart: tail !== 'none' ? trim / z : 0,
        trimEnd: head !== 'none' ? trim / z : 0,
      });
      const mw = (headLen / w).toFixed(2);
      let mk = '';
      if (head !== 'none') {
        df += `<marker id="ahe-${a.id}" viewBox="0 0 10 10" refX="${refX}" refY="5" markerWidth="${mw}" markerHeight="${mw}"
          orient="auto-start-reverse">${markerShape(head, col)}</marker>`;
        mk += ` marker-end="url(#ahe-${a.id})"`;
      }
      if (tail !== 'none') {
        df += `<marker id="aht-${a.id}" viewBox="0 0 10 10" refX="${refX}" refY="5" markerWidth="${mw}" markerHeight="${mw}"
          orient="auto-start-reverse">${markerShape(tail, col)}</marker>`;
        mk += ` marker-start="url(#aht-${a.id})"`;
      }
      const on = sel.has(a.id);
      // 透明粗描边只负责点选，不带视觉
      html += `<path class="arrow-hit" data-arrow="${a.id}" d="${d}" fill="none" stroke="transparent"
        stroke-width="${(Math.max(22, w + 20) / z).toFixed(3)}" stroke-linecap="round"></path>`;
      html += `<path class="arrow-line${on ? ' sel' : ''}" data-arrow="${a.id}" d="${d}" fill="none"
        stroke="${col}" stroke-width="${(w / z).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round"
        ${dash ? `stroke-dasharray="${dash.map((v) => ((v * wScale) / z).toFixed(3)).join(' ')}"` : ''}${mk}></path>`;
      if (on) {
        const { p1, p2 } = arrowGeometry(a);
        // 端点提示点：直径 = 线宽 + 8 屏幕像素，随线宽变化，缩放不变
        const r = ((w + 8) / 2 / z).toFixed(3);
        html += `<circle class="arrow-dot" cx="${p1.x}" cy="${p1.y}" r="${r}" fill="#fff"/>`
          + `<circle class="arrow-dot" cx="${p2.x}" cy="${p2.y}" r="${r}" fill="#fff"/>`;
      }
    }
    if (defs) defs.innerHTML = df;
    arrowLayer.innerHTML = html;
    arrowsRenderZoom = z;
  }

  /* ------------------------------------------------------------ 连线锚点 */
  // 锚点画在屏幕坐标系（#anchors 在 #viewport 里），这样任何缩放下都是 9px，
  // 不会像元素内部的手柄那样在 40% 缩放下小到点不中。
  let anchorEl = null;        // 悬停的元素 id
  let connect = null;         // 正在拉的连线 { id, side }（起点）
  let connectTarget = null;   // 正在瞄准的终点 { id, side }
  let lastAnchorsHTML = '';

  function anchorsFor(el, activeSide, cls) {
    let h = '';
    for (const s of ['t', 'r', 'b', 'l']) {
      const p = sidePoint(el, s);
      const on = activeSide === s ? ' on' : '';
      const c = cls ? ' ' + cls : '';
      h += `<div class="anchor${c}${on}" data-side="${s}" data-el="${el.id}"
        style="left:${panX + p.x * zoom}px;top:${panY + p.y * zoom}px"></div>`;
    }
    return h;
  }

  function renderAnchors() {
    if (!anchorsBox) return;
    let html = '';
    const srcId = connect ? connect.id : anchorEl;
    const src = srcId && (tool === 'arrow' || connect) ? getEl(srcId) : null;
    if (src && src.type !== 'arrow' && isVisible(src)) {
      html += anchorsFor(src, connect ? connect.side : null, '');
    }
    if (connect && connectTarget) {
      const t = getEl(connectTarget.id);
      if (t && (!src || t.id !== src.id)) html += anchorsFor(t, connectTarget.side, 'dest');
    }
    if (html !== lastAnchorsHTML) {
      anchorsBox.innerHTML = html;
      lastAnchorsHTML = html;
    }
  }

  // 只认真正的元素（排除自己、连线、隐藏元素）
  function hitTargetAt(ev, fromId) {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const node = under && under.closest ? under.closest('#layer .el') : null;
    if (!node) return null;
    const el = getEl(node.dataset.id);
    if (!el || el.id === fromId || el.type === 'arrow' || !isVisible(el)) return null;
    return el;
  }

  // 落点选哪条边：先看有没有直接对准某个锚点，否则取离得最近的那条边
  function sideAt(el, ev) {
    const vr = viewport.getBoundingClientRect();
    let best = null, bd = Infinity;
    for (const s of ['t', 'r', 'b', 'l']) {
      const p = sidePoint(el, s);
      const d = Math.hypot(panX + p.x * zoom - (ev.clientX - vr.left), panY + p.y * zoom - (ev.clientY - vr.top));
      if (d < bd) { bd = d; best = s; }
    }
    if (bd <= 28) return best;
    const p = toStage(ev.clientX, ev.clientY);
    const u = (p.x - el.x) / Math.max(1, el.w);
    const v = (p.y - el.y) / Math.max(1, el.h);
    const dist = { t: v * el.h, b: (1 - v) * el.h, l: u * el.w, r: (1 - u) * el.w };
    return Object.keys(dist).sort((a, b) => dist[a] - dist[b])[0];
  }

  function highlightTarget(el) {
    const cur = layer.querySelector('.el.conn-target');
    if (cur && (!el || cur.dataset.id !== el.id)) cur.classList.remove('conn-target');
    if (el) {
      const n = layer.querySelector(`.el[data-id="${el.id}"]`);
      if (n) n.classList.add('conn-target');
    }
  }

  function clearPreview() {
    if (arrowPreviewLayer) arrowPreviewLayer.innerHTML = '';
    connectTarget = null;
    highlightTarget(null);
    renderAnchors();
  }

  function previewConnect(ev) {
    if (!connect) return;
    const from = getEl(connect.id);
    if (!from) return;

    const t = hitTargetAt(ev, from.id);
    connectTarget = t ? { id: t.id, side: sideAt(t, ev) } : null;
    highlightTarget(t);

    const p1 = sidePoint(from, connect.side);
    let p2;
    if (t) p2 = sidePoint(t, connectTarget.side);
    else {
      const q = toStage(ev.clientX, ev.clientY);
      p2 = { x: q.x, y: q.y, nx: -p1.nx, ny: -p1.ny };
    }
    if (arrowPreviewLayer) {
      arrowPreviewLayer.innerHTML = `<path d="${bezierD(p1, p2)}" fill="none" stroke="#fff" stroke-width="2"
        stroke-dasharray="7 6" stroke-linecap="round" opacity=".9"/>`;
    }
    renderAnchors();
  }

  function startConnect(ev, id, side) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!getEl(id)) return;
    connect = { id, side };
    anchorEl = id;
    anchorsBox.classList.add('connecting');
    previewConnect(ev);
    const move = (e2) => previewConnect(e2);
    const up = (e2) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      endConnect(e2);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function endConnect(ev) {
    const c = connect;
    if (!c) return;
    const from = getEl(c.id);
    const to = from ? hitTargetAt(ev, from.id) : null;
    const toSide = to ? sideAt(to, ev) : null;

    connect = null;
    anchorsBox.classList.remove('connecting');
    clearPreview();

    if (!to) { renderAnchors(); return; }
    pushHistory();
    const a = {
      id: uid('a'), type: 'arrow', from: c.id, to: to.id,
      fromSide: c.side, toSide,
      mode: 'bezier', dash: 'solid', head: 'triangle',
      color: '#c8c8c8', strokeW: 1, z: 500,
    };
    state.elements.push(a);
    sel = new Set([a.id]);
    setStatus('');
    renderAll();
    commit();
  }

  function elbowPath(p1, p2, trim1 = 0, trim2 = 0) {
    const dx = Math.abs(p2.x - p1.x), dy = Math.abs(p2.y - p1.y);
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    let pts = dx > dy
      ? [{ x: p1.x, y: p1.y }, { x: mx, y: p1.y }, { x: mx, y: p2.y }, { x: p2.x, y: p2.y }]
      : [{ x: p1.x, y: p1.y }, { x: p1.x, y: my }, { x: p2.x, y: my }, { x: p2.x, y: p2.y }];
    pts = trimPolyline(pts, trim1, trim2);
    return 'M ' + pts.map((p) => `${p.x} ${p.y}`).join(' L ');
  }

  // 折线两端各缩短一段（沿各自的第一/最后一段方向）
  function trimPolyline(pts, t1 = 0, t2 = 0) {
    const out = pts.map((p) => ({ ...p }));
    if (t1 > 0) {
      const a = out[0], b = out[1];
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const k = Math.min(t1, L * 0.5) / L;
      out[0] = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    if (t2 > 0) {
      const a = out[out.length - 2], b = out[out.length - 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const k = Math.min(t2, L * 0.5) / L;
      out[out.length - 1] = { x: b.x - (b.x - a.x) * k, y: b.y - (b.y - a.y) * k };
    }
    return out;
  }

  /* -------------------------------------------------------------- 视图控制 */
  /* 底部读数：光标画布坐标 / 缩放 / 选中量 */
  const rdX = $('#rdX'), rdY = $('#rdY'), rdS = $('#rdS'), rdE = $('#rdE');
  let rdPt = null, rdQueued = false;
  function paintReadout() {
    if (rdPt) { rdX.textContent = Math.round(rdPt.x); rdY.textContent = Math.round(rdPt.y); }
    rdS.textContent = selCanvas ? '画布' : (sel.size ? String(sel.size) : '0');
    rdE.textContent = state.elements.filter((e) => e.type !== 'arrow').length;
  }

  const gridDots = document.getElementById('gridDots');
  const gridLines = document.getElementById('gridLines');
  let lastViewZoom = -1;

  // ---- 像素对齐 ------------------------------------------------------------
  // 平移位移一律取整到设备像素，避免合成层被亚像素重采样。
  //
  // 另外：**不要给 #stage 加 will-change**。一旦提升成合成层，47% 这种小数倍率
  // 下 1px 描边的栅格化结果会和未提升时差 2~3 倍亮度（实测某行 37.5→21.4，
  // 相邻行 30.1→11.5），于是「按下拖动」的瞬间整屏边框会跳亮、松手再跳回去。
  // 宁可每帧重绘（实测 p95 13.8ms，还省一层纹理内存），也不要这种因为切换
  // 图层而改变外观的行为。
  function applyView() {
    const dpr = window.devicePixelRatio || 1;
    // 位移一律落在整 CSS 像素上（1、2、3…）。整数倍率时 1 CSS px 正好是
    // dpr 个设备像素，所以既不会亚像素重采样，也不会出现 .5 这种值；
    // 遇到 1.25 / 1.5 这种非整数倍率才退回「整设备像素」，否则整 CSS px
    // 反而会落在半个设备像素上，比不取整更糊。
    const unit = Number.isInteger(dpr) ? 1 : 1 / dpr;
    const px = Math.round(panX / unit) * unit;
    const py = Math.round(panY / unit) * unit;
    stage.style.transform = `translate(${px}px, ${py}px) scale(${zoom})`;
    // 点阵 / 主线各是一个合成层，按各自周期取相位后整体 transform，
    // 平移时零重绘（以前改 background-position 会让整屏连同元素重新栅格化）。
    // 相位同样取整到设备像素，点阵才不会在帧间忽明忽暗。
    const mod = (v, n) => ((v % n) + n) % n;
    if (gridDots) gridDots.style.transform = `translate3d(${mod(px, 24)}px, ${mod(py, 24)}px, 0)`;
    if (gridLines) gridLines.style.transform = `translate3d(${mod(px, 120)}px, ${mod(py, 120)}px, 0)`;
    if (stage.style.width !== W + 'px') {
      stage.style.width = W + 'px';
      stage.style.height = H + 'px';
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
    if (lastViewZoom !== zoom) {
      lastViewZoom = zoom;
      stage.style.setProperty('--hscale', String(1 / zoom));   // 手柄反向缩放，保持物理大小
      $('#zoomLabel').textContent = Math.round(zoom * 100) + '%';
      if (arrowsRenderZoom !== zoom) renderArrows();
    }
    paintReadout();
    renderAnchors();
    // 小地图每帧全画一次没必要；平移时限流到 ~12fps，省掉弱机器上的卡顿
    if (showMinimap) {
      const now = performance.now();
      if (!viewport.classList.contains('panning') || now - (applyView._mini || 0) > 80) {
        applyView._mini = now;
        requestAnimationFrame(renderMinimap);
      }
    }
  }

  function fitView() {
    const r = viewport.getBoundingClientRect();
    // 画板可以无限延伸，适应窗口要同时覆盖「导出画板」和「画板外的所有元素」
    let x0 = 0, y0 = 0, x1 = W, y1 = H;
    for (const c of canvases()) {
      x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h);
    }
    for (const e of state.elements) {
      if (e.type === 'arrow') continue;
      x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y);
      x1 = Math.max(x1, e.x + e.w); y1 = Math.max(y1, e.y + e.h);
    }
    const pad = 60;
    const bw = x1 - x0 + pad * 2, bh = y1 - y0 + pad * 2;
    zoom = clamp(Math.min(r.width / bw, r.height / bh), 0.02, 2);
    panX = (r.width - bw * zoom) / 2 - (x0 - pad) * zoom;
    panY = (r.height - bh * zoom) / 2 - (y0 - pad) * zoom;
    applyView();
  }

  function zoomAt(cx, cy, factor) {
    const r = viewport.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const z2 = clamp(zoom * factor, 0.05, 4);
    panX = px - (px - panX) * (z2 / zoom);
    panY = py - (py - panY) * (z2 / zoom);
    zoom = z2;
    applyView();
  }

  const toStage = (clientX, clientY) => {
    const r = viewport.getBoundingClientRect();
    return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom };
  };

  /* ------------------------------------------------------------ 吸附与参考线 */
  // 吸附索引：拖动开始时按当前画布建一次，之后每次 pointermove 只做二分查找。
  // 移动方只用一个「大元素」外框的三条线（左/中/右），不展开成子元素。
  function buildSnapIndex(exclude) {
    const xs = [0, W / 2, W];
    const ys = [0, H / 2, H];
    for (const e of state.elements) {
      if (exclude.has(e.id) || e.type === 'arrow') continue;
      xs.push(e.x, e.x + e.w / 2, e.x + e.w);
      ys.push(e.y, e.y + e.h / 2, e.y + e.h);
    }
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    return { xs, ys };
  }

  function nearestIn(sorted, v, th) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    let best = null;
    for (const i of [lo - 1, lo]) {
      if (i < 0 || i >= sorted.length) continue;
      const d = sorted[i] - v;
      if (Math.abs(d) <= th && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, v: sorted[i] };
    }
    return best;
  }

  function snapMove(b, index) {
    const th = 4 / zoom;   // 屏幕像素阈值，太大就会「拽不动」
    const mineX = [b.x, b.x + b.w / 2, b.x + b.w];
    const mineY = [b.y, b.y + b.h / 2, b.y + b.h];
    let bestX = null, bestY = null;
    for (const m of mineX) {
      const r = nearestIn(index.xs, m, th);
      if (r && (!bestX || Math.abs(r.d) < Math.abs(bestX.d))) bestX = r;
    }
    for (const m of mineY) {
      const r = nearestIn(index.ys, m, th);
      if (r && (!bestY || Math.abs(r.d) < Math.abs(bestY.d))) bestY = r;
    }
    return { dx: bestX ? bestX.d : 0, dy: bestY ? bestY.d : 0, gx: bestX && bestX.v, gy: bestY && bestY.v };
  }

  function drawGuides(gx, gy) {
    let html = '';
    if (gx != null) html += `<div class="guide v" style="left:${gx}px;top:0;height:${H}px"></div>`;
    if (gy != null) html += `<div class="guide h" style="top:${gy}px;left:0;width:${W}px"></div>`;
    guidesBox.innerHTML = html;
  }
  const clearGuides = () => { guidesBox.innerHTML = ''; };

  /* ---------------------------------------------------------------- 交互 */
  let spaceDown = false;

  // Ctrl+左键（mac 上等同右键）用于平移时，不要弹出系统菜单
  viewport.addEventListener('contextmenu', (ev) => {
    if (ev.ctrlKey || ev.metaKey) ev.preventDefault();
  });

  // 连线模式下，鼠标经过的元素显示四个边锚点
  viewport.addEventListener('pointermove', (ev) => {
    if (tool !== 'arrow' || connect) return;
    if (ev.target.closest && ev.target.closest('.anchor')) return;   // 站在锚点上，保持不动
    const node = ev.target.closest ? ev.target.closest('#layer .el') : null;
    const id = node ? node.dataset.id : null;
    if (id !== anchorEl) { anchorEl = id; renderAnchors(); }
  });

  viewport.addEventListener('pointerdown', (ev) => {
    // 中键 / 空格 / ⌘(Ctrl) + 左键 都能平移
    if (ev.button === 1 || spaceDown || ((ev.metaKey || ev.ctrlKey) && ev.button === 0)) {
      startPan(ev);
      return;
    }
    if (ev.button !== 0) return;

    // 从锚点拉线
    const anch = ev.target.closest('.anchor');
    if (anch) { startConnect(ev, anch.dataset.el, anch.dataset.side); return; }

    // 点选已有连线（透明粗描边负责命中）
    const aHit = ev.target.closest('.arrow-hit');
    if (aHit) {
      const aid = aHit.dataset.arrow;
      dropCanvasSel();
      if (ev.shiftKey) { if (sel.has(aid)) sel.delete(aid); else sel.add(aid); }
      else { sel.clear(); sel.add(aid); }
      syncSelection();
      return;
    }

    const handleEl = ev.target.closest('.handle');
    if (handleEl) { startResize(ev, handleEl.dataset.h); return; }

    // 画布区域：只有名字标签和手柄可点，内部空白仍然用于框选
    const cvHandle = ev.target.closest('.cv-handle');
    if (cvHandle) {
      const region = cvHandle.closest('.canvas-region');
      const c = region && canvasById(region.dataset.cid);
      if (c) { startCanvasResize(ev, c, cvHandle.dataset.h); return; }
    }
    const cvName = ev.target.closest('.canvas-region > .cv-name');
    if (cvName) {
      const c = canvasById(cvName.parentElement.dataset.cid);
      if (c) {
        selectCanvas(c.id);
        if (!ev.altKey) startCanvasMove(ev, c);
        return;
      }
    }

    const node = ev.target.closest('.el');
    if (node) {
      const id = node.dataset.id;
      const el = getEl(id);
      if (!el) return;
      if (tool === 'arrow') { pickArrowEndpoint(id); return; }
      if (!selectable(el)) {           // 锁定 / 隐藏：不参与选择与拖动
        setStatus(isLocked(el) ? '该图层已锁定，无法选中' : '该元素已隐藏');
        return;
      }
      dropCanvasSel();
      // 组内元素：点一下选中整组；双击或按住 Alt 才单独操作
      if (selectGroupFor(el, ev)) { startMove(ev); return; }
      if (!sel.has(id)) {
        if (ev.shiftKey) sel.add(id);
        else { sel.clear(); sel.add(id); }
        syncSelection(true);
      } else if (ev.shiftKey) {
        sel.delete(id); syncSelection(); return;
      }
      startMove(ev);
      return;
    }

    if (tool === 'arrow') { arrowPick.from = null; return; }
    // 空白：框选 or 新建
    if (tool === 'canvas') { createCanvas(toStage(ev.clientX, ev.clientY)); setTool('select'); return; }
    if (tool === 'select') { selCanvas = null; renderCanvases(); startMarquee(ev); return; }
    const p = toStage(ev.clientX, ev.clientY);
    createAt(tool, p);
  });

  // 光标位置实时读数（rAF 节流，避免高频 pointermove 抖动）
  viewport.addEventListener('pointermove', (ev) => {
    rdPt = toStage(ev.clientX, ev.clientY);
    if (rdQueued) return;
    rdQueued = true;
    requestAnimationFrame(() => { rdQueued = false; paintReadout(); });
  });

  function startPan(ev) {
    const sx = ev.clientX - panX, sy = ev.clientY - panY;
    let queued = false, mx = panX, my = panY;
    viewport.classList.add('panning');
    // 每帧最多写一次 transform：低刷屏上多条 pointermove 落到同一帧里，
    // 逐条写会让合成器看到一串中间状态，表现就是抖。
    const move = (e) => {
      mx = e.clientX - sx;
      my = e.clientY - sy;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        panX = mx; panY = my;
        applyView();
      });
    };
    const up = () => {
      viewport.classList.remove('panning');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    ev.preventDefault();
  }

  function startMove(ev) {
    const start = toStage(ev.clientX, ev.clientY);
    const list = selEls().map((e) => ({ e, x: e.x, y: e.y }));
    const box = unionBounds(selEls());
    let moved = false;
    let snapIndex = null;      // 首次移动时才建，单击不付这个成本
    const move = (e2) => {
      const p = toStage(e2.clientX, e2.clientY);
      let dx = p.x - start.x, dy = p.y - start.y;
      if (!moved && Math.abs(dx) * zoom < 2 && Math.abs(dy) * zoom < 2) return;
      if (!moved) { moved = true; pushHistory(); }
      if (e2.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (snapOn && !e2.altKey) {
        if (!snapIndex) snapIndex = buildSnapIndex(sel);
        // 选中多个元素时，只用并集外框参与吸附，不逐个子元素算
        const snap = snapMove({ x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }, snapIndex);
        dx += snap.dx; dy += snap.dy;
        drawGuides(snap.gx, snap.gy);
      }
      for (const it of list) {
        it.e.x = round(it.x + dx); it.e.y = round(it.y + dy);
        const n = nodes.get(it.e.id);
        if (n) { n.style.left = it.e.x + 'px'; n.style.top = it.e.y + 'px'; }
      }
      renderArrows();
      renderInspectorLight();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      clearGuides();
      if (moved) { saveSoon(); commit(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    ev.stopPropagation();
  }

  function startResize(ev, dir) {
    const el = selEls()[0];
    if (!el) return;
    const start = toStage(ev.clientX, ev.clientY);
    const o = { x: el.x, y: el.y, w: el.w, h: el.h };
    pushHistory();
    const move = (e2) => {
      const p = toStage(e2.clientX, e2.clientY);
      let dx = p.x - start.x, dy = p.y - start.y;
      let x = o.x, y = o.y, w = o.w, h = o.h;
      if (dir.includes('e')) w = o.w + dx;
      if (dir.includes('s')) h = o.h + dy;
      if (dir.includes('w')) { x = o.x + dx; w = o.w - dx; }
      if (dir.includes('n')) { y = o.y + dy; h = o.h - dy; }
      if (e2.shiftKey && o.w && o.h) {
        const r = o.w / o.h;
        if (dir.includes('e') || dir.includes('w')) h = w / r; else w = h * r;
      }
      el.x = round(x); el.y = round(y);
      el.w = Math.max(40, round(w)); el.h = Math.max(28, round(h));
      const n = nodes.get(el.id);
      if (n) {
        n.style.left = el.x + 'px'; n.style.top = el.y + 'px';
        n.style.width = el.w + 'px'; n.style.height = el.h + 'px';
      }
      renderArrows();
      renderInspectorLight();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveSoon(); commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    ev.stopPropagation();
  }

  function startMarquee(ev) {
    const start = toStage(ev.clientX, ev.clientY);
    // 先按起点归零，避免上一次框选的矩形残留到这一次
    marquee.style.left = (panX + start.x * zoom) + 'px';
    marquee.style.top = (panY + start.y * zoom) + 'px';
    marquee.style.width = '0px';
    marquee.style.height = '0px';
    marquee.dataset.x = start.x; marquee.dataset.y = start.y;
    marquee.dataset.w = 0; marquee.dataset.h = 0;
    marquee.style.display = 'none';   // 真正开始拖动才显示，避免单击时闪一个 2px 小点
    let moved = false;
    const move = (e2) => {
      const p = toStage(e2.clientX, e2.clientY);
      const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
      const w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
      if (w * zoom > 3 || h * zoom > 3) {
        if (!moved) marquee.style.display = 'block';
        moved = true;
      }
      marquee.style.left = (panX + x * zoom) + 'px';
      marquee.style.top = (panY + y * zoom) + 'px';
      marquee.style.width = w * zoom + 'px';
      marquee.style.height = h * zoom + 'px';
      marquee.dataset.x = x; marquee.dataset.y = y;
      marquee.dataset.w = w; marquee.dataset.h = h;
    };
    let done = false;
    const up = () => {
      if (done) return;
      done = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      marquee.style.display = 'none';
      marquee.style.width = '0px';
      marquee.style.height = '0px';
      if (moved && sel.size) revealTreeSelection();
      if (!moved) {
        // 画布区域本身不接事件（否则没法在画布里框选），所以这里补上
        // 「单击空白处选中该画布」；点到所有画布外面才是取消选中
        const hit = canvasAtPoint(start);
        if (hit && !hit.locked) { selectCanvas(hit.id); return; }
        sel.clear();
        selCanvas = null;
        syncSelection();
        renderCanvases();
        renderInspector();
        return;
      }
      const x = +marquee.dataset.x, y = +marquee.dataset.y;
      const w = +marquee.dataset.w, h = +marquee.dataset.h;
      for (const e of state.elements) {
        if (e.type === 'arrow') continue;
        if (!selectable(e)) continue;              // 锁定 / 隐藏的元素框选不到
        if (e.x < x + w && e.x + e.w > x && e.y < y + h && e.y + e.h > y) sel.add(e.id);
      }
      syncSelection();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);   // 拖到窗口外松手也要收尾
    window.addEventListener('blur', up);
  }

  function pickArrowEndpoint(id) {
    if (!arrowPick.from) {
      arrowPick.from = id;
      setStatus('连线：再点终点元素（Esc 取消）');
      return;
    }
    if (arrowPick.from === id) { arrowPick.from = null; setStatus(''); return; }
    pushHistory();
    const a = {
      id: uid('a'), type: 'arrow', from: arrowPick.from, to: id,
      fromSide: null, toSide: null, mode: 'bezier', dash: 'solid', head: 'triangle',
      color: '#c8c8c8', strokeW: 1, z: 500,
    };
    state.elements.push(a);
    arrowPick.from = null;
    sel.clear(); sel.add(a.id);
    setStatus('');
    renderAll();
    commit();
  }

  function createAt(kind, p) {
    pushHistory();
    let e;
    if (kind === 'panel') {
      e = { id: uid('p'), type: 'panel', x: round(p.x), y: round(p.y), w: 1800, h: 140, label: '新层', accent: '#7ea6ff', radius: 0 };
    } else if (kind === 'card') {
      e = { id: uid('c'), type: 'card', x: round(p.x), y: round(p.y), w: 390, h: 92, title: '新卡片', sub: '说明文字', accent: '#7ea6ff', radius: 0 };
    } else if (kind === 'text') {
      e = { id: uid('t'), type: 'text', x: round(p.x), y: round(p.y), w: 420, h: 44, text: '文字', size: 24, color: '#eaf1ff', align: 'left' };
    } else if (kind === 'image') {
      e = { id: uid('i'), type: 'image', x: round(p.x), y: round(p.y), w: 96, h: 96, src: '', fit: 'cover' };
    }
    state.elements.push(e);
    sel.clear(); sel.add(e.id);
    renderAll();
    commit();
    if (kind === 'image') { setStatus('图片元素：在右侧面板点「更换图片」上传'); }
    setTool('select');
  }

  /* ---------------------------------------------------------------- 检查器 */
  let inspectorFor = null;
  function renderInspectorLight() {
    if (selCanvas) {
      const c = canvasById(selCanvas);
      if (!c) return;
      for (const k of ['x', 'y', 'w', 'h']) {
        const inp = inspector.querySelector(`[data-k="${k}"]`);
        if (inp && document.activeElement !== inp) inp.value = Math.round(c[k]);
      }
      return;
    }
    if (!inspectorFor) return;
    const e = getEl(inspectorFor);
    if (!e) return;
    for (const k of ['x', 'y', 'w', 'h']) {
      const inp = inspector.querySelector(`[data-k="${k}"]`);
      if (inp && document.activeElement !== inp) inp.value = Math.round(e[k]);
    }
  }

  function renderInspector() {
    if (selCanvas) {
      const c = canvasById(selCanvas);
      if (c) { inspector.innerHTML = canvasInspector(c); bindCanvasInspector(c); return; }
      selCanvas = null;
    }
    const list = selEls().filter((e) => e.type !== 'arrow');
    inspectorFor = list.length === 1 ? list[0].id : null;
    if (list.length === 0) {
      const arrows = selEls().filter((e) => e.type === 'arrow');
      if (arrows.length === 1) { inspector.innerHTML = arrowInspector(arrows[0]); bindInspector(arrows[0]); return; }
      inspector.innerHTML = `<div class="ins-empty">选中一个元素后在这里调整<br /><span>拖动可移动，拖角可缩放；<br />拖动时会出现对齐参考线。</span></div>`;
      return;
    }
    if (list.length > 1) {
      inspector.innerHTML = multiInspector(list);
      bindMulti(list);
      return;
    }
    const e = list[0];
    inspector.innerHTML = inspectorHTML(e);
    bindInspector(e);
  }

  function whInputs(e) {
    return `<div class="row"><label>位置</label>
        <input type="number" data-k="x" value="${Math.round(e.x)}" />
        <input type="number" data-k="y" value="${Math.round(e.y)}" /></div>
      <div class="row"><label>尺寸</label>
        <input type="number" data-k="w" value="${Math.round(e.w)}" />
        <input type="number" data-k="h" value="${Math.round(e.h)}" /></div>`;
  }

  const ACCENTS = ['#a78bfa', '#38bdf8', '#34d399', '#fbbf24', '#94a3b8', '#fb7185'];
  const swatches = (cur) => `<div class="swatches">${ACCENTS.map((c) =>
    `<span class="swatch" data-color="${c}" style="background:${c};${c === cur ? 'outline:1px solid #ffffff;outline-offset:2px' : ''}"></span>`).join('')}</div>`;

  function inspectorHTML(e) {
    const head = `<h4>${{ panel: '层带面板', card: '卡片', text: '文字', image: '图片' }[e.type]}</h4>`;
    let body = whInputs(e);

    if (e.type === 'panel') {
      const accent = e.accent || '#7ea6ff';
      const fa = Math.round((e.fillAlpha == null ? 0.72 : e.fillAlpha) * 100);
      body += `<div class="row"><label>标签</label><input type="text" data-k="label" value="${esc(e.label || '')}" /></div>
        <div class="row"><label>标签字</label>
          <input type="number" data-k="labelSize" min="8" max="64" step="1" value="${clampNum(e.labelSize, 15, 8, 64)}" />
          ${colorSwatch('labelColor', e.labelColor || '#d4d4d4')}</div>
        <div class="row"><label>强调色</label>${swatches(e.accent)}</div>
        <div class="row"><label>边框</label>${colorSwatch('stroke', e.stroke || hexA(accent, 0.6))}
          <label style="width:auto;flex:0 0 auto">背景</label>${colorSwatch('fillColor', panelFill(e))}</div>
        <div class="row"><label>透明度</label>
          <input class="rng" type="range" data-k="fillAlpha" min="0" max="100" step="1" value="${fa}" />
          <span class="pctv">${fa}%</span></div>
        <div class="row"><label>阴影</label>
          <select data-k="shadow">
            <option value="0" ${!e.shadow ? 'selected' : ''}>无</option>
            <option value="1" ${e.shadow === 1 ? 'selected' : ''}>弱</option>
            <option value="2" ${e.shadow === 2 ? 'selected' : ''}>中</option>
            <option value="3" ${e.shadow === 3 ? 'selected' : ''}>强</option>
          </select>
          <label class="chk"><input type="checkbox" data-k="corners" ${e.corners === false ? '' : 'checked'} /> 角标</label></div>
        <div class="row"><label>背景图</label>
          <label class="mini-btn upload" style="flex:1;display:flex;align-items:center;justify-content:center">${e.bg ? '更换' : '上传'}
            <input type="file" data-act="bg" accept="image/*" hidden /></label>
          <button class="mini-btn" data-act="bgClear" style="width:52px" ${e.bg ? '' : 'disabled'}>清除</button></div>`;
    } else if (e.type === 'card') {
      const accent = e.accent || '#7ea6ff';
      body += `<div class="row"><label>标题</label><input type="text" data-k="title" value="${esc(e.title || '')}" /></div>
        <div class="row"><label>标题字</label>
          <input type="number" data-k="titleSize" min="8" max="96" step="1" value="${clampNum(e.titleSize, 23, 8, 96)}" />
          ${colorSwatch('titleColor', e.titleColor || '#f5f5f5')}</div>
        <div class="row"><label>说明</label><input type="text" data-k="sub" value="${esc(e.sub || '')}" /></div>
        <div class="row"><label>说明字</label>
          <input type="number" data-k="subSize" min="8" max="72" step="1" value="${clampNum(e.subSize, 15, 8, 72)}" />
          ${colorSwatch('subColor', e.subColor || '#a3a3a3')}</div>
        <div class="row"><label>边框</label>${colorSwatch('stroke', e.stroke || hexA(accent, 0.5))}
          <label style="width:auto;flex:0 0 auto">背景</label>${colorSwatch('fill', e.fill || 'rgba(10,10,10,.55)')}</div>
        <div class="row"><label>阴影</label>
          <select data-k="shadow">
            <option value="0" ${!e.shadow ? 'selected' : ''}>无</option>
            <option value="1" ${e.shadow === 1 ? 'selected' : ''}>弱</option>
            <option value="2" ${e.shadow === 2 ? 'selected' : ''}>中</option>
            <option value="3" ${e.shadow === 3 ? 'selected' : ''}>强</option>
          </select>
          <label class="chk"><input type="checkbox" data-k="corners" ${e.corners === false ? '' : 'checked'} /> 角标</label></div>
        <div class="row"><label>图标</label>
          <label class="mini-btn upload" style="flex:1;display:flex;align-items:center;justify-content:center">上传
            <input type="file" data-act="icon" accept="image/*" hidden /></label>
          <button class="mini-btn" data-act="iconClear" style="width:52px">清除</button></div>
        <div class="row"><label>布局</label>
          <select data-k="layout">
            <option value="row" ${e.layout !== 'stack' ? 'selected' : ''}>图标左 · 文字右</option>
            <option value="stack" ${e.layout === 'stack' ? 'selected' : ''}>图标上 · 文字下</option>
          </select></div>`;
    } else if (e.type === 'text') {
      body += `<div class="row" style="align-items:flex-start"><label>内容</label>
          <textarea data-k="text">${esc(e.text || '')}</textarea></div>
        <div class="row"><label>字号</label><input type="number" data-k="size" value="${e.size || 24}" />
          ${colorSwatch('color', e.color || '#eaf1ff')}</div>
        <div class="row"><label>对齐</label>
          <select data-k="align">
            <option value="left" ${e.align === 'left' ? 'selected' : ''}>左</option>
            <option value="center" ${e.align === 'center' ? 'selected' : ''}>居中</option>
            <option value="right" ${e.align === 'right' ? 'selected' : ''}>右</option>
          </select></div>`;
    } else if (e.type === 'image') {
      const fit = e.fit || 'cover';
      body += `<div class="row"><label>图片</label>
          <label class="mini-btn upload" style="flex:1;display:flex;align-items:center;justify-content:center">更换
            <input type="file" data-act="img" accept="image/*" hidden /></label></div>
        <div class="row"><label>填充</label>
          <select data-k="fit">
            <option value="cover" ${fit === 'cover' ? 'selected' : ''}>铺满（裁剪）</option>
            <option value="fill" ${fit === 'fill' ? 'selected' : ''}>拉伸（变形）</option>
            <option value="tile" ${fit === 'tile' ? 'selected' : ''}>平铺（重复）</option>
          </select></div>`;
    }

    body += `<div class="divider"></div>
      <div class="row"><label>圆角</label><input type="number" data-k="radius" value="${e.radius == null ? 10 : e.radius}" />
        <label style="width:auto;flex:0 0 auto">透明</label><input type="number" data-k="opacity" step="0.1" min="0" max="1" value="${e.opacity == null ? 1 : e.opacity}" style="max-width:64px" /></div>
      <div class="mini">
        <button data-act="front">上移一层</button>
        <button data-act="back">下移一层</button>
        <button data-act="centerCanvas">居中画布</button>
      </div>`;
    return head + body;
  }

  // 检查器里的分段按钮：data-k 是字段，data-v 是取值
  const SEG_ICONS = {
    bezier: '<path d="M2.5 13.5C6.2 13.5 6.2 2.5 13.5 2.5"/>',
    straight: '<path d="M2.5 13.5 13.5 2.5"/>',
    elbow: '<path d="M3 13.5V5.5h10.5"/>',
    solid: '<path d="M2 8h12" stroke-width="1.8"/>',
    dash: '<path d="M2 8h3.6M7.2 8h3.6M12.4 8h1.6" stroke-width="1.8"/>',
    dot: '<path d="M2.6 8h.01M6.4 8h.01M10.2 8h.01M13.8 8h.01" stroke-width="2.4" stroke-linecap="round"/>',
    none: '<path d="M2 8h10.5"/>',
    arrow: '<path d="M2 8h8"/><path d="M8.6 5.4 12 8l-3.4 2.6"/>',
    triangle: '<path d="M2 8h5.6"/><path d="M7.8 4.9 12.2 8l-4.4 3.1z" fill="currentColor" stroke="none"/>',
    circle: '<path d="M2 8h5.8"/><circle cx="10.7" cy="8" r="2.1" fill="currentColor" stroke="none"/>',
  };

  function segRow(k, items, cur) {
    const on = cur || items[0][0];
    return `<div class="seg" data-k="${k}">${items.map(([v, tip]) =>
      `<button type="button" data-v="${v}" title="${tip}"${on === v ? ' class="on"' : ''}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${SEG_ICONS[v] || ''}</svg>
      </button>`).join('')}</div>`;
  }

  function arrowInspector(a) {
    return `<h4>连线</h4>
      <div class="row"><label>路径</label>${segRow('mode', [['bezier', '曲线'], ['straight', '直线'], ['elbow', '折线']], a.mode)}</div>
      <div class="row"><label>线型</label>${segRow('dash', [['solid', '实线'], ['dash', '虚线'], ['dot', '点线']], a.dash)}</div>
      <div class="row"><label>箭头</label>${segRow('head', [['none', '无箭头'], ['arrow', 'V 形'], ['triangle', '实心三角'], ['circle', '圆点']], a.head)}</div>
      <div class="row"><label>双向</label>
        <label class="chk"><input type="checkbox" data-k="double" ${a.double ? 'checked' : ''} /> 两端都画箭头</label></div>
      <div class="row"><label>颜色</label>${colorSwatch('color', a.color || '#c8c8c8')}</div>
      <div class="row"><label>粗细</label><input type="number" data-k="strokeW" min="0.5" max="12" step="0.5" value="${a.strokeW == null ? 1 : a.strokeW}" /></div>
      <div class="hintline">连线跟随元素移动，不需要手动摆；箭头类型和颜色都可以单独调。</div>`;
  }

  /* ------------------------------------------------------------ 批量检查器 */
  // 某字段在整批选中里是否一致；不一致返回 null（= 不改变）
  function multiSame(list, k) {
    const v = list[0][k] == null ? null : list[0][k];
    return list.every((e) => (e[k] == null ? null : e[k]) === v) ? v : null;
  }

  // 批量色块的预览色：取第一个适用元素的实际生效值
  function multiColor(list, k) {
    const e = list.find((x) => colorApplies(x, k)) || list[0];
    return e ? colorOf(e, k) : 'transparent';
  }

  function colorApplies(e, k) {
    if (k === 'color') return e.type === 'text';
    if (k === 'stroke') return e.type === 'card' || e.type === 'panel';
    if (k === 'fill' || k === 'titleColor' || k === 'subColor') return e.type === 'card';
    if (k === 'fillColor' || k === 'labelColor') return e.type === 'panel';
    return false;
  }

  function colorOf(e, k) {
    if (k === 'stroke') return e.stroke || hexA(e.accent || '#7ea6ff', e.type === 'panel' ? 0.6 : 0.5);
    if (k === 'fill') return e.fill || 'rgba(10,10,10,.55)';
    if (k === 'fillColor') return panelFill(e);
    if (k === 'titleColor') return e.titleColor || '#f5f5f5';
    if (k === 'subColor') return e.subColor || '#a3a3a3';
    if (k === 'labelColor') return e.labelColor || '#d4d4d4';
    if (k === 'color') return e.color || '#f2f2f2';
    return '#7ea6ff';
  }

  function setColor(e, k, val) {
    if (!colorApplies(e, k)) return false;
    if (k === 'fillColor') {
      const c = parseColor(val) || { r: 20, g: 28, b: 45, a: 1 };
      e.fillColor = `#${hx2(c.r)}${hx2(c.g)}${hx2(c.b)}`;
      e.fillAlpha = Math.round(c.a * 100) / 100;
      e.fill = null;
      return true;
    }
    e[k] = val;
    return true;
  }

  // 取色拖动时只改对应节点的样式，不重建 DOM（批量也顺滑）
  function paintColor(e, k, val) {
    const n = nodes.get(e.id);
    if (!n) return;
    if (k === 'stroke') { n.style.borderColor = val; if (e.type === 'card') n.style.setProperty('--accent', val); }
    else if (k === 'fill') n.style.background = val;
    else if (k === 'fillColor') n.style.background = panelFill(e);
    else if (k === 'titleColor') { const t = n.querySelector('.title'); if (t) t.style.color = val; }
    else if (k === 'subColor') { const sb = n.querySelector('.sub'); if (sb) sb.style.color = val; }
    else if (k === 'labelColor') { const l = n.querySelector('.label'); if (l) l.style.color = val; }
    else if (k === 'color') n.style.color = val;
  }

  function multiInspector(list) {
    const types = [...new Set(list.map((e) => e.type))];
    const has = (t) => types.includes(t);
    const hasCard = has('card'), hasPanel = has('panel'), hasText = has('text');
    const count = (t) => list.filter((e) => e.type === t).length;

    const num = (k, ph, step) => {
      const v = multiSame(list, k);
      return `<input type="number" data-m="${k}"${step ? ` step="${step}"` : ''} placeholder="${ph || '不改变'}"${v != null ? ` value="${v}"` : ''} />`;
    };
    const sel = (k, opts) => {
      const v = multiSame(list, k);
      const body = opts.map(([val, txt]) => `<option value="${val}"${v != null && String(v) === String(val) ? ' selected' : ''}>${txt}</option>`).join('');
      return `<select data-m="${k}"><option value="">不改变</option>${body}</select>`;
    };
    const col = (k) => `<button class="csw" data-mcolor="${k}" title="批量取色"><i style="background:${multiColor(list, k)}"></i></button>`;
    const head = (t, name) => `<div class="subhead">${name} × ${count(t)}</div>`;

    return `<h4>${list.length} 个元素</h4>
      <div class="row"><label>尺寸</label>${num('w', '宽')}${num('h', '高')}</div>
      <div class="row"><label>圆角</label>${num('radius', '圆角')}${num('opacity', '透明度', '0.1')}</div>
      ${hasPanel ? `${head('panel', '层带面板')}
        <div class="row"><label>标签字</label>${num('labelSize', '字号')}${col('labelColor')}</div>
        <div class="row"><label>强调色</label>${swatches(null)}</div>
        <div class="row"><label>边框</label>${col('stroke')}
          <label style="width:auto;flex:0 0 auto">背景</label>${col('fillColor')}</div>` : ''}
      ${hasCard ? `${head('card', '卡片')}
        <div class="row"><label>标题字</label>${num('titleSize', '字号')}${col('titleColor')}</div>
        <div class="row"><label>说明字</label>${num('subSize', '字号')}${col('subColor')}</div>
        <div class="row"><label>边框</label>${col('stroke')}
          <label style="width:auto;flex:0 0 auto">背景</label>${col('fill')}</div>
        <div class="row"><label>图标</label>
          <label class="mini-btn upload" style="flex:1;display:flex;align-items:center;justify-content:center">批量上传
            <input type="file" data-mact="icon" accept="image/*" hidden /></label>
          <button class="mini-btn" data-mact="iconClear" style="width:52px">清除</button></div>
        <div class="row"><label>布局</label>${sel('layout', [['row', '图标左 · 文字右'], ['stack', '图标上 · 文字下']])}</div>` : ''}
      ${hasCard || hasPanel ? `<div class="row"><label>阴影</label>${sel('shadow', [['0', '无'], ['1', '弱'], ['2', '中'], ['3', '强']])}</div>
        <div class="row"><label>角标</label>${sel('corners', [['1', '显示'], ['0', '隐藏']])}</div>` : ''}
      ${hasText ? `${head('text', '文字')}
        <div class="row"><label>字号</label>${num('size', '字号')}${col('color')}</div>
        <div class="row"><label>字重</label>${sel('weight', [['400', '常规'], ['500', '中等'], ['600', '半粗'], ['700', '加粗']])}</div>
        <div class="row"><label>对齐</label>${sel('align', [['left', '左对齐'], ['center', '居中'], ['right', '右对齐']])}</div>` : ''}
      <div class="divider"></div>
      <div class="mini"><button data-act="centerCanvas">居中于画布</button></div>
      <div class="hintline">留空的项不改变；色块点开可批量改色，覆盖该类型元素的同名设置。</div>`;
  }

  function bindMulti(list) {
    const LABEL = {
      w: '宽度', h: '高度', radius: '圆角', opacity: '透明度', titleSize: '标题字号', subSize: '说明字号',
      labelSize: '标签字号', size: '字号', layout: '布局', shadow: '阴影', corners: '角标', weight: '字重', align: '对齐',
    };
    // 一次批量改动 = 一条历史；改完重建界面，字段会按新状态回填
    const apply = (fn, label) => {
      if (!list.length) return;
      pushHistory();
      let n = 0;
      for (const e of list) if (fn(e) !== false) n++;
      renderAll();
      commit();
      setStatus(`${label} · 已应用到 ${n} 个${n === list.length ? '' : '（部分类型不适用）'}`);
    };

    inspector.querySelectorAll('input[data-m]').forEach((inp) => {
      const k = inp.dataset.m;
      inp.onchange = () => {
        const raw = String(inp.value).trim();
        if (raw === '') return;
        const num = Number(raw);
        if (!Number.isFinite(num)) return;
        apply((e) => {
          switch (k) {
            case 'w': e.w = Math.max(20, num); return true;
            case 'h': e.h = Math.max(16, num); return true;
            case 'radius': e.radius = Math.max(0, num); return true;
            case 'opacity': e.opacity = Math.max(0, Math.min(1, num)); return true;
            case 'titleSize': if (e.type !== 'card') return false; e.titleSize = clampNum(num, 23, 8, 96); return true;
            case 'subSize': if (e.type !== 'card') return false; e.subSize = clampNum(num, 15, 8, 72); return true;
            case 'labelSize': if (e.type !== 'panel') return false; e.labelSize = clampNum(num, 15, 8, 64); return true;
            case 'size': if (e.type !== 'text') return false; e.size = clampNum(num, 24, 8, 200); return true;
            default: return false;
          }
        }, LABEL[k] || '批量修改');
      };
    });

    inspector.querySelectorAll('select[data-m]').forEach((s) => {
      const k = s.dataset.m;
      s.onchange = () => {
        const v = s.value;
        if (v === '') return;
        apply((e) => {
          switch (k) {
            case 'layout': if (e.type !== 'card') return false; e.layout = v; return true;
            case 'shadow': if (e.type !== 'card' && e.type !== 'panel') return false; e.shadow = Number(v) || 0; return true;
            case 'corners': if (e.type !== 'card' && e.type !== 'panel') return false; e.corners = v === '1'; return true;
            case 'weight': if (e.type !== 'text') return false; e.weight = Number(v); return true;
            case 'align': if (e.type !== 'text') return false; e.align = v; return true;
            default: return false;
          }
        }, LABEL[k] || '批量修改');
      };
    });

    inspector.querySelectorAll('[data-mcolor]').forEach((btn) => {
      const k = btn.dataset.mcolor;
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const cur = multiColor(list, k);
        openColorPicker(btn, cur, (val) => {
          for (const e of list) if (setColor(e, k, val)) paintColor(e, k, val);
          btn.querySelector('i').style.background = val;
          saveSoon();
        });
      };
    });

    inspector.querySelectorAll('.swatch[data-color]').forEach((sw) => {
      sw.onclick = () => {
        const col = sw.dataset.color;
        apply((e) => {
          if (e.type === 'panel') { e.accent = col; return true; }
          return false;
        }, '强调色');
      };
    });

    inspector.querySelectorAll('[data-mact="icon"]').forEach((inp) => {
      inp.onchange = (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => apply((e) => {
          if (e.type !== 'card') return false;
          e.icon = rd.result; e.iconKey = null; return true;
        }, '图标');
        rd.readAsDataURL(f);
      };
    });
    inspector.querySelectorAll('[data-mact="iconClear"]').forEach((b) => {
      b.onclick = () => apply((e) => {
        if (e.type !== 'card') return false;
        e.icon = null; e.iconKey = null; return true;
      }, '清除图标');
    });
    inspector.querySelectorAll('[data-act="centerCanvas"]').forEach((b) => {
      b.onclick = () => {
        pushHistory();
        centerInCanvas(list);
        renderAll();
        commit();
        setStatus(`居中于画布 · ${list.length} 个`);
      };
    });
  }

  function bindInspector(e) {
    const ins = inspector;
    ins.querySelectorAll('input[data-k], select[data-k], textarea[data-k]').forEach((inp) => {
      const k = inp.dataset.k;
      let editing = false;
      const finish = () => { if (editing) { editing = false; pushHistory(); } };   // 记录改动后
      const commit = () => {
        if (!editing) { editing = true; pushHistory(); }                           // 记录改动前
        let v = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (inp.type === 'number') v = v === '' ? 0 : Number(v);
        if (k === 'fillAlpha') e.fillAlpha = Math.round(Number(v)) / 100;
        else e[k] = v;
        if (k === 'corners') e.corners = !!v;
        if (k === 'shadow') e.shadow = Number(v) || 0;
        if (k === 'titleSize') e.titleSize = clampNum(v, 23, 8, 96);
        if (k === 'labelSize') e.labelSize = clampNum(v, 15, 8, 64);
        if (k === 'subSize') e.subSize = clampNum(v, 15, 8, 72);
        if (['x', 'y', 'w', 'h', 'radius', 'size', 'opacity', 'strokeW'].includes(k)) {
          if (k === 'w') e.w = Math.max(20, Number(v));
          if (k === 'h') e.h = Math.max(16, Number(v));
        }
        const n = nodes.get(e.id);
        if (n) {
          const fresh = buildNode(e);
          if (sel.has(e.id)) fresh.classList.add('selected');
          n.replaceWith(fresh);
          nodes.set(e.id, fresh);
        }
        renderArrows();
        saveSoon();
      };
      inp.addEventListener('change', () => { commit(); finish(); });
      inp.addEventListener('blur', finish);
      if (inp.tagName === 'TEXTAREA' || inp.type === 'text') inp.addEventListener('input', commit);
      if (inp.type === 'range') {
        inp.addEventListener('input', () => {
          commit();
          const pct = inp.parentElement.querySelector('.pctv');
          if (pct) pct.textContent = inp.value + '%';
        });
      }
    });

    ins.querySelectorAll('.seg[data-k]').forEach((seg) => {
      const k = seg.dataset.k;
      seg.querySelectorAll('button').forEach((b) => {
        b.onclick = (ev) => {
          ev.stopPropagation();
          pushHistory();
          e[k] = b.dataset.v;
          seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          renderArrows();
          saveSoon();
          commit();
        };
      });
    });

    ins.querySelectorAll('[data-color]').forEach((btn) => {
      const k = btn.dataset.color;
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const cur = k === 'fillColor' ? panelFill(e)
          : k === 'stroke' ? (e.stroke || hexA(e.accent || '#7ea6ff', 0.5))
          : k === 'fill' ? (e.fill || 'rgba(10,10,10,.55)')
          : k === 'titleColor' ? (e.titleColor || '#f5f5f5')
          : k === 'subColor' ? (e.subColor || '#a3a3a3')
          : k === 'labelColor' ? (e.labelColor || '#d4d4d4')
          : (e[k] || '#7ea6ff');
        openColorPicker(btn, cur, (val) => {
          if (k === 'fillColor') {
            const p = parseColor(val) || { r: 20, g: 28, b: 45, a: 1 };
            e.fillColor = `#${hx2(p.r)}${hx2(p.g)}${hx2(p.b)}`;
            e.fillAlpha = Math.round(p.a * 100) / 100;
            e.fill = null;
            const pct = ins.querySelector('.pctv');
            const rng = ins.querySelector('[data-k="fillAlpha"]');
            if (rng) rng.value = Math.round(e.fillAlpha * 100);
            if (pct) pct.textContent = Math.round(e.fillAlpha * 100) + '%';
          } else {
            e[k] = val;
          }
          const n = nodes.get(e.id);
          if (n) {
            if (k === 'stroke') { n.style.borderColor = val; if (e.type === 'card') n.style.setProperty('--accent', val); }
            else if (k === 'labelColor') { const l = n.querySelector('.label'); if (l) l.style.color = val; }
            else if (k === 'fill') n.style.background = val;
            else if (k === 'titleColor') { const t = n.querySelector('.title'); if (t) t.style.color = val; }
            else if (k === 'subColor') { const sb = n.querySelector('.sub'); if (sb) sb.style.color = val; }
            else if (e.type === 'panel') n.style.background = panelFill(e);
            else if (e.type === 'text') n.style.color = e.color;
          }
          if (e.type === 'arrow') renderArrows();
          btn.querySelector('i').style.background = k === 'fillColor' ? panelFill(e) : (e[k] || 'transparent');
          saveSoon();
        });
      };
    });

    ins.querySelectorAll('.swatch').forEach((s) => {
      s.onclick = () => {
        e.accent = s.dataset.color;
        pushHistory();
        const n = nodes.get(e.id);
        if (n) { const fresh = buildNode(e); if (sel.has(e.id)) fresh.classList.add('selected'); n.replaceWith(fresh); nodes.set(e.id, fresh); }
        renderInspector(); renderArrows(); saveSoon();
      };
    });

    ins.querySelectorAll('[data-act]').forEach((btn) => {
      const act = btn.dataset.act;
      if (act === 'icon' || act === 'img' || act === 'bg') {
        btn.onchange = (ev) => {
          const f = ev.target.files && ev.target.files[0];
          if (!f) return;
          const r = new FileReader();
          r.onload = () => {
            if (act === 'img') e.src = r.result;
            else if (act === 'bg') e.bg = r.result;
            else { e.icon = r.result; e.iconKey = null; }
            pushHistory();
            const n = nodes.get(e.id);
            if (n) { const fresh = buildNode(e); if (sel.has(e.id)) fresh.classList.add('selected'); n.replaceWith(fresh); nodes.set(e.id, fresh); }
            renderInspector();
            saveSoon();
          };
          r.readAsDataURL(f);
        };
        return;
      }
      btn.onclick = () => {
        if (act === 'iconClear') { e.icon = null; e.iconKey = null; pushHistory(); renderAll(); }
        if (act === 'bgClear') { e.bg = null; pushHistory(); renderAll(); }
        if (act === 'front') { e.z = (e.z || 0) + 10; pushHistory(); renderAll(); }
        if (act === 'back') { e.z = (e.z || 0) - 10; pushHistory(); renderAll(); }
        if (act === 'centerCanvas') {
          pushHistory();
          centerInCanvas([e]);
          renderAll();
        }
      };
    });
  }


  /* ---------------------------------------------------------- 画布检查器 */
  const RATIOS = [['', '自由'], ['16:9', '16:9'], ['16:10', '16:10'], ['4:3', '4:3'], ['3:2', '3:2'], ['1:1', '1:1']];
  function canvasInspector(c) {
    const ratio = (c.w / c.h).toFixed(4);
    const hit = RATIOS.find(([k]) => k && Math.abs(k.split(':').reduce((a, b) => a / b) - ratio) < 0.01);
    return `<h4>画布</h4>
      <div class="row"><label>名称</label><input type="text" data-k="name" class="cv-name-input" value="${esc(c.name || '')}" /></div>
      <div class="row"><label>位置</label>
        <input type="number" data-k="x" value="${Math.round(c.x)}" />
        <input type="number" data-k="y" value="${Math.round(c.y)}" /></div>
      <div class="row"><label>尺寸</label>
        <input type="number" data-k="w" value="${Math.round(c.w)}" />
        <input type="number" data-k="h" value="${Math.round(c.h)}" /></div>
      <div class="row"><label>比例</label>
        <select data-k="ratio">
          ${RATIOS.map(([k, t]) => `<option value="${k}" ${(hit ? hit[0] : '') === k ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <label class="chk"><input type="checkbox" data-k="lockRatio" ${c.lockRatio ? 'checked' : ''} /> 锁定</label></div>
      <div class="row"><label>背景色</label>
        ${colorSwatch('bgColor', c.bgColor || 'transparent')}
        <button class="mini-btn" data-act="cvBgClear" ${c.bgColor ? '' : 'disabled'}>透明</button></div>
      <div class="row"><label>背景图</label>
        <label class="mini-btn upload" style="flex:1;display:flex;align-items:center;justify-content:center">${c.bgImage ? '更换' : '上传'}
          <input type="file" data-act="cvBg" accept="image/*" hidden /></label>
        <button class="mini-btn" data-act="cvBgImgClear" ${c.bgImage ? '' : 'disabled'}>清除</button></div>
      ${c.bgImage ? `<div class="row"><label>铺法</label>
        <select data-k="bgFit">
          <option value="cover" ${c.bgFit !== 'fill' ? 'selected' : ''}>铺满（裁剪）</option>
          <option value="fill" ${c.bgFit === 'fill' ? 'selected' : ''}>拉伸（变形）</option>
        </select></div>` : ''}
      <div class="divider"></div>
      <div class="hintline">只有完整落在画布内的元素才归属该画布；拖出去即脱离。</div>
      <div class="mini icons">
        <button data-act="cvFit" title="缩放到此画布" aria-label="缩放到此画布"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 2.6h3.8v3.8M13.4 2.6 9 7M2.6 9.6v3.8h3.8M2.6 13.4 7 9"/></svg></button>
        <button data-act="cvExport" title="导出此画布" aria-label="导出此画布"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v7.4M5.2 7.1 8 9.9l2.8-2.8"/><path d="M2.5 12v1.5h11V12"/></svg></button>
        <button data-act="cvDelete" class="danger" title="删除画布" aria-label="删除画布"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 4.4h10.8M6.2 4.4V2.8h3.6v1.6M4.1 4.4l.7 8.8h6.4l.7-8.8M6.7 6.8v4M9.3 6.8v4"/></svg></button>
      </div>`;
  }

  function bindCanvasInspector(c) {
    const ins = inspector;
    ins.querySelectorAll('input[data-k], select[data-k], textarea[data-k]').forEach((inp) => {
      let editing = false;
      const finish = () => { if (editing) { editing = false; pushHistory(); } };
      inp.addEventListener('blur', finish);
      inp.addEventListener('change', finish);
      inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' || inp.type === 'color' ? 'change' : 'input', () => {
        if (!editing) { editing = true; pushHistory(); }
        const k = inp.dataset.k;
        let v = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (inp.type === 'number') v = v === '' ? 0 : Number(v);
        if (k === 'ratio') {
          if (v) {
            const r = v.split(':').reduce((a, b) => a / b);
            c.w = Math.round(c.w); c.h = Math.round(c.w / r);
            c.ratio = v;
          }
          renderAll(); return;
        }
        c[k] = v;
        if (k === 'w') c.w = Math.max(80, v);
        if (k === 'h') c.h = Math.max(60, v);
        renderCanvases(); renderLayerTree(); renderMinimap(); saveSoon();
      });
    });
    ins.querySelectorAll('[data-color]').forEach((btn) => {
      const k = btn.dataset.color;
      btn.onclick = (ev) => {
        ev.stopPropagation();
        openColorPicker(btn, c[k] || '#0a0a0a', (val) => {
          c[k] = val;
          renderCanvases(); renderMinimap(); saveSoon();
          btn.querySelector('i').style.background = val;
          const clr = ins.querySelector('[data-act="cvBgClear"]');
          if (clr) clr.disabled = false;
        });
      };
    });

    ins.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'cvBg') return;
        if (act === 'cvBgClear') { pushHistory(); c.bgColor = null; renderCanvases(); renderInspector(); saveSoon(); return; }
        if (act === 'cvBgImgClear') { pushHistory(); c.bgImage = null; renderCanvases(); renderInspector(); saveSoon(); return; }
        if (act === 'cvFit') {
          const r = viewport.getBoundingClientRect();
          zoom = clamp(Math.min(r.width / (c.w + 120), r.height / (c.h + 120)), 0.02, 2);
          panX = r.width / 2 - (c.x + c.w / 2) * zoom;
          panY = r.height / 2 - (c.y + c.h / 2) * zoom;
          applyView(); return;
        }
        if (act === 'cvExport') { exportPNG({ x: c.x, y: c.y, w: c.w, h: c.h }, c.name || 'canvas'); return; }
        if (act === 'cvDelete') { deleteSel(); return; }
      });
    });
    const file = ins.querySelector('[data-act="cvBg"]');
    if (file) file.onchange = (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        pushHistory();
        c.bgImage = r.result;
        renderCanvases(); renderInspector(); renderMinimap(); saveSoon();
      };
      r.readAsDataURL(f);
    };
  }

  /* ---------------------------------------------------------------- 对齐 */
  // 对齐/居中的参考矩形：优先用选区所在的画布；元素不在任何画布里才退回画板。
  // 之前直接用画板 W×H，画布不在 (0,0) 时就会「居中到画布外面」。
  function refBounds(list) {
    const cs = canvases().filter((c) => list.some((e) => canvasOfElement(e) === c));
    if (!cs.length) return { x: 0, y: 0, w: W, h: H };
    const x0 = Math.min(...cs.map((c) => c.x)), y0 = Math.min(...cs.map((c) => c.y));
    const x1 = Math.max(...cs.map((c) => c.x + c.w)), y1 = Math.max(...cs.map((c) => c.y + c.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function centerInCanvas(list) {
    list = list.filter((e) => e.type !== 'arrow');
    if (!list.length) return;
    const b = unionBounds(list), r = refBounds(list);
    const dx = round(r.x + r.w / 2 - (b.x + b.w / 2));
    const dy = round(r.y + r.h / 2 - (b.y + b.h / 2));
    for (const e of list) { e.x = round(e.x + dx); e.y = round(e.y + dy); }
  }

  function align(kind) {
    const list = selEls().filter((e) => e.type !== 'arrow');
    if (!list.length) return;
    pushHistory();
    if (kind === 'canvas') {
      centerInCanvas(list);
      renderAll(); return;
    }
    if (list.length === 1) {
      const e = list[0];
      const r = refBounds(list);
      if (kind === 'left') e.x = round(r.x);
      if (kind === 'right') e.x = round(r.x + r.w - e.w);
      if (kind === 'top') e.y = round(r.y);
      if (kind === 'bottom') e.y = round(r.y + r.h - e.h);
      if (kind === 'cx') e.x = round(r.x + (r.w - e.w) / 2);
      if (kind === 'cy') e.y = round(r.y + (r.h - e.h) / 2);
      renderAll(); return;
    }
    const b = unionBounds(list);
    if (kind === 'left') for (const e of list) e.x = b.x;
    if (kind === 'right') for (const e of list) e.x = b.x + b.w - e.w;
    if (kind === 'cx') for (const e of list) e.x = round(b.x + (b.w - e.w) / 2);
    if (kind === 'top') for (const e of list) e.y = b.y;
    if (kind === 'bottom') for (const e of list) e.y = b.y + b.h - e.h;
    if (kind === 'cy') for (const e of list) e.y = round(b.y + (b.h - e.h) / 2);
    if (kind === 'dh' || kind === 'dv') {
      const horiz = kind === 'dh';
      const sorted = [...list].sort((p, q) => (horiz ? p.x - q.x : p.y - q.y));
      const total = horiz ? b.w : b.h;
      const sum = sorted.reduce((s, e) => s + (horiz ? e.w : e.h), 0);
      const gap = (total - sum) / (sorted.length - 1);
      let cur = horiz ? b.x : b.y;
      for (const e of sorted) {
        if (horiz) { e.x = round(cur); cur += e.w + gap; }
        else { e.y = round(cur); cur += e.h + gap; }
      }
    }
    renderAll();
    commit();
  }

  /* ---------------------------------------------------------------- 操作 */
  function deleteSel() {
    if (selCanvas) {
      pushHistory();
      state.canvases = canvases().filter((c) => c.id !== selCanvas);
      selCanvas = null;
      renderAll();
      commit();
      return;
    }
    if (!sel.size) return;
    pushHistory();
    state.elements = state.elements.filter((e) => !sel.has(e.id) && !(e.type === 'arrow' && (sel.has(e.from) || sel.has(e.to))));
    sel.clear();
    renderAll();
    commit();
  }

  function duplicateSel() {
    const list = selEls();
    if (!list.length) return;
    pushHistory();
    const map = new Map();
    const copies = [];
    for (const e of list) {
      if (e.type === 'arrow') continue;
      const c = JSON.parse(JSON.stringify(e));
      c.id = uid(e.type[0]);
      c.x += 24; c.y += 24; c.z = (e.z || 0) + 1;
      if (c.layerId && !layerById(c.layerId)) c.layerId = null;
      map.set(e.id, c.id);
      copies.push(c);
      state.elements.push(c);
    }
    sel.clear();
    copies.forEach((c) => sel.add(c.id));
    renderAll();
    commit();
  }

  function nudge(dx, dy) {
    if (!sel.size) return;
    pushHistory();
    for (const e of selEls()) { e.x = round(e.x + dx); e.y = round(e.y + dy); }
    renderAll();
  }

  /* ---------------------------------------------------------------- 工具条 */
  function setTool(t) {
    tool = t;
    document.querySelectorAll('#bar .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    viewport.classList.toggle('tool-arrow', t === 'arrow');
    viewport.classList.toggle('tool-canvas', t === 'canvas');
    if (t !== 'arrow') { arrowPick.from = null; setStatus(''); }
    anchorEl = null;
    renderAnchors();
  }
  document.querySelectorAll('#bar .tool').forEach((b) => {
    b.onclick = () => setTool(b.dataset.tool);
  });
  document.querySelectorAll('#alignGroup button').forEach((b) => {
    b.onclick = () => align(b.dataset.align);
  });
  $('#undoBtn').onclick = undo;
  $('#redoBtn').onclick = redo;
  $('#dupBtn').onclick = duplicateSel;
  $('#delBtn').onclick = deleteSel;
  $('#zoomIn').onclick = () => { const r = viewport.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.15); };
  $('#zoomOut').onclick = () => { const r = viewport.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.15); };
  $('#snapBtn').onclick = () => {
    snapOn = !snapOn;
    $('#snapBtn').classList.toggle('active', snapOn);
    setStatus(snapOn ? '吸附开' : '吸附关');
    setTimeout(() => setStatus(''), 900);
  };
  $('#zoomLabel').onclick = fitView;

  $('#jsonBtn').onclick = (ev) => {
    if (ev.altKey) {
      // ⌥ 点击：导出 PNG（选中画布时只导出该画布）
      if (selCanvas) {
        const c = canvasById(selCanvas);
        if (c) return exportPNG({ x: c.x, y: c.y, w: c.w, h: c.h }, c.name);
      }
      return exportPNG();
    }
    if (ev.shiftKey) {
      // ⇧ 导出纯 JSON（不含图片，便于 diff / 备份结构）
      const blob = new Blob([JSON.stringify({
        _meta: { app: AUTHOR.app, author: AUTHOR.name, github: AUTHOR.github, email: AUTHOR.email, at: new Date().toISOString() },
        elements: state.elements, bg: state.bg, canvases: state.canvases, layers: state.layers,
      }, null, 1)], { type: 'application/json' });
      downloadBlob(blob, `架构板-${stamp()}.json`);
      setStatus('已导出 JSON（图片以 base64 内嵌）');
      setTimeout(() => setStatus(''), 2200);
      return;
    }
    exportProject();
  };
  // 用按钮 + 程序化 click：<label> 包 hidden input 在部分浏览器/文件管理器里
  // 会因为 accept 里有未知扩展名（.archboard）而把文件灰掉，点了像没反应。
  $('#importBtn').onclick = () => $('#jsonInput').click();
  $('#jsonInput').onchange = (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    importFile(f).finally(() => { ev.target.value = ''; });
  };

  // 拖拽导入：比找按钮快，也是"文件拖进来没反应"最常见的场景
  let dragDepth = 0;
  const hasFiles = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    $('#dropHint').classList.add('on');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    // relatedTarget 为 null 说明已经离开窗口，直接收起来，避免浮层卡住
    if (e.relatedTarget === null) dragDepth = 1;
    if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').classList.remove('on'); }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#dropHint').classList.remove('on');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (/\.(archboard|json)$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/json') {
      importFile(f);
    } else {
      toast('只支持 .archboard / .json');
    }
  });
  /* ---------------------------------------------------------------- 键盘 */
  const TOOL_ORDER = ['select', 'panel', 'card', 'text', 'image', 'arrow', 'canvas'];
  window.addEventListener('keydown', (ev) => {
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const mod = ev.metaKey || ev.ctrlKey;
    if (ev.code === 'Space') { spaceDown = true; viewport.style.cursor = 'grab'; ev.preventDefault(); return; }
    if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
    if (mod && ev.key.toLowerCase() === 'd') { ev.preventDefault(); duplicateSel(); return; }
    if (mod && ev.key.toLowerCase() === 'g') { ev.preventDefault(); ev.shiftKey ? ungroupSelection() : groupSelection(); return; }
    if (mod && ev.key === '\\') { ev.preventDefault(); document.body.classList.toggle('layers-open'); renderMinimap(); return; }
    if (mod && ev.key.toLowerCase() === 'a') {
      ev.preventDefault(); sel = new Set(state.elements.filter((e) => e.type !== 'arrow' && selectable(e)).map((e) => e.id)); selCanvas = null; syncSelection(true); return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteSel(); return; }
    if (ev.key === 'Escape') {
      if (CP.pop && CP.pop.classList.contains('on')) { closeColorPicker(); ev.preventDefault(); return; } sel.clear(); selCanvas = null; syncSelection(); renderCanvases(); setTool('select'); return; }
    // ⌘/Ctrl + 1~7（以及 ⌥ + 1~7）：按工具栏顺序切工具。
    // Chrome 把 ⌘+数字占用成「切换标签页」，页面拦不到，所以额外支持 ⌥+数字。
    const digit = /^Digit([1-7])$/.exec(ev.code || '');
    if (digit && (mod || ev.altKey)) {
      ev.preventDefault();
      setTool(TOOL_ORDER[Number(digit[1]) - 1]);
      return;
    }
    if (ev.key === 'v' || ev.key === 'V') setTool('select');
    if (ev.key === 'p' || ev.key === 'P') setTool('panel');
    if (ev.key === 'c' || ev.key === 'C') setTool('card');
    if (ev.key === 't' || ev.key === 'T') setTool('text');
    if (ev.key === 'i' || ev.key === 'I') setTool('image');
    if (ev.key === 'a' || ev.key === 'A') setTool('arrow');
    if (ev.key === 'n' || ev.key === 'N') { setTool('canvas'); setStatus('在空白处点击即可创建画布'); }
    if (ev.key === 'm' || ev.key === 'M') {
      showMinimap = !showMinimap;
      renderMinimap();
      setStatus(showMinimap ? '鸟瞰图已显示' : '鸟瞰图已隐藏');
    }
    if (ev.key === '0') fitView();
    const step = ev.shiftKey ? 10 : 1;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); nudge(-step, 0); }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); nudge(step, 0); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); nudge(0, -step); }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); nudge(0, step); }
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') { spaceDown = false; viewport.style.cursor = ''; }
  });

  viewport.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    // 捏合手势 / Ctrl(⌘)+滚轮 → 缩放
    if (ev.ctrlKey || ev.metaKey) {
      zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.08 : 1 / 1.08);
      return;
    }
    // 触控板双指 → 自由平移（含惯性增量），shift 强制横向
    const dx = ev.shiftKey ? ev.deltaY : ev.deltaX;
    const dy = ev.shiftKey ? 0 : ev.deltaY;
    panX -= dx;
    panY -= dy;
    applyView();
  }, { passive: false });

  window.addEventListener('resize', () => { applyView(); renderMinimap(); });

  /* ---------------------------------------------------------------- 导出 */
  // 导出区域：给了合法矩形就用它（画布导出），否则取所有内容的外接框
  function exportRect(region) {
    if (region && isFinite(region.x) && isFinite(region.y) && isFinite(region.w) && isFinite(region.h) && region.w > 0 && region.h > 0) {
      return { x: region.x, y: region.y, w: region.w, h: region.h };
    }
    const b = worldBounds();
    return { x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h) };
  }

  async function buildExportCanvas(region, S = 2) {
    const R = exportRect(region);
    const cv = document.createElement('canvas');
    cv.width = Math.round(R.w * S); cv.height = Math.round(R.h * S);
    const ctx = cv.getContext('2d');
    ctx.scale(S, S);
    // 平移到区域原点，之后所有元素坐标照旧
    ctx.translate(-R.x, -R.y);
    ctx.save();
    ctx.translate(R.x, R.y);      // 底色只填区域内
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, R.w, R.h);
    ctx.restore();

    {
      const c = canvases().find((k) => k.x === R.x && k.y === R.y && k.w === R.w && k.h === R.h);
      if (c) {
        if (c.bgColor) { ctx.fillStyle = c.bgColor; ctx.fillRect(R.x, R.y, R.w, R.h); }
        if (c.bgImage) {
          const im = await loadImg(c.bgImage);
          if (c.bgFit === 'fill') ctx.drawImage(im, R.x, R.y, R.w, R.h);
          else drawCover(ctx, im, R.x, R.y, R.w, R.h);
        }
      }
    }

    const sorted = [...state.elements].sort((a, b) => (a.z || 0) - (b.z || 0));
    for (const e of sorted) {
      if (e.type === 'arrow') continue;
      if (!isVisible(e)) continue;
      ctx.globalAlpha = e.opacity == null ? 1 : e.opacity;
      if (e.type === 'panel') await drawPanel(ctx, e);
      else if (e.type === 'card') await drawCard(ctx, e);
      else if (e.type === 'text') drawText(ctx, e);
      else if (e.type === 'image' && e.src) {
        const im = await loadImg(e.src);
        const fit = e.fit || 'cover';
        const r = e.radius == null ? 0 : e.radius;
        if (fit === 'tile') {
          ctx.save();
          ctx.beginPath(); ctx.roundRect(e.x, e.y, e.w, e.h, r); ctx.clip();
          const pat = ctx.createPattern(im, 'repeat');
          if (pat) { ctx.fillStyle = pat; ctx.fillRect(e.x, e.y, e.w, e.h); }
          ctx.restore();
        } else if (fit === 'fill') {
          ctx.save();
          ctx.beginPath(); ctx.roundRect(e.x, e.y, e.w, e.h, r); ctx.clip();
          ctx.drawImage(im, e.x, e.y, e.w, e.h);
          ctx.restore();
        } else {
          ctx.save();
          ctx.beginPath(); ctx.roundRect(e.x, e.y, e.w, e.h, r); ctx.clip();
          drawCover(ctx, im, e.x, e.y, e.w, e.h);
          ctx.restore();
        }
      }
    }
    ctx.globalAlpha = 1;
    for (const a of state.elements) {
      if (a.type !== 'arrow') continue;
      const { p1, p2 } = arrowGeometry(a);
      const col = a.color || '#c8c8c8';
      const lw = a.strokeW == null ? 1 : Math.max(0.5, Number(a.strokeW) || 1);
      const head = a.head || 'triangle';
      const tail = a.double ? head : 'none';
      const mode = a.mode || 'bezier';

      // 轮廓点：贝塞尔采样 32 段，直/折线直接给折点
      // 与屏幕渲染一致：箭头长度内走直线 + 两端按 trim 收线（线头不戳出箭头）
      const trimW = 1.55 * lw + 1.2;
      const tr1 = tail !== 'none' ? trimW : 0;
      const tr2 = head !== 'none' ? trimW : 0;
      const end1 = { x: p1.x + (p1.nx || 0) * tr1, y: p1.y + (p1.ny || 0) * tr1 };
      const end2 = { x: p2.x + (p2.nx || 0) * tr2, y: p2.y + (p2.ny || 0) * tr2 };
      let pts;
      if (mode === 'straight') {
        const dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy) || 1;
        const c1t = Math.min(tr1, L * 0.4), c2t = Math.min(tr2, L * 0.4);
        pts = [
          { x: p1.x + (dx / L) * c1t, y: p1.y + (dy / L) * c1t },
          { x: p2.x - (dx / L) * c2t, y: p2.y - (dy / L) * c2t },
        ];
      } else if (mode === 'elbow') {
        const dx = Math.abs(p2.x - p1.x), dy = Math.abs(p2.y - p1.y);
        pts = trimPolyline(dx > dy
          ? [p1, { x: (p1.x + p2.x) / 2, y: p1.y }, { x: (p1.x + p2.x) / 2, y: p2.y }, p2]
          : [p1, { x: p1.x, y: (p1.y + p2.y) / 2 }, { x: p2.x, y: (p1.y + p2.y) / 2 }, p2], tr1, tr2);
      } else {
        const { c1, c2 } = curvePts(p1, p2);
        const cap = Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.34;
        const tW = (8 + 2.2 * lw) * 1.15;
        const a1 = Math.min(tr1 > 0 ? Math.max(tW, tr1) : 0, cap);
        const a2 = Math.min(tr2 > 0 ? Math.max(tW, tr2) : 0, cap);
        const s1 = a1 > tr1 + 0.2 ? { x: p1.x + (p1.nx || 0) * a1, y: p1.y + (p1.ny || 0) * a1 } : end1;
        const s2 = a2 > tr2 + 0.2 ? { x: p2.x + (p2.nx || 0) * a2, y: p2.y + (p2.ny || 0) * a2 } : end2;
        pts = [end1];
        if (s1 !== end1) pts.push(s1);
        for (let i = 0; i <= 32; i++) {
          const t = i / 32, u = 1 - t;
          pts.push({
            x: u * u * u * s1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * s2.x,
            y: u * u * u * s1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * s2.y,
          });
        }
        if (s2 !== end2) pts.push(end2);
      }

      ctx.save();
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (a.dash === 'dash') ctx.setLineDash([9, 7]);
      else if (a.dash === 'dot') ctx.setLineDash([1.6, 6]);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.setLineDash([]);

      const drawHead = (tip, prev, kind) => {
        if (!prev || kind === 'none') return;
        const ang = Math.atan2(tip.y - prev.y, tip.x - prev.x);
        if (kind === 'triangle') {
          const L = 8 + 2.2 * lw, w = L * 0.38;
          ctx.beginPath();
          ctx.moveTo(tip.x, tip.y);
          ctx.lineTo(tip.x - L * Math.cos(ang) + w * Math.sin(ang), tip.y - L * Math.sin(ang) - w * Math.cos(ang));
          ctx.lineTo(tip.x - L * Math.cos(ang) - w * Math.sin(ang), tip.y - L * Math.sin(ang) + w * Math.cos(ang));
          ctx.closePath();
          ctx.fill();
        } else if (kind === 'arrow') {
          const L = 12 + lw, sp = 0.52;
          ctx.beginPath();
          ctx.moveTo(tip.x - L * Math.cos(ang - sp), tip.y - L * Math.sin(ang - sp));
          ctx.lineTo(tip.x, tip.y);
          ctx.lineTo(tip.x - L * Math.cos(ang + sp), tip.y - L * Math.sin(ang + sp));
          ctx.stroke();
        } else if (kind === 'circle') {
          ctx.beginPath();
          ctx.arc(tip.x, tip.y, 3.4 + lw * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      drawHead(p2, pts[pts.length - 2], head);
      if (tail !== 'none') drawHead(p1, pts[1], tail);
      ctx.restore();
    }

    return cv;
  }

  async function exportPNG(region, name) {
    const cv = await buildExportCanvas(region, 2);
    const a = document.createElement('a');
    a.href = cv.toDataURL('image/png');
    a.download = (name ? String(name).trim() : '架构图') + '.png';
    a.click();
    return { w: cv.width, h: cv.height };
  }

  const loadImg = (src) => new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });

  function drawCover(ctx, im, x, y, w, h) {
    const r = Math.max(w / im.width, h / im.height);
    const dw = im.width * r, dh = im.height * r;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.drawImage(im, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  }

  function rr(ctx, e, fill, stroke, lw) {
    const r = e.radius == null ? 10 : e.radius;
    ctx.beginPath();
    ctx.roundRect(e.x, e.y, e.w, e.h, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }

  // 卡片外阴影：与 SHADOW 档位一一对应
  function applyShadow(ctx, lvl) {
    const blur = [0, 8, 20, 36][lvl] || 0;
    const dy = [0, 2, 6, 14][lvl] || 0;
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = dy;
  }

  // 制图角标：左上/右上必画，四角容器再加左下/右下
  function cornerTicks(ctx, x, y, w, h, len, color, all) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
    ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
    if (all) {
      ctx.moveTo(x, y + h - len); ctx.lineTo(x, y + h); ctx.lineTo(x + len, y + h);
    }
    ctx.moveTo(x + w - len, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - len);
    ctx.stroke();
    ctx.restore();
  }

  async function drawPanel(ctx, e) {
    const accent = e.accent || '#7ea6ff';
    const ls = clampNum(e.labelSize, 15, 8, 64);
    if (e.shadow) { ctx.save(); applyShadow(ctx, e.shadow); }
    rr(ctx, e, panelFill(e), e.shadow ? null : (e.stroke || hexA(accent, 0.5)), 1);
    if (e.shadow) {
      ctx.restore();
      ctx.beginPath(); ctx.roundRect(e.x, e.y, e.w, e.h, e.radius == null ? 10 : e.radius);
      ctx.strokeStyle = e.stroke || hexA(accent, 0.5); ctx.lineWidth = 1; ctx.stroke();
    }
    if (e.corners !== false) cornerTicks(ctx, e.x + 6, e.y + 6, e.w - 12, e.h - 12, 11, hexA(accent, 0.85), true);
    if (e.bg) {
      const im = await loadImg(e.bg);
      if (im) {
        ctx.save();
        ctx.beginPath(); ctx.roundRect(e.x, e.y, e.w, e.h, e.radius == null ? 10 : e.radius); ctx.clip();
        const s = Math.max(e.w / im.width, e.h / im.height);
        const dw = im.width * s, dh = im.height * s;
        ctx.drawImage(im, e.x + (e.w - dw) / 2, e.y + (e.h - dh) / 2, dw, dh);
        ctx.restore();
      }
    }
    const colW = 150;
    // 图标列与内容区之间的虚线分隔
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = hexA(accent, 0.18); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(e.x + colW, e.y + 10); ctx.lineTo(e.x + colW, e.y + e.h - 10); ctx.stroke();
    ctx.restore();
    if (e.icon) {
      const im = await loadImg(e.icon);
      const bx = e.x + colW / 2 - 38, by = e.y + 21;
      ctx.save();
      ctx.beginPath(); ctx.rect(bx, by, 76, 76); ctx.clip();
      ctx.fillStyle = hexA(accent, 0.06); ctx.fill();
      ctx.restore();
      ctx.beginPath(); ctx.rect(bx, by, 76, 76);
      ctx.strokeStyle = hexA(accent, 0.34); ctx.lineWidth = 1; ctx.stroke();
      if (im) ctx.drawImage(im, bx + 10, by + 10, 56, 56);
    }
    if (e.label) {
      // 与 DOM 一致：标签限制在图标列内自动换行，整体垂直居中
      ctx.font = `500 ${ls}px ${FONT}`;
      const lines = wrapText(ctx, e.label, colW - 18);
      const lh = Math.round(ls * 1.3);
      const blockH = lines.length * lh;
      const anchor = e.icon ? e.y + 121 : e.y + e.h / 2;
      let ty = anchor - blockH / 2 + lh * 0.78;
      ctx.fillStyle = e.labelColor || '#d4d4d4';
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      for (const line of lines) { ctx.fillText(line, e.x + colW / 2, ty); ty += lh; }
      ctx.textAlign = 'left';
    }
  }

  async function drawCard(ctx, e) {
    const accent = e.accent || '#7ea6ff';
    const edge = e.stroke || hexA(accent, 0.32);
    const fill = e.fill || 'rgba(5,12,21,.55)';
    if (e.shadow) { ctx.save(); applyShadow(ctx, e.shadow); }
    rr(ctx, e, fill, e.shadow ? null : edge, 1);
    if (e.shadow) {                       // 描边单独画，避免阴影叠两层
      ctx.restore();
      ctx.beginPath();
      ctx.roundRect(e.x, e.y, e.w, e.h, e.radius == null ? 10 : e.radius);
      ctx.strokeStyle = edge; ctx.lineWidth = 1; ctx.stroke();
    }
    if (e.corners !== false) cornerTicks(ctx, e.x + 5, e.y + 5, e.w - 10, e.h - 10, 9, hexA(e.stroke || accent, 0.7), false);

    const ts = clampNum(e.titleSize, 23, 8, 96);
    const ss = clampNum(e.subSize, 15, 8, 72);
    const tc = e.titleColor || '#f5f5f5';
    const sc = e.subColor || '#a3a3a3';
    const lh1 = Math.round(ts * 1.22), lh2 = Math.round(ss * 1.24);
    const padL = 22, padR = 22;

    if (e.layout === 'stack') {
      const im = e.icon ? await loadImg(e.icon) : null;
      const iconSize = 72;
      ctx.textAlign = 'center';
      const cx = e.x + e.w / 2;
      const maxW = e.w - 36;
      ctx.font = `600 ${ts}px ${FONT}`;
      const l1 = wrapText(ctx, e.title || '', maxW);
      ctx.font = `400 ${ss}px ${FONT}`;
      const l2 = e.sub ? wrapText(ctx, e.sub, maxW) : [];
      const gapIcon = im ? 14 : 0;
      const hIcon = im ? iconSize : 0;
      const h1 = l1.length * lh1;
      const h2 = l2.length * lh2;
      const total = hIcon + gapIcon + h1 + (l2.length ? 8 : 0) + h2;
      let ty = e.y + (e.h - total) / 2;
      if (im) { ctx.drawImage(im, cx - iconSize / 2, ty, iconSize, iconSize); ty += iconSize + gapIcon; }
      ctx.textBaseline = 'top';
      ctx.fillStyle = tc;
      ctx.font = `600 ${ts}px ${FONT}`;
      for (const line of l1) { ctx.fillText(line, cx, ty); ty += lh1; }
      if (l2.length) {
        ty += 8;
        ctx.fillStyle = sc;
        ctx.font = `400 ${ss}px ${FONT}`;
        for (const line of l2) { ctx.fillText(line, cx, ty); ty += lh2; }
      }
      ctx.textAlign = 'left';
      return;
    }

    const cy = e.y + e.h / 2;
    let x = e.x + padL;
    if (e.icon) {
      const im = await loadImg(e.icon);
      if (im) ctx.drawImage(im, x, cy - 17, 34, 34);
      x += 34 + 12;
    }
    const maxW = e.x + e.w - padR - x;
    const gap = e.sub ? 6 : 0;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.font = `600 ${ts}px ${FONT}`;
    const l1 = wrapText(ctx, e.title || '', maxW);
    ctx.font = `400 ${ss}px ${FONT}`;
    const l2 = e.sub ? wrapText(ctx, e.sub, maxW) : [];
    const h1 = l1.length * lh1, h2 = l2.length * lh2;
    let ty = cy - (h1 + gap + h2) / 2;
    ctx.fillStyle = tc;
    ctx.font = `600 ${ts}px ${FONT}`;
    for (const line of l1) { ctx.fillText(line, x, ty); ty += lh1; }
    ty += gap;
    ctx.fillStyle = sc;
    ctx.font = `400 ${ss}px ${FONT}`;
    for (const line of l2) { ctx.fillText(line, x, ty); ty += lh2; }
  }

  function drawText(ctx, e) {
    const size = e.size || 24;
    ctx.font = `${e.weight || 500} ${size}px ${FONT}`;
    ctx.fillStyle = e.color || '#eaf1ff';
    ctx.textBaseline = 'top';
    ctx.textAlign = e.align === 'center' ? 'center' : e.align === 'right' ? 'right' : 'left';
    const ax = e.align === 'center' ? e.x + e.w / 2 : e.align === 'right' ? e.x + e.w : e.x;
    const lines = wrapText(ctx, e.text || '', e.w);
    let ty = e.y + Math.max(0, (e.h - lines.length * size * 1.25) / 2);
    for (const line of lines) { ctx.fillText(line, ax, ty); ty += size * 1.25; }
    ctx.textAlign = 'left';
  }

  function wrapText(ctx, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      if (!para) { out.push(''); continue; }
      let line = '';
      const tokens = para.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]|[A-Za-z0-9_@.\-]+|\s+|./g) || [];
      for (const t of tokens) {
        const next = line + t;
        if (ctx.measureText(next).width > maxW && line) { out.push(line); line = t.trim() === '' ? '' : t; }
        else line = next;
      }
      if (line) out.push(line);
    }
    return out;
  }

  /* ------------------------------------------------------------ 存储 / 工程包
     图片不再以 base64 塞在 JSON 里：落盘和导出时抽成 assets/<hash>，模型里只留
     asset:<hash> 引用。IndexedDB 存原始字节，容量按浏览器配额走
     （Chrome/Edge ≈ 磁盘 60%，Firefox ≈ 10%，Safari ≈ 1GB）。
     localStorage 只保留一份不带图片的小镜像，作崩溃兜底。 */
  const DB_NAME = 'archboard';
  const DB_VER = 1;
  const AT_KEY = LS_KEY + ':at';
  const ASSET = 'asset:';
  const DATA_URL_RE = /^data:image\/([a-z0-9+.\-]+);base64,/i;
  const IMG_EXT = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', avif: 'avif', 'svg+xml': 'svg' };
  const EXT_TYPE = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml' };

  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((res, rej) => {
      if (!self.indexedDB) { rej(new Error('indexedDB 不可用')); return; }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('state')) d.createObjectStore('state');
        if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets');
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error('数据库被占用'));
    });
    return dbPromise;
  }
  function idb(store, mode, fn) {
    return openDB().then((d) => new Promise((res, rej) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => res(req ? req.result : undefined);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('事务中止'));
    }));
  }
  const idbGet = (s, k) => idb(s, 'readonly', (st) => st.get(k));
  const idbPut = (s, k, v) => idb(s, 'readwrite', (st) => st.put(v, k));
  const idbClear = (s) => idb(s, 'readwrite', (st) => st.clear());

  function b64ToBytes(u) {
    const bin = atob(u.slice(u.indexOf(',') + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }
  const toDataUrl = (bytes, type) => `data:${type || 'image/png'};base64,${bytesToB64(bytes)}`;

  // 同步指纹（FNV-1a + 长度）：同一张图复用同一 id，够短也够稳
  function quickHash(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return ((h >>> 0).toString(16) + bytes.length.toString(36)).padStart(9, '0');
  }

  // 模型里所有可能放图片的字段
  function eachImage(model, fn) {
    if (model.bg) fn(model, 'bg');
    for (const c of model.canvases || []) if (c && c.bgImage) fn(c, 'bgImage');
    for (const e of model.elements || []) {
      if (!e) continue;
      if (e.icon) fn(e, 'icon');
      if (e.src) fn(e, 'src');
    }
  }

  // data URL → 资源引用（传进来的 model 必须是能就地改的副本）
  function packModel(model) {
    const assets = new Map();
    eachImage(model, (obj, key) => {
      const v = obj[key];
      if (typeof v !== 'string' || !DATA_URL_RE.test(v)) return;
      const sub = (DATA_URL_RE.exec(v)[1] || 'png').toLowerCase();
      const bytes = b64ToBytes(v);
      const hash = quickHash(bytes);
      const ext = IMG_EXT[sub] || 'png';
      if (!assets.has(hash)) assets.set(hash, { bytes, type: EXT_TYPE[ext] || 'image/png', ext });
      obj[key] = ASSET + hash;
    });
    return { json: JSON.stringify(model), assets };
  }

  // 资源引用 → data URL（还原成内存里的模型）
  async function unpackModel(model) {
    const jobs = [];
    eachImage(model, (obj, key) => {
      const v = obj[key];
      if (typeof v === 'string' && v.startsWith(ASSET)) jobs.push([obj, key, v.slice(ASSET.length)]);
    });
    if (!jobs.length) return model;
    const cache = new Map();
    for (const [obj, key, hash] of jobs) {
      if (!cache.has(hash)) {
        let rec = null;
        try { rec = await idbGet('assets', hash); } catch (e) { rec = null; }
        cache.set(hash, rec && rec.bytes ? toDataUrl(rec.bytes, rec.type) : null);
      }
      const url = cache.get(hash);
      if (url) obj[key] = url;
      else delete obj[key];
    }
    return model;
  }

  /* ---- 存档：防抖写 IndexedDB，同步留小镜像 ---- */
  let saveTimer = null, saving = false, savingAgain = false;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 350);
  }
  async function flushSave() {
    clearTimeout(saveTimer);
    if (saving) { savingAgain = true; return; }
    saving = true;
    let packed = null;
    try { packed = packModel(JSON.parse(snapshot())); } catch (e) { saving = false; return; }
    const at = Date.now();
    // 先同步落一份不带图片的小镜像：崩了也能捞回来
    try {
      localStorage.setItem(LS_KEY, packed.json);
      localStorage.setItem(AT_KEY, String(at));
    } catch (e) { /* 配额满也不影响 IDB */ }
    try {
      for (const [hash, asset] of packed.assets) {
        if (!(await idbGet('assets', hash))) await idbPut('assets', hash, asset);
      }
      await idbPut('state', 'main', { json: packed.json, at });
      // IDB 里已经有图了，小镜像就不必再背着 base64
    } catch (e) {
      // IDB 不可用：退回完整快照，至少不丢数据
      try { localStorage.setItem(LS_KEY, snapshot()); localStorage.removeItem(AT_KEY); } catch (err) { /* 无能为力 */ }
    } finally {
      saving = false;
      if (savingAgain) { savingAgain = false; flushSave(); }
    }
  }

  async function loadStored() {
    let ls = null, lsAt = 0;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) { ls = JSON.parse(raw); lsAt = Number(localStorage.getItem(AT_KEY) || 0); }
    } catch (e) { ls = null; }
    let rec = null;
    try { rec = await idbGet('state', 'main'); } catch (e) { rec = null; }
    let model = null;
    if (rec && rec.json && (!ls || (rec.at || 0) >= lsAt)) model = JSON.parse(rec.json);
    else if (ls) model = ls;
    else if (rec && rec.json) model = JSON.parse(rec.json);
    if (!model) return null;
    return unpackModel(model);
  }

  /* ---- ZIP（store + deflate-raw，用浏览器自带的压缩流，无依赖） ---- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const hasZipStream = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
  async function deflateRaw(u8) {
    const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function inflateRaw(u8) {
    const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function makeZip(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const raw = e.data || enc.encode(e.text || '');
      const name = enc.encode(e.name);
      const crc = crc32(raw);
      let data = raw, method = 0;
      if (e.compress !== false && raw.length > 256 && hasZipStream()) {
        const z = await deflateRaw(raw);
        if (z.length < raw.length) { data = z; method = 8; }
      }
      const head = new Uint8Array(30 + name.length);
      const dv = new DataView(head.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);
      dv.setUint16(8, method, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, raw.length, true);
      dv.setUint16(26, name.length, true);
      dv.setUint16(28, 0, true);
      head.set(name, 30);
      parts.push(head, data);
      central.push({ name, crc, csize: data.length, usize: raw.length, method, offset });
      offset += head.length + data.length;
    }
    const dirs = [];
    let dirSize = 0;
    for (const c of central) {
      const h = new Uint8Array(46 + c.name.length);
      const dv = new DataView(h.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, c.method, true);
      dv.setUint16(12, 0, true);
      dv.setUint16(14, 0x21, true);
      dv.setUint32(16, c.crc, true);
      dv.setUint32(20, c.csize, true);
      dv.setUint32(24, c.usize, true);
      dv.setUint16(28, c.name.length, true);
      dv.setUint16(30, 0, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, 0, true);
      dv.setUint32(42, c.offset, true);
      h.set(c.name, 46);
      dirs.push(h);
      dirSize += h.length;
    }
    const end = new Uint8Array(22);
    const dv = new DataView(end.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(8, central.length, true);
    dv.setUint16(10, central.length, true);
    dv.setUint32(12, dirSize, true);
    dv.setUint32(16, offset, true);
    return new Blob([...parts, ...dirs, end], { type: 'application/zip' });
  }

  async function readZip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的工程包');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = {};
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('工程包目录损坏');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      const lNameLen = dv.getUint16(lho + 26, true);
      const lExtraLen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lNameLen + lExtraLen;
      let data = u8.subarray(start, start + csize);
      if (method === 8) {
        if (!hasZipStream()) throw new Error('当前浏览器不支持解压');
        data = await inflateRaw(data);
      }
      out[name] = data;
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const stamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  };

  function buildProjectZip() {
    const packed = packModel(JSON.parse(snapshot()));
    const model = JSON.parse(packed.json);
    const entries = [
      { name: 'meta.json', compress: true, text: JSON.stringify({
        app: 'archboard', version: AUTHOR.version, at: new Date().toISOString(),
        generator: `Archboard by ${AUTHOR.name}`,
        author: AUTHOR.name, github: AUTHOR.github, email: AUTHOR.email, homepage: AUTHOR.homepage,
        elements: (model.elements || []).length, assets: packed.assets.size,
      }, null, 1) },
      { name: 'model.json', compress: true, text: packed.json },
    ];
    for (const [hash, a] of packed.assets) entries.push({ name: `assets/${hash}.${a.ext}`, data: a.bytes, compress: false });
    return { entries, count: packed.assets.size };
  }

  async function exportProject() {
    try {
      setStatus('正在打包…');
      const { entries, count } = buildProjectZip();
      const blob = await makeZip(entries);
      downloadBlob(blob, `架构板-${stamp()}.archboard`);
      toast(`已导出工程包 · ${count} 张图片 · ${(blob.size / 1048576).toFixed(2)} MB`);
    } catch (e) {
      toast('导出失败：' + (e && e.message ? e.message : e), 4000);
    }
  }

  async function importFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const u8 = new Uint8Array(buf);
      if (u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b) {
        const files = await readZip(buf);
        if (!files['model.json']) throw new Error('工程包里缺 model.json');
        const model = JSON.parse(new TextDecoder().decode(files['model.json']));
        const assets = new Map();
        for (const [name, data] of Object.entries(files)) {
          const m = /^assets\/([^/]+)\.([a-z0-9]+)$/i.exec(name);
          if (!m) continue;
          const ext = m[2].toLowerCase();
          assets.set(m[1], { bytes: data, type: EXT_TYPE[ext] || 'image/png' });
        }
        eachImage(model, (obj, key) => {
          const v = obj[key];
          if (typeof v !== 'string' || !v.startsWith(ASSET)) return;
          const a = assets.get(v.slice(ASSET.length));
          if (a) obj[key] = toDataUrl(a.bytes, a.type);
          else delete obj[key];
        });
        pushHistory();
        restore(JSON.stringify(model));
        saveSoon();
        toast(`已载入工程包 · ${(model.elements || []).length} 个元素 · ${assets.size} 张图片`);
      } else {
        pushHistory();
        restore(new TextDecoder().decode(u8));
        saveSoon();
        toast('已载入 JSON');
      }
    } catch (e) {
      toast('载入失败：' + (e && e.message ? e.message : e), 4000);
    }
  }

  /* ---------------------------------------------------------------- 存取 */



  // 旧数据没有画布 / 图层字段，补齐默认值；缺失的 canvas/layer 引用直接清空
  function migrateModel() {
    if (!Array.isArray(state.canvases)) state.canvases = [];
    if (!Array.isArray(state.layers)) state.layers = [];
    for (const c of state.canvases) {
      if (c.w == null) c.w = 1600;
      if (c.h == null) c.h = 900;
      if (c.name == null) c.name = '画布';
      if (c.bgFit == null) c.bgFit = 'cover';
    }
    for (const l of state.layers) {
      if (l.name == null) l.name = '图层';
    }
    for (const e of state.elements) {
      if (e.layerId && !layerById(e.layerId)) e.layerId = null;
    }
    // 旧画布没有「画布」概念，把原来的导出画板补成一张默认画布，
    // 这样图层树第一层就有画布节点，元素也不会全部散在根上。
    if (!state.canvases.length && state.elements.some((e) => e.type !== 'arrow')) {
      state.canvases.push({
        id: 'cv-main', name: '主画布', x: 0, y: 0, w: W, h: H,
        bgColor: null, bgImage: null, bgFit: 'cover',
        lockRatio: false, visible: true, locked: false,
      });
    }
  }

  // 顶栏 / 图层面板 / 鸟瞰图 的事件绑定（只做一次）
  let chromeBound = false;
  function bindChrome() {
    if (chromeBound) return;
    chromeBound = true;

    document.body.classList.add('layers-open');

    const gb = $('#groupBtn'); if (gb) gb.onclick = groupSelection;
    const ub = $('#ungroupBtn'); if (ub) ub.onclick = ungroupSelection;
    const nc = $('#newCanvasBtn'); if (nc) nc.onclick = createCanvasAtViewCenter;
    const lf = $('#layerFitBtn'); if (lf) lf.onclick = fitView;

    document.querySelectorAll('#bar .tool').forEach((b) => {
      b.addEventListener('click', () => {
        setTool(b.dataset.tool);
        if (b.dataset.tool === 'canvas') setStatus('在空白处点击即可创建画布');
      });
    });

    const tree = $('#layerTree');
    tree.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-act="twist"]') || ev.target.closest('[data-act="vis"]') || ev.target.closest('[data-act="lock"]')) ev.stopPropagation();
      const act = ev.target.closest('[data-act]');
      const row = ev.target.closest('.lp-row');
      if (!row) return;
      const id = row.dataset.node;
      const kind = row.dataset.kind;

      if (act && act.dataset.act === 'twist') {
        if (collapsedSet.has(id)) collapsedSet.delete(id); else collapsedSet.add(id);
        renderLayerTree();
        return;
      }
      if (act && act.dataset.act === 'vis') {
        toggleFlag(id, kind, 'visible');
        return;
      }
      if (act && act.dataset.act === 'lock') {
        toggleFlag(id, kind, 'locked');
        return;
      }
      // 选中
      if (kind === 'canvas') { selectCanvasInPlace(id); return; }
      if (kind === 'layer') {
        const l = layerById(id);
        if (!l) return;
        dropCanvasSel();
        sel = new Set(membersOf(l).filter(selectable).map((m) => m.id));
        enteredGroup.add(id);
        syncSelection(); updateTreeSelection(); return;
      }
      const e = getEl(id);
      if (!e) return;
      if (!selectable(e)) { setStatus(isLocked(e) ? '该图层已锁定' : '该元素已隐藏'); return; }
      dropCanvasSel();
      sel = new Set([id]);
      syncSelection(); updateTreeSelection();
    });

    // 双击整行 → 重命名（图层、画布、元素都适用）
    tree.addEventListener('dblclick', (ev) => {
      if (ev.target.closest('[data-act="vis"]') || ev.target.closest('[data-act="lock"]') || ev.target.closest('[data-act="twist"]')) return;
      const row = ev.target.closest('.lp-row');
      if (!row) return;
      const nameEl = row.querySelector('.lp-name');
      if (!nameEl) return;
      ev.preventDefault();
      ev.stopPropagation();
      startRename(nameEl, row.dataset.node, row.dataset.kind);
    });

    // ---- 图层拖动换序 ----
    const line = document.createElement('div');
    line.id = 'lpDropLine';
    document.body.appendChild(line);
    let drag = null;
    let muteClickUntil = 0;

    tree.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest('[data-act]')) return;          // 眼睛/锁/折叠箭头不拖
      const row = ev.target.closest('.lp-row');
      if (!row) return;
      const k = row.dataset.kind;
      if (k === 'canvas' || k === 'layer') return;          // 只拖元素
      drag = { id: row.dataset.node, parent: row.dataset.parent, row,
               y0: ev.clientY, active: false, target: null, before: false };
    });

    // 指针下的落点：只在同一分组内允许
    const hitTest = (x, y) => {
      if (!drag) return;
      const box = tree.getBoundingClientRect();
      const under = document.elementFromPoint(x, y);
      const over = under && under.closest ? under.closest('#layerTree .lp-row') : null;
      if (!over || over === drag.row || over.dataset.kind === 'canvas'
          || over.dataset.kind === 'layer' || over.dataset.parent !== drag.parent) {
        drag.target = null;
        line.style.display = 'none';
        return;
      }
      const r = over.getBoundingClientRect();
      drag.target = over.dataset.node;
      drag.before = y < r.top + r.height / 2;
      line.style.display = 'block';
      line.style.left = Math.round(box.left + 4) + 'px';
      line.style.width = Math.round(box.width - 10) + 'px';
      line.style.top = Math.round(drag.before ? r.top : r.bottom) - 1 + 'px';
    };

    window.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      if (!drag.active) {
        if (Math.abs(ev.clientY - drag.y0) < 5) return;
        drag.active = true;
        drag.row.classList.add('drag-src');
        document.body.classList.add('lp-dragging');
      }
      const box = tree.getBoundingClientRect();
      if (ev.clientY < box.top + 22) tree.scrollTop -= 12;
      else if (ev.clientY > box.bottom - 22) tree.scrollTop += 12;
      hitTest(ev.clientX, ev.clientY);
    });

    const endDrag = (apply, ev) => {
      if (drag && drag.active && !drag.target && ev && apply) hitTest(ev.clientX, ev.clientY);
      const d = drag;
      drag = null;
      if (!d) return;
      d.row.classList.remove('drag-src');
      document.body.classList.remove('lp-dragging');
      line.style.display = 'none';
      if (!d.active) return;
      muteClickUntil = Date.now() + 250;
      if (!apply || !d.target) return;
      const ids = [...tree.querySelectorAll('.lp-row')]
        .filter((r) => r.dataset.parent === d.parent)
        .map((r) => r.dataset.node);
      const from = ids.indexOf(d.id);
      if (from < 0) return;
      ids.splice(from, 1);
      let to = ids.indexOf(d.target);
      if (to < 0) return;
      if (!d.before) to += 1;
      ids.splice(to, 0, d.id);
      pushHistory();
      if (reorderGroup(ids)) {
        sel = new Set([d.id]);
        renderAll(); saveSoon(); commit();
        syncSelection();
        setStatus('图层顺序已调整');
      }
    };
    window.addEventListener('pointerup', (ev) => endDrag(true, ev));
    window.addEventListener('pointercancel', () => endDrag(false));

    // 拖完那一下的 click 不应该再触发选中
    tree.addEventListener('click', (ev) => {
      if (Date.now() < muteClickUntil) { ev.stopPropagation(); ev.preventDefault(); }
    }, true);

    // 鸟瞰图
    const mm = $('#minimap');
    if (mm) {
      let dragging = false;
      mm.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        dragging = true;
        try { mm.setPointerCapture(ev.pointerId); } catch (e) { /* 合成事件没有真实 pointer */ }
        minimapGoto(ev);
      });
      mm.addEventListener('pointermove', (ev) => { if (dragging) minimapGoto(ev); });
      mm.addEventListener('pointerup', () => { dragging = false; });
      mm.addEventListener('pointercancel', () => { dragging = false; });
    }
  }

  function toggleFlag(id, kind, key) {
    pushHistory();
    let node = null;
    if (kind === 'canvas') node = canvasById(id);
    else if (kind === 'layer') node = layerById(id);
    else node = getEl(id);
    if (!node) return;
    // 用「当前生效状态」取反，而不是取反字段本身：
    // visible 初始是 undefined，!undefined === true 会把隐藏变成显示
    const cur = kind === 'canvas' || kind === 'layer'
      ? (key === 'visible' ? node.visible !== false : node.locked === true)
      : (key === 'visible' ? isVisible(node) : isLocked(node));
    node[key] = !cur;
    if (key === 'visible' && node.visible === false) {
      // 隐藏后把已选中的内容移出选区
      if (kind === 'canvas') { sel.clear(); }
      else if (kind === 'layer') { for (const m of membersOf(node)) sel.delete(m.id); }
      else sel.delete(id);
    }
    if (key === 'locked' && node.locked) {
      if (kind === 'layer') { for (const m of membersOf(node)) sel.delete(m.id); }
      else if (kind !== 'canvas') sel.delete(id);
    }
    renderAll();
  }

  function startRename(span, id, kind) {
    const node = (kind === 'canvas' ? canvasById(id) : kind === 'layer' ? layerById(id) : getEl(id));
    if (!node) return;
    const cur = kind === 'canvas' ? node.name : kind === 'layer' ? node.name : (node.label || node.title || node.text || '');
    span.contentEditable = 'true';
    span.focus();
    const rg = document.createRange();
    rg.selectNodeContents(span);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(rg);
    let finished = false;
    const done = (cancel) => {
      if (finished) return;
      finished = true;
      span.contentEditable = 'false';
      if (cancel) { renderLayerTree(); return; }
      const v = (span.textContent || '').trim();
      pushHistory();
      if (kind === 'canvas' || kind === 'layer') node.name = v || cur;
      else if (node.type === 'text') node.text = v || cur;
      else if ('title' in node || node.type === 'card') node.title = v || cur;
      else node.label = v || cur;
      renderAll();
    };
    span.addEventListener('blur', () => done(false), { once: true });
    span.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); done(true); }
      e.stopPropagation();
    });
  }

  /* ---------------------------------------------------------------- 初始 */
  async function boot() {
    let saved = null;
    try { saved = await loadStored(); } catch (e) { saved = null; }
    if (saved) {
      state.elements = saved.elements || [];
      state.bg = saved.bg || null;
      state.canvases = saved.canvases || [];
      state.layers = saved.layers || [];
    }
    migrateModel();
    migrateWire();
    bindChrome();
    checkSig();
    console.log(
      '%c 架构板 Archboard %c maidong · github.com/Mr-Maidong · ' + SIG,
      'background:#e6e6e6;color:#0a0a0a;padding:2px 7px;border-radius:2px;font-weight:600;letter-spacing:.02em',
      'color:#7d7d7d'
    );
    console.log(
      '%c 智能体接口 %c archboard.help() 取工具清单 · archboard.guide() 取操作提示',
      'background:#2a2a2a;color:#e6e6e6;padding:2px 7px;border-radius:2px;font-weight:600',
      'color:#7d7d7d'
    );
    renderAll();
    fitView();
    pushHistory();
    updateHistButtons();
  }

  // 线框化迁移：面板/卡片的圆角收成直角，角标才贴得住角
  function migrateWire() {
    if (state.wire === 'v2') return;
    let dirty = false;
    // 旧的玻璃质感默认值会盖住线框效果，匹配到就清掉，让强调色接管描边与底板
    const LEGACY_FILL = /^rgba\((26,\s*36,\s*58|24,\s*33,\s*54),\s*\.9\)$/;
    const LEGACY_STROKE = 'rgba(120,150,190,.35)';
    for (const e of state.elements) {
      if (e.type !== 'panel' && e.type !== 'card') continue;
      if ((e.radius == null ? 0 : e.radius) > 2) { e.radius = 0; dirty = true; }
      if (e.fill && LEGACY_FILL.test(e.fill)) { delete e.fill; dirty = true; }
      if (e.stroke === LEGACY_STROKE) { delete e.stroke; dirty = true; }
    }
    state.wire = 'v2';
    if (dirty) { saveSoon(); }
  }



  // 关页/切后台时立刻落盘：flushSave 在第一个 await 之前是同步执行，
  // 所以小镜像一定能写进 localStorage，IDB 那边尽力而为。
  window.addEventListener('beforeunload', () => flushSave());
  window.addEventListener('pagehide', () => flushSave());

  // 自测 / 调试钩子（也方便后续脚本化）
  window.__arch = {
    get state() { return state; },
    get sel() { return sel; },
    get zoom() { return zoom; },
    select(ids) { sel = new Set(ids); syncSelection(true); },
    align, renderAll, fitView, exportPNG, buildExportCanvas, exportRect,
    save: () => flushSave(),
    load: (json) => { restore(json); },
    reset: async () => {
      try { await idbClear('state'); await idbClear('assets'); } catch (e) { /* ignore */ }
      localStorage.removeItem(LS_KEY); localStorage.removeItem(AT_KEY);
      location.reload();
    },
    exportBlob: async () => {
      const { entries, count } = buildProjectZip();
      const blob = await makeZip(entries);
      return { blob, count, size: blob.size };
    },
    importBlob: (blob, name = 'x.archboard') => importFile(new File([blob], name)),
    storeInfo: async () => {
      const rec = await idbGet('state', 'main');
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      return { hasState: !!rec, savedAt: rec ? rec.at : null, jsonKB: rec ? +(rec.json.length / 1024).toFixed(1) : 0, quotaGB: est ? +(est.quota / 1073741824).toFixed(1) : null, usageMB: est ? +(est.usage / 1048576).toFixed(2) : null };
    },
  };


  /* ------------------------------------------------------------ 智能体接口 */
  // 面向模型的控制台接口：JSON 进、JSON 出，读写都走撤销历史与本地存储。
  // 入口：window.archboard；先跑 help() 取工具清单，guide() 取操作提示。
  const AG_VERSION = '1.0';
  const AG_FIELDS = {
    panel: ['label', 'labelSize', 'labelColor', 'accent', 'stroke', 'fillColor', 'fillAlpha', 'bg', 'radius', 'shadow', 'corners', 'x', 'y', 'w', 'h', 'opacity'],
    card: ['title', 'sub', 'titleSize', 'titleColor', 'subSize', 'subColor', 'accent', 'stroke', 'fill', 'icon', 'layout', 'radius', 'shadow', 'corners', 'x', 'y', 'w', 'h', 'opacity'],
    text: ['text', 'size', 'color', 'weight', 'align', 'x', 'y', 'w', 'h', 'opacity'],
    image: ['src', 'fit', 'x', 'y', 'w', 'h', 'opacity'],
    arrow: ['from', 'to', 'fromSide', 'toSide', 'mode', 'dash', 'head', 'double', 'color', 'strokeW'],
  };
  const AG_DEFAULT = {
    panel: { w: 1800, h: 140, label: '新层', accent: '#7ea6ff', radius: 0 },
    card: { w: 390, h: 92, title: '新卡片', sub: '说明文字', accent: '#7ea6ff', radius: 0 },
    text: { w: 420, h: 44, text: '文字', size: 24, color: '#eaf1ff', align: 'left' },
    image: { w: 96, h: 96, src: '', fit: 'cover' },
  };

  const archboard = (() => {
    const ok = (extra) => Object.assign({ ok: true }, extra || {});
    const fail = (code, message, hint) => ({ ok: false, error: { code, message, hint } });
    const byIds = (ids) => { const s = new Set(ids || []); return state.elements.filter((e) => s.has(e.id)); };
    const bounds = (list) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const e of list) {
        x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y);
        x1 = Math.max(x1, e.x + e.w); y1 = Math.max(y1, e.y + e.h);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    const label = (e) => e.title || e.label || e.text || '';

    const TOOLS = [
      { name: 'state', desc: '读取画布与全部元素（id / 类型 / 坐标 / 文案 / 当前选中）', args: {} },
      { name: 'find', desc: '按类型或文案筛选元素，返回 id 列表', args: { type: 'panel|card|text|image|arrow', text: '包含的文字' } },
      { name: 'create', desc: '新建元素，返回新 id。坐标单位为画布像素，左上角定位', args: { type: 'panel|card|text|image', x: 0, y: 0, w: 0, h: 0, title: '卡片标题', label: '面板标签', text: '文字内容' } },
      { name: 'update', desc: '批量改样式的字段（只认该类元素支持的字段）', args: { ids: ['id'], patch: { title: '标题', stroke: '#ff8f5a', shadow: 2 } } },
      { name: 'remove', desc: '删除元素，顺带删除挂在它们身上的连线', args: { ids: ['id'] } },
      { name: 'duplicate', desc: '复制元素，可指定偏移', args: { ids: ['id'], dx: 24, dy: 24 } },
      { name: 'select', desc: '设置选中（reveal=true 时缩放到选区）', args: { ids: ['id'], reveal: false } },
      { name: 'align', desc: '对齐到选区外接框', args: { ids: ['id'], mode: 'left|cx|right|top|cy|bottom' } },
      { name: 'distribute', desc: '沿水平或垂直方向等距分布（至少 3 个）', args: { ids: ['id'], axis: 'h|v', gap: 24 } },
      { name: 'layout', desc: '按行或列依次排开', args: { ids: ['id'], dir: 'row|column', gap: 24, x: 0, y: 0 } },
      { name: 'connect', desc: '在两个元素之间连一条箭头', args: { from: 'id', to: 'id', mode: 'bezier|straight|elbow', dash: 'solid|dash|dot', head: 'none|arrow|triangle|circle', color: '#c8c8c8' } },
      { name: 'view', desc: '视图：fit=true 适应窗口，zoom 指定缩放，ids 聚焦选区', args: { fit: true, zoom: 0.8, ids: ['id'] } },
      { name: 'exportPNG', desc: '导出 PNG，返回 dataURL', args: { scale: 2 } },
      { name: 'exportJSON', desc: '导出当前工程 JSON 字符串', args: {} },
      { name: 'importJSON', desc: '载入工程 JSON（整体替换当前画布）', args: { json: '{"elements":[...]}' } },
      { name: 'undo', desc: '撤销一步', args: {} },
      { name: 'redo', desc: '重做一步', args: {} },
      { name: 'clear', desc: '清空全部元素（需 confirm:true）', args: { confirm: true, resetCanvas: true } },
      { name: 'run', desc: '按顺序执行多个工具调用', args: { ops: [{ tool: 'create', args: {} }] } },
      { name: 'help', desc: '返回本清单', args: {} },
      { name: 'guide', desc: '返回给模型看的使用提示（纯文本）', args: {} },
    ];

    function help() {
      return ok({ app: 'Archboard', version: AG_VERSION, coordinate: '画布像素，原点在画布左上角，y 向下；元素以左上角定位', tools: TOOLS });
    }

    function guide() {
      return ok({ text: [
        '架构板智能体接口 v' + AG_VERSION,
        '· 调用方式：archboard.call("工具名", 参数)，或直接 archboard.工具名(参数)，返回 JSON',
        '· 坐标单位是画布像素，元素以左上角定位，y 向下；尺寸建议：层带面板 1800×140、卡片 390×92、间距 24、文字 420×44',
        '· 开始前先 archboard.help() 取清单、archboard.state() 看现状',
        '· 典型流程：create(panel) → create(card) × N → layout(row|column) → connect(from, to) → exportPNG()',
        '· 批量改动用 run({ops:[...]})；每次写操作都会进撤销历史，出错可 undo()',
        '· 颜色写 #rrggbb 或 #rrggbbaa；阴影 0–3 档；角标 corners:true/false',
        '· 清空需要显式 confirm:true，不要在没有确认的情况下调用 clear',
      ].join('\n') });
    }

    function state_() {
      const counts = {};
      for (const e of state.elements) counts[e.type] = (counts[e.type] || 0) + 1;
      return ok({
        canvases: state.canvases.map((c) => ({ id: c.id, name: c.name, x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) })),
        counts,
        selection: [...sel],
        zoom: +zoom.toFixed(3),
        elements: state.elements.map((e) => ({
          id: e.id, type: e.type,
          x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.w), h: Math.round(e.h),
          text: label(e),
        })),
      });
    }

    function find(a) {
      const list = state.elements.filter((e) => (!a.type || e.type === a.type) && (!a.text || String(label(e)).includes(a.text)));
      return ok({ ids: list.map((e) => e.id), count: list.length });
    }

    function create(a) {
      const type = a && a.type;
      if (!AG_DEFAULT[type]) return fail('bad_type', '不支持的 type: ' + type, '可选 panel / card / text / image，连线请用 connect');
      pushHistory();
      const e = Object.assign({ id: uid(type[0]), type, x: 0, y: 0, radius: 0 }, AG_DEFAULT[type]);
      for (const k of AG_FIELDS[type]) if (a[k] !== undefined) e[k] = a[k];
      state.elements.push(e);
      sel.clear(); sel.add(e.id);
      renderAll(); commit(); saveSoon();
      return ok({ id: e.id });
    }

    function update(a) {
      const list = byIds(a.ids);
      if (!list.length) return fail('not_found', 'ids 没有匹配到元素', '先 state() 取 id');
      const patch = a.patch || {};
      const keys = Object.keys(patch);
      if (!keys.length) return fail('bad_args', 'patch 为空', '例如 {title:"标题", shadow:2}');
      pushHistory();
      let applied = 0;
      for (const e of list) {
        const allow = AG_FIELDS[e.type] || [];
        for (const k of keys) if (allow.includes(k)) { e[k] = patch[k]; applied++; }
      }
      renderAll(); commit(); saveSoon();
      const ignored = keys.filter((k) => !list.some((e) => (AG_FIELDS[e.type] || []).includes(k)));
      return ok({ updated: list.length, applied, ignored });
    }

    function remove(a) {
      const list = byIds(a.ids);
      if (!list.length) return fail('not_found', 'ids 没有匹配到元素');
      const dead = new Set(list.map((e) => e.id));
      pushHistory();
      state.elements = state.elements.filter((e) => !dead.has(e.id) && !(e.type === 'arrow' && (dead.has(e.from) || dead.has(e.to))));
      sel.clear(); renderAll(); commit(); saveSoon();
      return ok({ removed: dead.size });
    }

    function duplicate(a) {
      const list = byIds(a.ids);
      if (!list.length) return fail('not_found', 'ids 没有匹配到元素');
      const dx = a.dx == null ? 24 : Number(a.dx);
      const dy = a.dy == null ? 24 : Number(a.dy);
      pushHistory();
      const map = new Map();
      const copies = list.map((e) => {
        const c = JSON.parse(JSON.stringify(e));
        c.id = uid(e.type[0]); map.set(e.id, c.id);
        c.x += dx; c.y += dy;
        return c;
      });
      for (const c of copies) {
        if (c.type === 'arrow') {
          if (map.has(c.from)) c.from = map.get(c.from);
          if (map.has(c.to)) c.to = map.get(c.to);
        }
      }
      state.elements.push(...copies);
      sel.clear(); copies.forEach((c) => sel.add(c.id));
      renderAll(); commit(); saveSoon();
      return ok({ ids: copies.map((c) => c.id) });
    }

    function select_(a) {
      const list = byIds(a.ids);
      sel.clear(); list.forEach((e) => sel.add(e.id));
      syncSelection(!!a.reveal);
      return ok({ selected: list.length });
    }

    function align_(a) {
      const list = byIds(a.ids).filter((e) => e.type !== 'arrow');
      if (!list.length) return fail('not_found', 'ids 没有匹配到元素');
      const mode = a.mode || 'left';
      if (!['left', 'cx', 'right', 'top', 'cy', 'bottom'].includes(mode)) return fail('bad_mode', '未知 mode: ' + mode, 'left / cx / right / top / cy / bottom');
      const b = bounds(list);
      pushHistory();
      for (const e of list) {
        if (mode === 'left') e.x = b.x;
        else if (mode === 'cx') e.x = b.x + (b.w - e.w) / 2;
        else if (mode === 'right') e.x = b.x + b.w - e.w;
        else if (mode === 'top') e.y = b.y;
        else if (mode === 'cy') e.y = b.y + (b.h - e.h) / 2;
        else e.y = b.y + b.h - e.h;
        e.x = round(e.x); e.y = round(e.y);
      }
      renderAll(); commit(); saveSoon();
      return ok({ aligned: list.length, mode });
    }

    function distribute(a) {
      const list = byIds(a.ids).filter((e) => e.type !== 'arrow');
      if (list.length < 3) return fail('bad_args', '至少需要 3 个元素', '两个元素请用 layout');
      const axis = a.axis === 'v' ? 'v' : 'h';
      const sorted = [...list].sort((p, q) => (axis === 'h' ? p.x - q.x : p.y - q.y));
      const first = sorted[0], last = sorted[sorted.length - 1];
      const total = axis === 'h' ? last.x + last.w - first.x : last.y + last.h - first.y;
      const sum = sorted.reduce((s, e) => s + (axis === 'h' ? e.w : e.h), 0);
      const gap = a.gap == null ? (total - sum) / (sorted.length - 1) : Number(a.gap);
      pushHistory();
      let cursor = axis === 'h' ? first.x : first.y;
      for (const e of sorted) {
        if (axis === 'h') { e.x = round(cursor); cursor += e.w + gap; }
        else { e.y = round(cursor); cursor += e.h + gap; }
      }
      renderAll(); commit(); saveSoon();
      return ok({ count: sorted.length, axis, gap: round(gap) });
    }

    function layout(a) {
      const list = byIds(a.ids);
      if (!list.length) return fail('not_found', 'ids 没有匹配到元素');
      const dir = a.dir === 'column' ? 'column' : 'row';
      const gap = a.gap == null ? 24 : Number(a.gap);
      const sorted = [...list].sort((p, q) => (dir === 'row' ? p.x - q.x || p.y - q.y : p.y - q.y || p.x - q.x));
      const b = bounds(list);
      let cx = a.x == null ? b.x : Number(a.x);
      let cy = a.y == null ? b.y : Number(a.y);
      pushHistory();
      for (const e of sorted) {
        if (dir === 'row') { e.x = round(cx); e.y = round(cy); cx += e.w + gap; }
        else { e.x = round(cx); e.y = round(cy); cy += e.h + gap; }
      }
      renderAll(); commit(); saveSoon();
      return ok({ count: sorted.length, dir, gap });
    }

    function connect(a) {
      const fe = state.elements.find((x) => x.id === a.from);
      const te = state.elements.find((x) => x.id === a.to);
      if (!fe || !te) return fail('not_found', 'from / to 需要已存在的元素 id', '先用 create 得到 id');
      if (fe.id === te.id) return fail('bad_args', '不能连到自身');
      pushHistory();
      const arrow = {
        id: uid('a'), type: 'arrow', from: fe.id, to: te.id,
        fromSide: a.fromSide || null, toSide: a.toSide || null,
        mode: a.mode || 'bezier', dash: a.dash || 'solid', head: a.head || 'triangle',
        double: !!a.double, color: a.color || '#c8c8c8', strokeW: a.strokeW == null ? 1 : Number(a.strokeW),
        z: 500,
      };
      state.elements.push(arrow);
      renderAll(); commit(); saveSoon();
      return ok({ id: arrow.id });
    }

    function view(a) {
      if (a && a.ids && a.ids.length) {
        const list = byIds(a.ids);
        if (!list.length) return fail('not_found', 'ids 没有匹配到元素');
        const b = bounds(list);
        const r = viewport.getBoundingClientRect();
        const pad = 80;
        zoom = clamp(Math.min(r.width / (b.w + pad * 2), r.height / (b.h + pad * 2)), 0.05, 4);
        panX = (r.width - b.w * zoom) / 2 - (b.x - pad) * zoom;
        panY = (r.height - b.h * zoom) / 2 - (b.y - pad) * zoom;
        applyView();
        return ok({ zoom: +zoom.toFixed(3) });
      }
      if (a && a.zoom) {
        zoom = clamp(Number(a.zoom), 0.05, 4);
        applyView();
        return ok({ zoom: +zoom.toFixed(3) });
      }
      fitView();
      return ok({ zoom: +zoom.toFixed(3) });
    }

    async function exportPNG_(a) {
      const cv = await buildExportCanvas(a && a.region, (a && a.scale) || 2);
      return ok({ width: cv.width, height: cv.height, dataURL: cv.toDataURL('image/png') });
    }

    function exportJSON() {
      return ok({ json: JSON.stringify({ elements: state.elements, canvases: state.canvases, layers: state.layers, bg: state.bg }) });
    }

    function importJSON(a) {
      const json = typeof a.json === 'string' ? a.json : JSON.stringify(a.json || {});
      try {
        restore(json);
      } catch (err) {
        return fail('bad_json', 'JSON 解析失败: ' + String(err && err.message || err));
      }
      renderAll(); saveSoon();
      return ok({ elements: state.elements.length, canvases: state.canvases.length });
    }

    function undo_() { undo(); return ok({ canUndo: histIndex > 0 }); }
    function redo_() { redo(); return ok({ canRedo: histIndex < history.length - 1 }); }

    function clear(a) {
      if (!a || a.confirm !== true) return fail('need_confirm', '清空会删除全部元素，需要 confirm:true', '只想删几个请用 remove({ids})');
      pushHistory();
      state.elements = [];
      state.layers = [];
      if (a.resetCanvas !== false) {
        state.canvases = [{ id: uid('v'), name: '主画布', x: 0, y: 0, w: 1600, h: 900, bgColor: '#0a0a0a', bgImage: null, bgFit: 'cover', visible: true }];
      }
      sel.clear(); renderAll(); commit(); saveSoon();
      return ok({ cleared: true });
    }

    const api = {
      help, guide,
      state: state_, find, create, update, remove, duplicate,
      select: select_, align: align_, distribute, layout, connect, view,
      exportPNG: exportPNG_, exportJSON, importJSON,
      undo: undo_, redo: redo_, clear,
    };

    api.call = function (tool, args) {
      const fn = api[tool];
      if (typeof fn !== 'function' || tool === 'call') return fail('bad_tool', '没有这个工具: ' + tool, '先跑 archboard.help()');
      try {
        return fn(args || {});
      } catch (err) {
        return fail('exception', String(err && err.message || err));
      }
    };

    api.run = function (a) {
      const ops = (a && a.ops) || [];
      if (!Array.isArray(ops) || !ops.length) return fail('bad_args', 'ops 为空', '例如 {ops:[{tool:"create",args:{type:"card"}}]}');
      const results = [];
      for (const op of ops) {
        if (!op || !op.tool) { results.push({ ok: false, error: { code: 'bad_tool', message: '缺少 tool' } }); continue; }
        let r = api.call(op.tool, op.args || {});
        results.push(r && typeof r.then === 'function' ? { ok: true, pending: true } : r);
      }
      return ok({ results });
    };

    return api;
  })();

  window.archboard = archboard;
  window.agent = archboard;          // 简写别名

  boot();
})();
