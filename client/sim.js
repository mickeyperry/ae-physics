/* AE Physics — builds a planck.js (Box2D) world from an AE scene and runs it to per-frame transforms.
   Units: scene is in comp pixels / degrees; physics runs in meters / radians (PPM = pixels per meter).
   Coordinates stay y-down like AE, so gravity "down" is +y and positive angles are clockwise on screen —
   exactly AE's rotation convention, so body angles map to Rotation without any sign flip. */
(function (root) {
  'use strict';
  var planck = root.planck || (typeof require === 'function' ? require('./planck.min.js') : null);
  var GEO = root.GEO || (typeof require === 'function' ? require('./geometry.js') : null);
  if (!planck) throw new Error('planck.js not loaded');

  var Vec2 = planck.Vec2, DEG = Math.PI / 180, RAD = 180 / Math.PI;
  var MAX_POLY = 8;

  var SIM = {};

  SIM.defaultWorld = function () {
    return { gravity: 9.8, gravityAngle: 90, ppm: 100, substeps: 8, velIters: 8, posIters: 3, timeScale: 1,
      floor: true, left: false, right: false, ceiling: false, boundsFriction: 0.5, boundsRestitution: 0.2, boundsOffset: 0 };
  };
  SIM.defaultBody = function (info) {
    return { include: !!(info && info.supported && info.kind !== 'null'),
      type: (info && info.hasKeys) ? 'kinematic' : 'dynamic', shape: 'auto',
      density: 1, friction: 0.4, restitution: 0.3, linearDamping: 0, angularDamping: 0.05,
      fixedRotation: false, bullet: false, vx: 0, vy: 0, angularVelocity: 0, collide: true };
  };

  // layer space -> body space (px relative to anchor, world scale applied, NO rotation: rotation becomes the body angle)
  function layerMatrix(info) {
    var sx = (info.scale ? info.scale[0] : 100) / 100, sy = (info.scale ? info.scale[1] : 100) / 100;
    return GEO.multiply(GEO.scale(sx, sy), GEO.translate(-info.anchor[0], -info.anchor[1]));
  }
  function chainMatrix(xf) {
    var m = GEO.identity();
    for (var i = 0; i < (xf || []).length; i++) m = GEO.multiply(m, GEO.trs(xf[i].anchor, xf[i].position, xf[i].scale, xf[i].rotation));
    return m;
  }
  function polyFixturesFrom(pts, out) {
    var hull = GEO.convexHull(GEO.dedupe(pts, 0.25));
    if (hull.length < 3 || Math.abs(GEO.area(hull)) < 1) return;
    var chunks = GEO.chunkConvex(hull, MAX_POLY);
    for (var i = 0; i < chunks.length; i++) out.push({ kind: 'poly', pts: chunks[i] });
  }
  function primitiveToFixtures(prim, F, out, allPts) {
    var pts, c, M;
    if (prim.type === 'rect') {
      pts = GEO.applyAll(F, GEO.roundedRect(prim.position[0], prim.position[1], Math.abs(prim.size[0]), Math.abs(prim.size[1]), prim.roundness, 3));
    } else if (prim.type === 'ellipse') {
      var rx = Math.abs(prim.size[0]) / 2, ry = Math.abs(prim.size[1]) / 2, s = GEO.uniformScale(F, 1e-3);
      if (s !== null && Math.abs(rx - ry) < 1e-3 * Math.max(1, rx)) {
        c = GEO.apply(F, prim.position);
        out.push({ kind: 'circle', cx: c[0], cy: c[1], r: rx * s });
        var ring = GEO.applyAll(F, GEO.ellipsePoly(prim.position[0], prim.position[1], rx, ry, 16));
        for (var q = 0; q < ring.length; q++) allPts.push(ring[q]);
        return;
      }
      pts = GEO.applyAll(F, GEO.ellipsePoly(prim.position[0], prim.position[1], rx, ry, 24));
    } else if (prim.type === 'star') {
      pts = GEO.applyAll(F, GEO.starPoly(prim.position[0], prim.position[1], prim.points, prim.outerRadius, prim.innerRadius, prim.rotation, prim.starType));
    } else if (prim.type === 'path') {
      pts = GEO.applyAll(F, GEO.sampleShape(prim, 6));
    } else return;
    for (var i = 0; i < pts.length; i++) allPts.push(pts[i]);
    polyFixturesFrom(pts, out);
  }

  // Returns { fixtures: [ {kind:'poly',pts} | {kind:'circle',cx,cy,r} ], mode }
  SIM.buildGeometry = function (info, cfg) {
    var L = layerMatrix(info), fixtures = [], allPts = [], i;
    var mode = (cfg && cfg.shape) || 'auto';
    var rect = info.rect || { left: 0, top: 0, width: 100, height: 100 };
    var rcx = rect.left + rect.width / 2, rcy = rect.top + rect.height / 2;
    var prims = (info.shapes && info.shapes.length) ? info.shapes : ((info.masks && info.masks.length) ? info.masks : null);

    if (mode === 'circle') {
      var s = GEO.uniformScale(L, 1e-3), c = GEO.apply(L, [rcx, rcy]);
      var r = (s !== null) ? Math.min(rect.width, rect.height) / 2 * s
                           : Math.min(rect.width * Math.abs(L.a), rect.height * Math.abs(L.d)) / 2;
      fixtures.push({ kind: 'circle', cx: c[0], cy: c[1], r: Math.max(r, 0.5) });
      return { fixtures: fixtures, mode: mode };
    }
    if (mode === 'box' || !prims) {
      polyFixturesFrom(GEO.applyAll(L, GEO.rectPoly(rcx, rcy, rect.width, rect.height)), fixtures);
      return { fixtures: fixtures, mode: prims ? mode : 'box' };
    }
    for (i = 0; i < prims.length; i++) {
      var F = GEO.multiply(L, chainMatrix(prims[i].xf));
      primitiveToFixtures(prims[i], F, mode === 'hull' ? [] : fixtures, allPts);
    }
    if (mode === 'hull' || fixtures.length === 0) {
      fixtures = [];
      if (allPts.length >= 3) polyFixturesFrom(allPts, fixtures);
      else polyFixturesFrom(GEO.applyAll(L, GEO.rectPoly(rcx, rcy, rect.width, rect.height)), fixtures);
      return { fixtures: fixtures, mode: 'hull' };
    }
    return { fixtures: fixtures, mode: mode };
  };

  function addBounds(world, scene, w) {
    var ppm = w.ppm, W = scene.comp.width / ppm, H = scene.comp.height / ppm, off = (w.boundsOffset || 0) / ppm;
    var big = Math.max(W, H) * 6, thick = 0.5;
    var fd = { density: 0, friction: w.boundsFriction, restitution: w.boundsRestitution };
    var body = world.createBody({ type: 'static', position: new Vec2(0, 0), userData: { bounds: true } });
    if (w.floor)   body.createFixture(new planck.Box(big, thick, new Vec2(W / 2, H - off + thick)), fd);
    if (w.ceiling) body.createFixture(new planck.Box(big, thick, new Vec2(W / 2, off - thick)), fd);
    if (w.left)    body.createFixture(new planck.Box(thick, big, new Vec2(off - thick, H / 2)), fd);
    if (w.right)   body.createFixture(new planck.Box(thick, big, new Vec2(W - off + thick, H / 2)), fd);
    return body;
  }

  // opts: { world, start, count, fps, bodies: {id: cfg}, kinematic: {id: {x,y,r}} }
  SIM.run = function (scene, opts) {
    var w = opts.world || SIM.defaultWorld(), ppm = w.ppm || 100;
    var fps = opts.fps || scene.comp.fps, count = Math.max(1, opts.count | 0);
    var dt = (1 / fps) * (w.timeScale || 1), sub = Math.max(1, w.substeps | 0), sdt = dt / sub;
    var ga = (w.gravityAngle || 0) * DEG, g = w.gravity || 0;

    planck.Settings.maxPolygonVertices = Math.max(planck.Settings.maxPolygonVertices || 8, MAX_POLY);
    var world = new planck.World({ gravity: new Vec2(Math.cos(ga) * g, Math.sin(ga) * g), allowSleep: true });
    addBounds(world, scene, w);

    var bodies = [], i, k;
    for (i = 0; i < scene.layers.length; i++) {
      var info = scene.layers[i];
      if (!info.supported) continue;
      var cfg = (opts.bodies && opts.bodies[info.id]) || SIM.defaultBody(info);
      if (!cfg.include) continue;
      var geom = SIM.buildGeometry(info, cfg);
      if (!geom.fixtures.length) continue;
      var type = cfg.type === 'dormant' ? 'dynamic' : cfg.type;
      var kin = (cfg.type === 'kinematic' && opts.kinematic) ? opts.kinematic[info.id] : null;
      var body = world.createBody({
        type: type,
        position: new Vec2(info.position[0] / ppm, info.position[1] / ppm),
        angle: info.rotation * DEG,
        linearVelocity: new Vec2((cfg.vx || 0) / ppm, (cfg.vy || 0) / ppm),
        angularVelocity: (cfg.angularVelocity || 0) * DEG,
        linearDamping: cfg.linearDamping || 0,
        angularDamping: cfg.angularDamping || 0,
        fixedRotation: !!cfg.fixedRotation,
        bullet: !!cfg.bullet,
        awake: cfg.type !== 'dormant',
        allowSleep: true,
        userData: { id: info.id }
      });
      var fd = { density: cfg.density > 0 ? cfg.density : (type === 'dynamic' ? 1 : 0), friction: cfg.friction, restitution: cfg.restitution };
      if (cfg.collide === false) fd.filterMaskBits = 0;
      for (k = 0; k < geom.fixtures.length; k++) {
        var fx = geom.fixtures[k];
        if (fx.kind === 'circle') body.createFixture(new planck.Circle(new Vec2(fx.cx / ppm, fx.cy / ppm), fx.r / ppm), fd);
        else {
          var verts = [];
          for (var v = 0; v < fx.pts.length; v++) verts.push(new Vec2(fx.pts[v][0] / ppm, fx.pts[v][1] / ppm));
          try { body.createFixture(new planck.Polygon(verts), fd); } catch (e) { /* degenerate piece */ }
        }
      }
      bodies.push({ id: info.id, index: info.index, name: info.name, type: cfg.type, body: body, geom: geom, kin: kin,
        x: new Array(count), y: new Array(count), r: new Array(count) });
    }

    function kinAt(b, f) {
      if (!b.kin || !b.kin.x || !b.kin.x.length) return null;
      var n = b.kin.x.length, j = Math.min(Math.max(f, 0), n - 1);
      return [b.kin.x[j], b.kin.y[j], b.kin.r[j]];
    }
    for (i = 0; i < bodies.length; i++) {
      var s0 = kinAt(bodies[i], 0);
      if (s0) bodies[i].body.setTransform(new Vec2(s0[0] / ppm, s0[1] / ppm), s0[2] * DEG);
    }

    for (var f = 0; f < count; f++) {
      for (i = 0; i < bodies.length; i++) {
        var b = bodies[i], p = b.body.getPosition();
        b.x[f] = p.x * ppm; b.y[f] = p.y * ppm; b.r[f] = b.body.getAngle() * RAD;
      }
      if (f === count - 1) break;
      for (i = 0; i < bodies.length; i++) {
        var kb = bodies[i];
        if (kb.type !== 'kinematic') continue;
        var cur = kinAt(kb, f), nxt = kinAt(kb, f + 1);
        if (!cur || !nxt) continue;
        kb.body.setTransform(new Vec2(cur[0] / ppm, cur[1] / ppm), cur[2] * DEG);
        kb.body.setLinearVelocity(new Vec2((nxt[0] - cur[0]) / ppm / dt, (nxt[1] - cur[1]) / ppm / dt));
        kb.body.setAngularVelocity((nxt[2] - cur[2]) * DEG / dt);
      }
      for (var s = 0; s < sub; s++) world.step(sdt, w.velIters || 8, w.posIters || 3);
    }

    var out = { count: count, fps: fps, start: opts.start || 0, ppm: ppm, bodyCount: bodies.length, bodies: [] };
    for (i = 0; i < bodies.length; i++) {
      var bb = bodies[i];
      out.bodies.push({ id: bb.id, index: bb.index, name: bb.name, type: bb.type, geom: bb.geom, x: bb.x, y: bb.y, r: bb.r });
    }
    return out;
  };

  root.SIM = SIM;
  if (typeof module !== 'undefined' && module.exports) module.exports = SIM;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
