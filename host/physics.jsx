// AE Physics — ExtendScript host. Loaded by the CEP panel via manifest <ScriptPath>.
// Defines PHY.* ; every function takes ONE JSON string and returns a string
// (JSON on success, "ERR: ..." on failure). ES3 only: no map/filter/indexOf.

var PHY = (function () {
    var VERSION = "0.1.0";

    var J = (typeof JSON !== "undefined" && JSON.stringify && JSON.parse) ? JSON : (function () {
        function q(s) {
            return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
        }
        function stringify(v) {
            if (v === null || v === undefined) return "null";
            var t = typeof v;
            if (t === "number") return isFinite(v) ? String(v) : "null";
            if (t === "boolean") return v ? "true" : "false";
            if (t === "string") return q(v);
            var i, a = [];
            if (v instanceof Array) {
                for (i = 0; i < v.length; i++) a.push(stringify(v[i]));
                return "[" + a.join(",") + "]";
            }
            for (var k in v) {
                if (v.hasOwnProperty(k) && typeof v[k] !== "function" && v[k] !== undefined) a.push(q(k) + ":" + stringify(v[k]));
            }
            return "{" + a.join(",") + "}";
        }
        return { stringify: stringify, parse: function (s) { return eval("(" + s + ")"); } };
    })();

    function r4(n) { return Math.round(n * 10000) / 10000; }
    function r4a(arr) { var o = []; for (var i = 0; i < arr.length; i++) o.push(r4(arr[i])); return o; }

    function activeComp() {
        var it = app.project.activeItem;
        return (it && it instanceof CompItem) ? it : null;
    }
    function xg(L) { return L.property("ADBE Transform Group"); }
    function pv(L, match, t) {
        var g = xg(L); if (!g) return null;
        var p = g.property(match);
        if (!p) return null;
        try { return p.valueAtTime(t, false); } catch (e) { return p.value; }
    }
    function anchorAt(L, t) { var v = pv(L, "ADBE Anchor Point", t); return v ? [v[0], v[1]] : [0, 0]; }
    function rotAt(L, t) { var v = pv(L, "ADBE Rotate Z", t); return (v === null) ? 0 : v; }
    function scaleAt(L, t) { var v = pv(L, "ADBE Scale", t); return v ? [v[0], v[1]] : [100, 100]; }
    function worldRot(L, t) {
        var r = 0, cur = L, guard = 0;
        while (cur && guard++ < 64) { r += rotAt(cur, t); cur = cur.parent; }
        return r;
    }
    function worldScale(L, t) {
        var sx = 1, sy = 1, cur = L, guard = 0;
        while (cur && guard++ < 64) { var s = scaleAt(cur, t); sx *= s[0] / 100; sy *= s[1] / 100; cur = cur.parent; }
        return [sx * 100, sy * 100];
    }
    function worldAnchorPos(L, t) {
        var a = anchorAt(L, t);
        if (L.parent) {
            try { var p = L.toComp([a[0], a[1]], t); return [p[0], p[1]]; } catch (e) { }
        }
        var pos = pv(L, "ADBE Position", t) || [0, 0];
        return [pos[0], pos[1]];
    }

    function kindOf(L) {
        if (L instanceof ShapeLayer) return "shape";
        if (L instanceof TextLayer) return "text";
        if (L.nullLayer) return "null";
        var src = L.source;
        if (src instanceof CompItem) return "precomp";
        if (src && src.mainSource && (src.mainSource instanceof SolidSource)) return "solid";
        return "footage";
    }

    // ---------- shape layer geometry ----------
    function groupXf(g, t) {
        var d = { anchor: [0, 0], position: [0, 0], scale: [100, 100], rotation: 0 };
        var tg = g.property("ADBE Vector Transform Group");
        if (!tg) return d;
        function gv(m, dflt) { var p = tg.property(m); if (!p) return dflt; try { return p.valueAtTime(t, false); } catch (e) { return dflt; } }
        var a = gv("ADBE Vector Anchor", [0, 0]), p = gv("ADBE Vector Position", [0, 0]);
        var s = gv("ADBE Vector Scale", [100, 100]), r = gv("ADBE Vector Rotation", 0);
        return { anchor: [r4(a[0]), r4(a[1])], position: [r4(p[0]), r4(p[1])], scale: [r4(s[0]), r4(s[1])], rotation: r4(r) };
    }
    function val(it, m, t, dflt) { var p = it.property(m); if (!p) return dflt; try { return p.valueAtTime(t, false); } catch (e) { return dflt; } }
    function pathObj(shape, xfChain) {
        var v = [], i = [], o = [], k;
        for (k = 0; k < shape.vertices.length; k++) {
            v.push(r4a(shape.vertices[k]));
            i.push(r4a(shape.inTangents[k]));
            o.push(r4a(shape.outTangents[k]));
        }
        return { type: "path", xf: xfChain, vertices: v, inTangents: i, outTangents: o, closed: shape.closed };
    }
    function walkVectors(container, t, xfChain, out, depth) {
        if (depth > 12) return;
        for (var n = 1; n <= container.numProperties; n++) {
            var it = container.property(n);
            if (!it) continue;
            try { if (it.enabled === false) continue; } catch (e0) { }
            var mn = it.matchName;
            try {
                if (mn === "ADBE Vector Group") {
                    var chain = xfChain.concat([groupXf(it, t)]);
                    var contents = it.property("ADBE Vectors Group");
                    if (contents) walkVectors(contents, t, chain, out, depth + 1);
                } else if (mn === "ADBE Vector Shape - Rect") {
                    out.push({ type: "rect", xf: xfChain,
                        size: r4a(val(it, "ADBE Vector Rect Size", t, [100, 100])),
                        position: r4a(val(it, "ADBE Vector Rect Position", t, [0, 0])),
                        roundness: r4(val(it, "ADBE Vector Rect Roundness", t, 0)) });
                } else if (mn === "ADBE Vector Shape - Ellipse") {
                    out.push({ type: "ellipse", xf: xfChain,
                        size: r4a(val(it, "ADBE Vector Ellipse Size", t, [100, 100])),
                        position: r4a(val(it, "ADBE Vector Ellipse Position", t, [0, 0])) });
                } else if (mn === "ADBE Vector Shape - Star") {
                    out.push({ type: "star", xf: xfChain,
                        starType: val(it, "ADBE Vector Star Type", t, 2),
                        points: val(it, "ADBE Vector Star Points", t, 5),
                        position: r4a(val(it, "ADBE Vector Star Position", t, [0, 0])),
                        rotation: r4(val(it, "ADBE Vector Star Rotation", t, 0)),
                        innerRadius: r4(val(it, "ADBE Vector Star Inner Radius", t, 50)),
                        outerRadius: r4(val(it, "ADBE Vector Star Outer Radius", t, 100)) });
                } else if (mn === "ADBE Vector Shape - Group") {
                    var sp = it.property("ADBE Vector Shape");
                    if (sp) out.push(pathObj(sp.valueAtTime(t, false), xfChain));
                }
            } catch (e) { }
        }
    }
    function shapesOf(L, t) {
        var out = [];
        var root = L.property("ADBE Root Vectors Group");
        if (root) walkVectors(root, t, [], out, 0);
        return out;
    }
    function masksOf(L, t) {
        var out = [];
        var mp = L.property("ADBE Mask Parade");
        if (!mp) return out;
        for (var n = 1; n <= mp.numProperties; n++) {
            var m = mp.property(n);
            try {
                if (m.maskMode === MaskMode.NONE || m.maskMode === MaskMode.SUBTRACT || m.inverted) continue;
                var sp = m.property("ADBE Mask Shape");
                if (sp) out.push(pathObj(sp.valueAtTime(t, false), []));
            } catch (e) { }
        }
        return out;
    }

    function layerInfo(L, t) {
        var info = { index: L.index, id: L.id, name: L.name, enabled: L.enabled, supported: true, reason: "",
            inPoint: r4(L.inPoint), outPoint: r4(L.outPoint) };
        // TextLayer/ShapeLayer fail `instanceof AVLayer` in some ExtendScript builds, so duck-type instead.
        var isVisual = !(L instanceof CameraLayer) && !(L instanceof LightLayer) && (typeof L.hasVideo !== "undefined") && !!xg(L);
        if (!isVisual) { info.supported = false; info.reason = "not a visual layer"; info.kind = "other"; return info; }
        if (!L.hasVideo) { info.supported = false; info.reason = "audio only"; info.kind = "audio"; return info; }
        info.kind = kindOf(L);
        if (L.threeDLayer) { info.supported = false; info.reason = "3D layer (2D only)"; }
        else if (L.adjustmentLayer) { info.supported = false; info.reason = "adjustment layer"; }
        else if (L.locked) { info.supported = false; info.reason = "locked"; }

        info.anchor = r4a(anchorAt(L, t));
        info.position = r4a(worldAnchorPos(L, t));
        info.rotation = r4(worldRot(L, t));
        info.scale = r4a(worldScale(L, t));
        info.hasParent = !!L.parent;
        var g = xg(L);
        var posP = g ? g.property("ADBE Position") : null, rotP = g ? g.property("ADBE Rotate Z") : null;
        info.hasKeys = !!((posP && posP.numKeys > 0) || (rotP && rotP.numKeys > 0));
        info.hasExpression = !!((posP && posP.expression && posP.expression.length) || (rotP && rotP.expression && rotP.expression.length));

        var rect = null;
        try { rect = L.sourceRectAtTime(t, true); } catch (e1) { }
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
            try { rect = L.sourceRectAtTime(L.inPoint, true); } catch (e2) { }
        }
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
            var w = 100, h = 100;
            try { if (L.width && L.height) { w = L.width; h = L.height; } } catch (e3) { }
            rect = { left: 0, top: 0, width: w, height: h };
        }
        info.rect = { left: r4(rect.left), top: r4(rect.top), width: r4(rect.width), height: r4(rect.height) };

        info.shapes = (info.kind === "shape") ? shapesOf(L, t) : [];
        info.masks = (info.kind !== "shape") ? masksOf(L, t) : [];
        return info;
    }

    function getScene(json) {
        try {
            var o = json ? J.parse(json) : {};
            var comp = activeComp();
            if (!comp) return "ERR: Open a composition first.";
            var t = (typeof o.time === "number") ? o.time : comp.workAreaStart;
            var i, layers = [];
            var useSel = comp.selectedLayers.length > 0 && !o.all;
            if (useSel) { for (i = 0; i < comp.selectedLayers.length; i++) layers.push(comp.selectedLayers[i]); }
            else { for (i = 1; i <= comp.numLayers; i++) layers.push(comp.layer(i)); }
            var out = {
                version: VERSION,
                comp: { id: comp.id, name: comp.name, width: comp.width, height: comp.height,
                    fps: r4(1 / comp.frameDuration), duration: r4(comp.duration),
                    workAreaStart: r4(comp.workAreaStart), workAreaDuration: r4(comp.workAreaDuration), time: r4(comp.time) },
                sampleTime: r4(t), fromSelection: useSel, layers: []
            };
            for (i = 0; i < layers.length; i++) {
                var L = layers[i];
                try { out.layers.push(layerInfo(L, t)); }
                catch (e) { out.layers.push({ index: L.index, id: L.id, name: L.name, kind: "other", supported: false, reason: "read error: " + e }); }
            }
            return J.stringify(out);
        } catch (e2) { return "ERR: " + e2; }
    }

    function findLayer(comp, id, index) {
        for (var i = 1; i <= comp.numLayers; i++) { if (comp.layer(i).id === id) return comp.layer(i); }
        if (index >= 1 && index <= comp.numLayers) return comp.layer(index);
        return null;
    }

    function sampleTransforms(json) {
        try {
            var o = J.parse(json);
            var comp = activeComp();
            if (!comp) return "ERR: Open a composition first.";
            var out = { samples: {} };
            for (var i = 0; i < o.ids.length; i++) {
                var L = findLayer(comp, o.ids[i], -1);
                if (!L) continue;
                var xs = [], ys = [], rs = [];
                for (var f = 0; f < o.count; f++) {
                    var t = o.start + f / o.fps;
                    var p = worldAnchorPos(L, t);
                    xs.push(r4(p[0])); ys.push(r4(p[1])); rs.push(r4(worldRot(L, t)));
                }
                out.samples[o.ids[i]] = { x: xs, y: ys, r: rs };
            }
            return J.stringify(out);
        } catch (e) { return "ERR: " + e; }
    }

    // ---------- bake ----------
    function clearKeys(prop, t0, t1) {
        for (var k = prop.numKeys; k >= 1; k--) {
            var kt = prop.keyTime(k);
            if (kt >= t0 && kt <= t1) prop.removeKey(k);
        }
    }
    function linearize(prop, t0, t1, spatial) {
        for (var k = 1; k <= prop.numKeys; k++) {
            var kt = prop.keyTime(k);
            if (kt < t0 || kt > t1) continue;
            try { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); } catch (e1) { }
            if (spatial) {
                try {
                    prop.setSpatialAutoBezierAtKey(k, false);
                    prop.setSpatialContinuousAtKey(k, false);
                    prop.setSpatialTangentsAtKey(k, [0, 0], [0, 0]);
                } catch (e2) { }
            }
        }
    }
    function muteExpression(prop) {
        try { if (prop.canSetExpression && prop.expression && prop.expression.length) prop.expressionEnabled = false; } catch (e) { }
    }
    function writeKeys(prop, times, values, t0, t1, o, spatial) {
        muteExpression(prop);
        if (o.clearRange !== false) clearKeys(prop, t0, t1);
        prop.setValuesAtTimes(times, values);
        if (o.linear !== false) linearize(prop, t0, t1, spatial);
    }
    function bakeObj(o) {
        var comp = activeComp();
        if (!comp) return "ERR: Open a composition first.";
        var fps = o.fps, start = o.start, step = Math.max(1, Math.round(o.step || 1));
        var baked = 0, keys = 0, errs = [];
        app.beginUndoGroup("AE Physics: Bake");
        try {
            for (var b = 0; b < o.bodies.length; b++) {
                var body = o.bodies[b];
                var L = findLayer(comp, body.id, body.index);
                if (!L) { errs.push("layer not found: " + body.name); continue; }
                try {
                    var n = body.x.length, f;
                    var times = [], pvals = [], xs = [], ys = [], rvals = [];
                    for (f = 0; f < n; f += step) {
                        times.push(start + f / fps);
                        pvals.push([body.x[f], body.y[f]]); xs.push(body.x[f]); ys.push(body.y[f]);
                        rvals.push(body.r[f]);
                    }
                    if ((n - 1) % step !== 0) {
                        f = n - 1;
                        times.push(start + f / fps);
                        pvals.push([body.x[f], body.y[f]]); xs.push(body.x[f]); ys.push(body.y[f]);
                        rvals.push(body.r[f]);
                    }
                    var t0 = times[0] - 0.5 / fps, t1 = times[times.length - 1] + 0.5 / fps;
                    if (o.unparent !== false && L.parent) L.parent = null;
                    var g = xg(L);
                    var pos = g.property("ADBE Position");
                    if (pos.dimensionsSeparated) {
                        writeKeys(g.property("ADBE Position_0"), times, xs, t0, t1, o, false);
                        writeKeys(g.property("ADBE Position_1"), times, ys, t0, t1, o, false);
                    } else {
                        writeKeys(pos, times, pvals, t0, t1, o, true);
                    }
                    keys += times.length;
                    if (o.bakeRotation !== false) {
                        var rot = g.property("ADBE Rotate Z");
                        if (rot) { writeKeys(rot, times, rvals, t0, t1, o, false); keys += times.length; }
                    }
                    baked++;
                } catch (eL) { errs.push(L.name + ": " + eL); }
            }
        } catch (e) { errs.push(String(e)); }
        app.endUndoGroup();
        var msg = "OK: Baked " + baked + " layer(s), " + keys + " keyframes.";
        if (errs.length) msg += " Issues: " + errs.join(" | ");
        return msg;
    }
    function bake(json) {
        try { return bakeObj(J.parse(json)); } catch (e) { return "ERR: " + e; }
    }
    function tempPath() {
        try {
            var dir = new Folder(Folder.temp.fsName + "/ae-physics");
            if (!dir.exists) dir.create();
            return dir.fsName + "/bake.json";
        } catch (e) { return "ERR: " + e; }
    }
    function bakeFromFile(json) {
        try {
            var path = J.parse(json);
            var f = new File(path);
            if (!f.exists) return "ERR: bake file missing: " + path;
            f.encoding = "UTF-8";
            f.open("r");
            var txt = f.read();
            f.close();
            return bakeObj(J.parse(txt));
        } catch (e) { return "ERR: " + e; }
    }

    function selectLayer(json) {
        try {
            var o = J.parse(json);
            var comp = activeComp();
            if (!comp) return "ERR: no comp";
            for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
            var L = findLayer(comp, o.id, o.index);
            if (L) L.selected = true;
            return "OK";
        } catch (e) { return "ERR: " + e; }
    }
    function setTime(json) {
        try {
            var t = J.parse(json);
            var comp = activeComp();
            if (comp) comp.time = t;
            return "OK";
        } catch (e) { return "ERR: " + e; }
    }
    function ping() { return "PHY " + VERSION; }

    return {
        version: VERSION,
        ping: ping,
        getScene: getScene,
        sampleTransforms: sampleTransforms,
        bake: bake,
        bakeFromFile: bakeFromFile,
        tempPath: tempPath,
        selectLayer: selectLayer,
        setTime: setTime
    };
})();
