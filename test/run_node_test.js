// Node harness: scene.json (from PHY.getScene) -> frames / bake payload, without the panel.
// usage: node test/run_node_test.js scene.json [config.json] [out_bake.json]
const fs = require('fs');
const path = require('path');
const SIM = require('../client/sim.js');

const [, , scenePath, cfgPath, outPath] = process.argv;
if (!scenePath) { console.error('usage: node run_node_test.js scene.json [config.json] [out.json]'); process.exit(1); }
const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
const cfg = cfgPath && fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};

const fps = scene.comp.fps;
const start = cfg.start !== undefined ? cfg.start : scene.comp.workAreaStart;
const count = cfg.count || Math.round(scene.comp.workAreaDuration * fps);
const bodies = {};
for (const info of scene.layers) {
  bodies[info.id] = Object.assign(SIM.defaultBody(info), (cfg.bodies && (cfg.bodies[info.id] || cfg.bodies[info.name])) || {});
}
const world = Object.assign(SIM.defaultWorld(), cfg.world || {});
const t0 = Date.now();
const res = SIM.run(scene, { world, start, count, fps, bodies, kinematic: cfg.kinematic || {} });
console.log(`simulated ${res.count} frames, ${res.bodyCount} bodies in ${Date.now() - t0} ms`);
for (const b of res.bodies) {
  const last = res.count - 1;
  console.log(`  ${b.name.padEnd(24)} ${b.type.padEnd(9)} fixtures=${b.geom.fixtures.length} (${b.geom.mode})  ` +
    `start=(${b.x[0].toFixed(1)}, ${b.y[0].toFixed(1)}, ${b.r[0].toFixed(1)}°)  end=(${b.x[last].toFixed(1)}, ${b.y[last].toFixed(1)}, ${b.r[last].toFixed(1)}°)`);
}
if (outPath) {
  const r3 = a => a.map(v => Math.round(v * 1000) / 1000);
  const payload = {
    start, fps, count, step: 1, unparent: true, clearRange: true, linear: true, bakeRotation: true,
    bodies: res.bodies.filter(b => b.type === 'dynamic' || b.type === 'dormant')
      .map(b => ({ id: b.id, index: b.index, name: b.name, x: r3(b.x), y: r3(b.y), r: r3(b.r) }))
  };
  fs.writeFileSync(outPath, JSON.stringify(payload));
  console.log('bake payload written:', path.resolve(outPath), `(${payload.bodies.length} bodies)`);
}
