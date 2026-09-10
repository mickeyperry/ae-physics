/* AE Physics — panel controller: reads the AE scene, runs planck.js, previews, bakes keyframes. */
(function () {
  'use strict';
  var isCEP = !!(window.__adobe_cep__ && window.__adobe_cep__.evalScript);
  var hasFS = !!(window.cep && window.cep.fs && window.cep.fs.writeFile);
  var COLORS = { dynamic: '#4fc3f7', static: '#9e9e9e', kinematic: '#ffb74d', dormant: '#ce93d8' };

  var state = {
    scene: null, cfgs: {}, world: SIM.defaultWorld(),
    range: { startFrame: 0, endFrame: 0 },
    bake: { unparent: true, clearRange: true, linear: true, rotation: true, step: 1 },
    result: null, frame: 0, playing: false, selectedId: null, simTimer: null, playTimer: null, busy: false
  };

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  var statusEl = $('#status'), canvas = $('#cv'), ctx = canvas.getContext('2d');

  function setStatus(text, kind) { statusEl.textContent = text; statusEl.className = 'status-bar' + (kind ? ' ' + kind : ''); }
  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : d; }
  function extend(a, b) { for (var k in b) if (b.hasOwnProperty(k)) a[k] = b[k]; return a; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---------- host bridge ----------
  function host(fn, arg, cb) {
    var script = 'PHY.' + fn + '(' + (arg === undefined ? '' : JSON.stringify(JSON.stringify(arg))) + ')';
    if (!isCEP) { console.log('[host]', script); if (cb) cb('ERR: not running inside After Effects'); return; }
    window.__adobe_cep__.evalScript(script, function (res) { if (cb) cb(res); });
  }
  function parseResult(res) {
    if (typeof res !== 'string') return { err: 'No response from After Effects.' };
    if (res.indexOf('ERR:') === 0) return { err: res.substring(4).trim() };
    if (res === 'EvalScript error.') return { err: 'Host script error (physics.jsx). Reopen the panel.' };
    try { return { data: JSON.parse(res) }; } catch (e) { return { text: res }; }
  }

  // ---------- persistence ----------
  function storeKey() { return state.scene ? 'aephysics:' + state.scene.comp.id : null; }
  function persist() {
    var k = storeKey(); if (!k) return;
    try { localStorage.setItem(k, JSON.stringify({ world: state.world, cfgs: state.cfgs, range: state.range, bake: state.bake })); } catch (e) { }
  }
  function restore() {
    var k = storeKey(); if (!k) return null;
    try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function uiPref(k, v) {
    try {
      if (v === undefined) { var s = localStorage.getItem('aephysics:ui:' + k); return s === null ? null : JSON.parse(s); }
      localStorage.setItem('aephysics:ui:' + k, JSON.stringify(v));
    } catch (e) { return null; }
  }

  // =====================================================================
  //  Param rows: slider + number box bound to a key on a state object.
  //  spec: { key, label, min, max, step, unit, title, dflt, fmt }
  //  The slider covers the "useful" range; the number box accepts anything.
  // =====================================================================
  function fmtVal(v, step) {
    var s = String(step), d = s.indexOf('.') >= 0 ? s.length - s.indexOf('.') - 1 : 0;
    var out = (Math.round(v * 1e6) / 1e6).toFixed(d);
    if (d) out = out.replace(/0+$/, '').replace(/\.$/, '');
    return out === '-0' ? '0' : out;
  }
  function paramRow(spec, value) {
    var v = (value === undefined || value === null) ? spec.dflt : value;
    return '<div class="control-row param" data-key="' + spec.key + '">' +
      '<span class="control-label resettable"' + (spec.title ? ' title="' + escapeHtml(spec.title) + ' (double-click to reset)"' : ' title="Double-click to reset"') + '>' + spec.label + '</span>' +
      '<input type="range" min="' + spec.min + '" max="' + spec.max + '" step="' + spec.step + '" value="' + v + '">' +
      '<input type="number" class="num-input" step="' + spec.step + '" value="' + fmtVal(v, spec.step) + '">' +
      '<span class="unit">' + (spec.unit || '') + '</span>' +
      '</div>';
  }
  function paintRange(r) {
    var min = num(r.min, 0), max = num(r.max, 1), v = num(r.value, min);
    var p = max > min ? (v - min) / (max - min) * 100 : 0;
    r.style.setProperty('--p', Math.max(0, Math.min(100, p)) + '%');
  }
  function syncRow(row, spec, v) {
    var r = $('input[type=range]', row), n = $('.num-input', row);
    r.value = Math.max(spec.min, Math.min(spec.max, v)); paintRange(r);
    if (document.activeElement !== n) n.value = fmtVal(v, spec.step);
    n.classList.toggle('out-of-range', v < spec.min || v > spec.max);
  }
  // container: element holding .param rows; specs: array; getObj(): state object; onChange(key, value, live)
  function bindParams(container, specs, getObj, onChange) {
    var byKey = {}; specs.forEach(function (s) { byKey[s.key] = s; });
    function rowOf(el) { return el.closest('.param'); }
    function specOf(row) { return byKey[row.getAttribute('data-key')]; }
    function apply(row, v, live) {
      var spec = specOf(row), obj = getObj();
      if (spec.clamp) v = spec.clamp(v);
      obj[spec.key] = v; syncRow(row, spec, v);
      onChange(spec.key, v, live);
    }
    container.addEventListener('input', function (e) {
      if (e.target.type !== 'range') return;
      var row = rowOf(e.target); if (!row) return;
      apply(row, num(e.target.value, getObj()[specOf(row).key]), true);
    });
    container.addEventListener('change', function (e) {
      var row = rowOf(e.target); if (!row) return;
      var spec = specOf(row), cur = getObj()[spec.key];
      apply(row, num(e.target.value, cur), false);
    });
    container.addEventListener('keydown', function (e) {
      if (!e.target.classList.contains('num-input')) return;
      if (e.key === 'Enter') { e.target.blur(); }
      if (e.key === 'Escape') { var row = rowOf(e.target); syncRow(row, specOf(row), getObj()[specOf(row).key]); e.target.blur(); }
    });
    container.addEventListener('dblclick', function (e) {
      if (!e.target.classList.contains('control-label')) return;
      var row = rowOf(e.target); if (!row) return;
      apply(row, specOf(row).dflt, false);
    });
    // Mouse wheel over a slider nudges it by one step (shift = 10 steps)
    container.addEventListener('wheel', function (e) {
      if (e.target.type !== 'range') return;
      e.preventDefault();
      var row = rowOf(e.target), spec = specOf(row), obj = getObj();
      var dir = e.deltaY < 0 ? 1 : -1, stepMul = e.shiftKey ? 10 : 1;
      var v = num(obj[spec.key], spec.dflt) + dir * spec.step * stepMul;
      v = Math.max(spec.min, Math.min(spec.max, Math.round(v / spec.step) * spec.step));
      apply(row, v, false);
    }, { passive: false });
    return {
      render: function () {
        var obj = getObj();
        container.innerHTML = specs.map(function (s) { return paramRow(s, obj[s.key]); }).join('');
        $$('input[type=range]', container).forEach(paintRange);
        $$('.param', container).forEach(function (row) { var s = specOf(row); syncRow(row, s, num(obj[s.key], s.dflt)); });
      }
    };
  }

  // ---------- specs ----------
  var WORLD_SPECS = [
    { key: 'gravity', label: 'Gravity', min: 0, max: 30, step: 0.1, unit: 'm/s²', dflt: 9.8, title: 'Gravity strength. Earth ≈ 9.8' },
    { key: 'gravityAngle', label: 'Gravity angle', min: 0, max: 360, step: 1, unit: '°', dflt: 90, title: 'Direction of gravity. 90° = down, 0° = right, 270° = up' },
    { key: 'ppm', label: 'Scale', min: 10, max: 500, step: 5, unit: 'px/m', dflt: 100, title: 'Pixels per meter. Lower = bigger, slower-looking world; higher = small, snappy objects', clamp: function (v) { return Math.max(1, v); } },
    { key: 'timeScale', label: 'Speed', min: 0.1, max: 3, step: 0.05, unit: '×', dflt: 1, title: 'Simulation speed multiplier', clamp: function (v) { return Math.max(0.01, v); } },
    { key: 'substeps', label: 'Precision', min: 1, max: 30, step: 1, unit: 'steps', dflt: 8, title: 'Physics substeps per frame. Raise for fast or tiny objects that tunnel through each other', clamp: function (v) { return Math.max(1, Math.round(v)); } },
    { key: 'boundsRestitution', label: 'Wall bounce', min: 0, max: 1, step: 0.01, unit: '', dflt: 0.2, title: 'Bounciness of the comp walls' },
    { key: 'boundsFriction', label: 'Wall friction', min: 0, max: 1, step: 0.01, unit: '', dflt: 0.5, title: 'Friction of the comp walls' }
  ];
  var BODY_SPECS = [
    { key: 'density', label: 'Density', min: 0, max: 10, step: 0.1, unit: '', dflt: 1, title: 'Mass per area. Heavier bodies push lighter ones around' },
    { key: 'friction', label: 'Friction', min: 0, max: 1, step: 0.01, unit: '', dflt: 0.4, title: '0 = ice, 1 = rubber' },
    { key: 'restitution', label: 'Bounce', min: 0, max: 1, step: 0.01, unit: '', dflt: 0.3, title: '0 = dead stop, 1 = perfectly elastic' },
    { key: 'linearDamping', label: 'Drag', min: 0, max: 5, step: 0.05, unit: '', dflt: 0, title: 'Linear damping — slows movement over time, like air resistance' },
    { key: 'angularDamping', label: 'Spin drag', min: 0, max: 5, step: 0.05, unit: '', dflt: 0.05, title: 'Angular damping — slows rotation over time' },
    { key: 'angularVelocity', label: 'Spin', min: -720, max: 720, step: 5, unit: '°/s', dflt: 0, title: 'Initial angular velocity' },
    { key: 'vx', label: 'Velocity X', min: -2000, max: 2000, step: 10, unit: 'px/s', dflt: 0, title: 'Initial horizontal velocity (positive = right)' },
    { key: 'vy', label: 'Velocity Y', min: -2000, max: 2000, step: 10, unit: 'px/s', dflt: 0, title: 'Initial vertical velocity (positive = down)' }
  ];
  var BAKE_SPECS = [
    { key: 'step', label: 'Key every', min: 1, max: 10, step: 1, unit: 'frames', dflt: 1, title: 'Write a keyframe every N frames. 1 = every frame (exact), higher = lighter timeline', clamp: function (v) { return Math.max(1, Math.round(v)); } }
  ];

  // ---------- scene ----------
  function fps() { return state.scene ? state.scene.comp.fps : 24; }
  function refreshScene(keepRange) {
    if (state.busy) return;
    state.busy = true;
    $('#refreshBtn').classList.add('spin');
    setStatus('Reading layers from After Effects…', 'busy');
    var opts = {};
    if (keepRange && state.scene) opts.time = state.range.startFrame / fps();
    host('getScene', opts, function (res) {
      state.busy = false;
      $('#refreshBtn').classList.remove('spin');
      var r = parseResult(res);
      if (r.err || !r.data) { setStatus(r.err || 'Could not read scene.', 'err'); return; }
      var prevCompId = state.scene ? state.scene.comp.id : null;
      state.scene = r.data;
      var saved = (prevCompId !== state.scene.comp.id) ? restore() : null;
      if (saved) {
        state.world = extend(SIM.defaultWorld(), saved.world || {});
        state.bake = extend(state.bake, saved.bake || {});
        if (saved.range) state.range = saved.range;
        if (saved.cfgs) for (var id in saved.cfgs) state.cfgs[id] = saved.cfgs[id];
      }
      var f = fps(), c = state.scene.comp;
      if (!keepRange && !saved) {
        state.range.startFrame = Math.round(c.workAreaStart * f);
        state.range.endFrame = Math.round((c.workAreaStart + c.workAreaDuration) * f) - 1;
      }
      state.range.endFrame = Math.max(state.range.startFrame, Math.min(state.range.endFrame, Math.round(c.duration * f) - 1));
      state.scene.layers.forEach(function (info) {
        if (!state.cfgs[info.id]) state.cfgs[info.id] = SIM.defaultBody(info);
        else if (!info.supported) state.cfgs[info.id].include = false;
      });
      $('#compLabel').textContent = c.name + ' · ' + c.width + '×' + c.height + ' · ' + f + ' fps · ' +
        (state.scene.fromSelection ? state.scene.layers.length + ' selected' : 'all ' + state.scene.layers.length + ' layers');
      $('#previewContainer').classList.add('has-comp');
      renderWorld(); renderBodies(); renderBake();
      scheduleSim();
    });
  }

  // ---------- world UI ----------
  var worldParams = bindParams($('#worldParams'), WORLD_SPECS, function () { return state.world; }, function () { persist(); scheduleSim(); });
  function renderWorld() {
    worldParams.render();
    $$('#walls .chip').forEach(function (b) { b.classList.toggle('active', !!state.world[b.getAttribute('data-w')]); });
    $('#startFrame').value = state.range.startFrame;
    $('#endFrame').value = state.range.endFrame;
  }
  $$('#walls .chip').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-w');
      state.world[k] = !state.world[k];
      b.classList.toggle('active', state.world[k]);
      persist(); scheduleSim();
    });
  });
  function setRange(s, e) {
    var f = fps(), maxF = state.scene ? Math.round(state.scene.comp.duration * f) - 1 : 0;
    s = Math.max(0, Math.min(Math.round(s), maxF)); e = Math.max(s, Math.min(Math.round(e), maxF));
    var startChanged = s !== state.range.startFrame;
    state.range.startFrame = s; state.range.endFrame = e;
    $('#startFrame').value = s; $('#endFrame').value = e;
    persist();
    if (startChanged) refreshScene(true); else scheduleSim();
  }
  $('#startFrame').addEventListener('change', function () { setRange(num(this.value, 0), state.range.endFrame); });
  $('#endFrame').addEventListener('change', function () { setRange(state.range.startFrame, num(this.value, 0)); });
  $('#rangeWork').addEventListener('click', function () {
    if (!state.scene) return; var c = state.scene.comp, f = fps();
    setRange(Math.round(c.workAreaStart * f), Math.round((c.workAreaStart + c.workAreaDuration) * f) - 1);
  });
  $('#rangeComp').addEventListener('click', function () {
    if (!state.scene) return; setRange(0, Math.round(state.scene.comp.duration * fps()) - 1);
  });

  // ---------- card collapse ----------
  $$('.card-head[data-collapse]').forEach(function (head) {
    var id = head.getAttribute('data-collapse'), card = document.getElementById(id);
    if (uiPref('collapsed:' + id)) card.classList.add('collapsed');
    head.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      card.classList.toggle('collapsed');
      uiPref('collapsed:' + id, card.classList.contains('collapsed'));
    });
  });

  // ---------- bodies UI ----------
  var TYPES = ['dynamic', 'static', 'kinematic', 'dormant'], SHAPES = ['auto', 'box', 'circle', 'hull'];
  function optionList(list, cur) {
    return list.map(function (v) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + v + '</option>'; }).join('');
  }
  function renderBodies() {
    var list = $('#bodyList'); list.innerHTML = '';
    if (!state.scene) return;
    var included = 0;
    state.scene.layers.forEach(function (info) {
      var cfg = state.cfgs[info.id];
      if (cfg.include) included++;
      var row = document.createElement('div');
      row.className = 'body-row' + (cfg.include ? '' : ' excluded') + (info.supported ? '' : ' unsupported') + (state.selectedId === info.id ? ' selected' : '');
      row.setAttribute('data-id', info.id);
      row.title = info.supported ? (info.kind + (info.hasParent ? ' · parented' : '') + (info.hasKeys ? ' · animated' : '') + ' — click for settings, double-click to select in AE') : info.reason;
      row.innerHTML =
        '<label class="toggle-switch mini" title="Include in simulation"><input type="checkbox" data-inc' + (cfg.include ? ' checked' : '') + (info.supported ? '' : ' disabled') + '><span class="toggle-slider"></span></label>' +
        '<div class="swatch t-' + cfg.type + '"></div>' +
        '<div class="name">' + escapeHtml(info.name) + '<small>' + info.kind + '</small></div>' +
        '<select class="sel t-' + cfg.type + '" data-type title="dynamic: falls & collides · static: immovable · kinematic: follows its AE keyframes · dormant: asleep until hit">' + optionList(TYPES, cfg.type) + '</select>' +
        '<select class="sel" data-shape title="Collision shape">' + optionList(SHAPES, cfg.shape) + '</select>' +
        '<div class="caret">' + (state.selectedId === info.id ? '&#9660;' : '&#9654;') + '</div>';
      list.appendChild(row);
    });
    $('#bodyCount').textContent = included + ' / ' + state.scene.layers.length;
    renderDetail();
  }
  function infoById(id) { for (var i = 0; i < state.scene.layers.length; i++) if (state.scene.layers[i].id === id) return state.scene.layers[i]; return null; }

  $('#bodyList').addEventListener('change', function (e) {
    var row = e.target.closest('.body-row'); if (!row) return;
    var id = parseInt(row.getAttribute('data-id'), 10), cfg = state.cfgs[id];
    if (e.target.hasAttribute('data-inc')) cfg.include = e.target.checked;
    else if (e.target.hasAttribute('data-type')) cfg.type = e.target.value;
    else if (e.target.hasAttribute('data-shape')) cfg.shape = e.target.value;
    persist(); renderBodies(); scheduleSim();
  });
  $('#bodyList').addEventListener('click', function (e) {
    if (e.target.closest('select, label, input')) return;
    var row = e.target.closest('.body-row'); if (!row) return;
    var id = parseInt(row.getAttribute('data-id'), 10);
    state.selectedId = (state.selectedId === id) ? null : id;
    renderBodies(); draw();
  });
  $('#bodyList').addEventListener('dblclick', function (e) {
    if (e.target.closest('select, label, input')) return;
    var row = e.target.closest('.body-row'); if (!row) return;
    var id = parseInt(row.getAttribute('data-id'), 10), info = infoById(id);
    if (info) host('selectLayer', { id: id, index: info.index });
  });
  $$('[data-setall]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var t = btn.getAttribute('data-setall');
      for (var id in state.cfgs) if (state.cfgs[id].include) state.cfgs[id].type = t;
      persist(); renderBodies(); scheduleSim();
    });
  });

  // ---------- body detail ----------
  var detailBox = $('#bodyDetail');
  var detailParams = null;
  function renderDetail() {
    if (state.selectedId === null || !state.cfgs[state.selectedId]) { detailBox.className = 'body-detail hidden'; detailBox.innerHTML = ''; detailParams = null; return; }
    var cfg = state.cfgs[state.selectedId], info = infoById(state.selectedId);
    detailBox.className = 'body-detail';
    var html = '<div class="detail-title"><div class="swatch t-' + cfg.type + '"></div>' +
      '<span class="name">' + escapeHtml(info ? info.name : '') + '</span>' +
      '<button class="chip tiny" data-copyall title="Apply these settings to every included body">copy to all</button>' +
      '<button class="chip tiny" data-reset title="Reset this body to defaults">reset</button>' +
      '<button class="chip tiny" data-selectae title="Select this layer in the timeline">select in AE</button></div>' +
      '<div class="detail-params"></div>' +
      '<div class="toggle-grid">' +
      toggleItem('fixedRotation', 'Lock rotation', cfg.fixedRotation, 'Body never rotates') +
      toggleItem('bullet', 'Bullet', cfg.bullet, 'Continuous collision — for very fast objects that would otherwise tunnel') +
      toggleItem('collide', 'Collides', cfg.collide !== false, 'Off = passes through everything (still affected by gravity)') +
      '</div>';
    if (info && info.hasParent) html += '<div class="note"><b>Parented layer</b> — it will be un-parented when baked (if "Unparent" is on).</div>';
    if (info && info.hasExpression) html += '<div class="note"><b>Has a Position/Rotation expression</b> — it will be disabled when baked.</div>';
    detailBox.innerHTML = html;
    detailParams = bindParams($('.detail-params', detailBox), BODY_SPECS, function () { return state.cfgs[state.selectedId]; }, function () { persist(); scheduleSim(); });
    detailParams.render();
  }
  function toggleItem(key, label, on, title) {
    return '<label class="toggle-item" title="' + escapeHtml(title) + '"><span class="toggle-label">' + label + '</span>' +
      '<span class="toggle-switch"><input type="checkbox" data-d="' + key + '"' + (on ? ' checked' : '') + '><span class="toggle-slider"></span></span></label>';
  }
  detailBox.addEventListener('change', function (e) {
    var k = e.target.getAttribute('data-d'); if (!k) return;
    state.cfgs[state.selectedId][k] = e.target.checked;
    persist(); scheduleSim();
  });
  detailBox.addEventListener('click', function (e) {
    var cfg = state.cfgs[state.selectedId]; if (!cfg) return;
    if (e.target.hasAttribute('data-selectae')) { var info = infoById(state.selectedId); if (info) host('selectLayer', { id: info.id, index: info.index }); }
    else if (e.target.hasAttribute('data-reset')) {
      var d = SIM.defaultBody(infoById(state.selectedId));
      BODY_SPECS.forEach(function (s) { cfg[s.key] = d[s.key]; });
      cfg.fixedRotation = d.fixedRotation; cfg.bullet = d.bullet; cfg.collide = d.collide;
      persist(); renderDetail(); scheduleSim(); setStatus('Body reset to defaults.', 'ok');
    } else if (e.target.hasAttribute('data-copyall')) {
      var n = 0;
      for (var id in state.cfgs) {
        if (!state.cfgs[id].include || String(id) === String(state.selectedId)) continue;
        BODY_SPECS.forEach(function (s) { state.cfgs[id][s.key] = cfg[s.key]; });
        state.cfgs[id].fixedRotation = cfg.fixedRotation; state.cfgs[id].bullet = cfg.bullet; state.cfgs[id].collide = cfg.collide;
        n++;
      }
      persist(); scheduleSim(); setStatus('Copied settings to ' + n + ' other bod' + (n === 1 ? 'y' : 'ies') + '.', 'ok');
    }
  });

  // ---------- bake UI ----------
  var bakeParams = bindParams($('#bakeParams'), BAKE_SPECS, function () { return state.bake; }, function () { persist(); });
  function renderBake() {
    $$('[data-b]').forEach(function (el) { el.checked = !!state.bake[el.getAttribute('data-b')]; });
    bakeParams.render();
  }
  $$('[data-b]').forEach(function (el) {
    el.addEventListener('change', function () { state.bake[el.getAttribute('data-b')] = el.checked; persist(); });
  });

  // ---------- simulation ----------
  function scheduleSim() {
    clearTimeout(state.simTimer);
    state.simTimer = setTimeout(runSim, 120);
  }
  function runSim() {
    if (!state.scene) return;
    var f = fps(), start = state.range.startFrame / f, count = state.range.endFrame - state.range.startFrame + 1;
    var kinIds = [];
    state.scene.layers.forEach(function (info) {
      var cfg = state.cfgs[info.id];
      if (info.supported && cfg.include && cfg.type === 'kinematic') kinIds.push(info.id);
    });
    setStatus('Simulating…', 'busy');
    var proceed = function (samples) {
      var t0 = Date.now();
      try {
        state.result = SIM.run(state.scene, { world: state.world, start: start, count: count, fps: f, bodies: state.cfgs, kinematic: samples || {} });
      } catch (e) { state.result = null; setStatus('Simulation error: ' + (e.message || e), 'err'); draw(); return; }
      if (state.frame > count - 1) state.frame = 0;
      updateTransport(); draw();
      setStatus(count + ' frames · ' + state.result.bodyCount + ' bodies · ' + (Date.now() - t0) + ' ms', 'ok');
    };
    if (kinIds.length && isCEP) {
      host('sampleTransforms', { ids: kinIds, start: start, count: count, fps: f }, function (res) {
        var r = parseResult(res);
        if (r.err) setStatus('Kinematic sampling failed: ' + r.err, 'err');
        proceed(r.data ? r.data.samples : {});
      });
    } else proceed({});
  }

  // ---------- preview ----------
  function fitCanvas() {
    var wrap = canvas.parentNode, W = wrap.clientWidth - 2;
    var c = state.scene ? state.scene.comp : { width: 16, height: 9 };
    var H = Math.max(80, Math.min(Math.round(W * c.height / c.width), Math.round(window.innerHeight * 0.4)));
    var dpr = window.devicePixelRatio || 1;
    canvas.style.height = H + 'px';
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    return { W: W, H: H, dpr: dpr };
  }
  function draw() {
    var m = fitCanvas(), dpr = m.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, m.W, m.H);
    if (!state.scene) return;
    var c = state.scene.comp, s = Math.min(m.W / c.width, m.H / c.height) * 0.94;
    var ox = (m.W - c.width * s) / 2, oy = (m.H - c.height * s) / 2;
    ctx.fillStyle = '#0a0a12'; ctx.fillRect(ox, oy, c.width * s, c.height * s);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; ctx.strokeRect(ox + 0.5, oy + 0.5, c.width * s, c.height * s);
    // walls
    ctx.strokeStyle = 'rgba(255,0,200,0.75)'; ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(255,0,200,0.6)'; ctx.shadowBlur = 6;
    var w = state.world, off = (w.boundsOffset || 0) * s;
    ctx.beginPath();
    if (w.floor) { ctx.moveTo(ox, oy + c.height * s - off); ctx.lineTo(ox + c.width * s, oy + c.height * s - off); }
    if (w.ceiling) { ctx.moveTo(ox, oy + off); ctx.lineTo(ox + c.width * s, oy + off); }
    if (w.left) { ctx.moveTo(ox + off, oy); ctx.lineTo(ox + off, oy + c.height * s); }
    if (w.right) { ctx.moveTo(ox + c.width * s - off, oy); ctx.lineTo(ox + c.width * s - off, oy + c.height * s); }
    ctx.stroke();
    ctx.shadowBlur = 0;
    // gravity arrow (bottom-left corner)
    if (w.gravity > 0) {
      var ga = w.gravityAngle * Math.PI / 180, gl = 14, gx = ox + 18, gy = oy + c.height * s - 32;
      ctx.strokeStyle = 'rgba(123,47,247,0.9)'; ctx.fillStyle = 'rgba(123,47,247,0.9)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + Math.cos(ga) * gl, gy + Math.sin(ga) * gl); ctx.stroke();
      var tx = gx + Math.cos(ga) * gl, ty = gy + Math.sin(ga) * gl;
      ctx.beginPath(); ctx.moveTo(tx, ty);
      ctx.lineTo(tx - Math.cos(ga - 0.5) * 5, ty - Math.sin(ga - 0.5) * 5); ctx.lineTo(tx - Math.cos(ga + 0.5) * 5, ty - Math.sin(ga + 0.5) * 5);
      ctx.closePath(); ctx.fill();
    }
    if (!state.result) return;
    var f = Math.min(state.frame, state.result.count - 1);
    state.result.bodies.forEach(function (b) {
      var x = b.x[f], y = b.y[f], a = b.r[f] * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
      var col = COLORS[b.type] || '#fff', sel = b.id === state.selectedId;
      ctx.fillStyle = hexA(col, sel ? 0.55 : 0.3); ctx.strokeStyle = sel ? '#fff' : col; ctx.lineWidth = sel ? 2 : 1;
      b.geom.fixtures.forEach(function (fx) {
        ctx.beginPath();
        if (fx.kind === 'circle') {
          var cx = x + fx.cx * cs - fx.cy * sn, cy = y + fx.cx * sn + fx.cy * cs;
          ctx.arc(ox + cx * s, oy + cy * s, Math.max(1, fx.r * s), 0, Math.PI * 2);
          ctx.moveTo(ox + cx * s, oy + cy * s); ctx.lineTo(ox + (cx + fx.r * cs) * s, oy + (cy + fx.r * sn) * s);
        } else {
          for (var i = 0; i < fx.pts.length; i++) {
            var p = fx.pts[i], px = x + p[0] * cs - p[1] * sn, py = y + p[0] * sn + p[1] * cs;
            if (i === 0) ctx.moveTo(ox + px * s, oy + py * s); else ctx.lineTo(ox + px * s, oy + py * s);
          }
          ctx.closePath();
        }
        ctx.fill(); ctx.stroke();
      });
      if (sel || state.result.bodies.length <= 24) {
        ctx.fillStyle = sel ? '#fff' : '#bbb'; ctx.font = (sel ? 'bold ' : '') + '10px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(b.name.length > 18 ? b.name.substring(0, 17) + '…' : b.name, ox + x * s, oy + y * s - 4);
      }
    });
  }
  function hexA(hex, a) {
    var n = parseInt(hex.substring(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ---------- transport ----------
  var slider = $('#frameSlider');
  function updateTransport() {
    var count = state.result ? state.result.count : 0;
    slider.max = Math.max(0, count - 1); slider.value = state.frame; paintRange(slider);
    var t = state.scene ? ((state.range.startFrame + state.frame) / fps()) : 0;
    $('#frameLabel').textContent = (state.range.startFrame + state.frame) + ' / ' + (state.range.endFrame) + ' · ' + t.toFixed(2) + 's';
    var pb = $('#playBtn');
    pb.innerHTML = state.playing ? '&#10074;&#10074;' : '&#9654;';
    pb.classList.toggle('active', state.playing);
  }
  function setFrame(f, fromUser) {
    state.frame = Math.max(0, Math.min(f, state.result ? state.result.count - 1 : 0));
    updateTransport(); draw();
    if (fromUser && $('#syncTime').checked) host('setTime', (state.range.startFrame + state.frame) / fps());
  }
  slider.addEventListener('input', function () { setFrame(parseInt(slider.value, 10), true); });
  function play(on) {
    state.playing = on; clearInterval(state.playTimer);
    if (on) state.playTimer = setInterval(function () {
      if (!state.result) return;
      setFrame(state.frame + 1 >= state.result.count ? 0 : state.frame + 1, false);
    }, 1000 / fps());
    updateTransport();
  }
  $('#playBtn').addEventListener('click', function () { play(!state.playing); });
  $('#stopBtn').addEventListener('click', function () { play(false); setFrame(0, true); });
  $('#previewContainer').addEventListener('click', function () { if (state.result) play(!state.playing); });
  $('#refreshBtn').addEventListener('click', function () { refreshScene(true); });
  window.addEventListener('resize', draw);
  document.addEventListener('keydown', function (e) {
    var tag = e.target.tagName;
    if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'SELECT') { e.preventDefault(); play(!state.playing); }
    if (tag === 'INPUT' && e.target.type === 'number' && e.key === 'Enter') e.target.blur();
  });

  // ---------- bake ----------
  function round3(arr) { var o = new Array(arr.length); for (var i = 0; i < arr.length; i++) o[i] = Math.round(arr[i] * 1000) / 1000; return o; }
  function bake() {
    if (!state.result || state.busy) return;
    var bodies = [];
    state.result.bodies.forEach(function (b) {
      if (b.type === 'dynamic' || b.type === 'dormant') bodies.push({ id: b.id, index: b.index, name: b.name, x: round3(b.x), y: round3(b.y), r: round3(b.r) });
    });
    if (!bodies.length) { setStatus('Nothing to bake — no dynamic bodies.', 'err'); return; }
    var payload = { start: state.result.start, fps: state.result.fps, count: state.result.count, step: state.bake.step,
      unparent: state.bake.unparent, clearRange: state.bake.clearRange, linear: state.bake.linear, bakeRotation: state.bake.rotation, bodies: bodies };
    var json = JSON.stringify(payload);
    state.busy = true; $('#bakeBtn').disabled = true;
    setStatus('Baking ' + bodies.length + ' layers × ' + state.result.count + ' frames…', 'busy');
    var done = function (res) {
      state.busy = false; $('#bakeBtn').disabled = false;
      var r = parseResult(res);
      if (r.err) setStatus('Bake failed: ' + r.err, 'err');
      else setStatus((r.text || res).replace(/^OK:\s*/, ''), 'ok');
    };
    if (hasFS && json.length > 60000) {
      host('tempPath', undefined, function (p) {
        if (!p || p.indexOf('ERR:') === 0) { host('bake', payload, done); return; }
        var w = window.cep.fs.writeFile(p, json, window.cep.encoding.UTF8);
        if (w && w.err === 0) host('bakeFromFile', p, done); else host('bake', payload, done);
      });
    } else host('bake', payload, done);
  }
  $('#bakeBtn').addEventListener('click', bake);

  // ---------- boot ----------
  renderWorld(); renderBake(); draw(); updateTransport();
  if (isCEP) {
    host('ping', undefined, function (res) {
      if (typeof res === 'string' && res.indexOf('PHY') === 0) refreshScene(false);
      else setStatus('Host script not loaded (' + res + '). Reopen the panel.', 'err');
    });
  } else {
    setStatus('Not running inside After Effects — preview only.', 'err');
  }
})();
