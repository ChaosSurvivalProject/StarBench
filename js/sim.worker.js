/* StarBench Web — 模拟 Worker（CPU 模拟与渲染解耦）
 *
 * 职责：持有 VoxelWorld，执行世界生成/光照/NBT/七个 tick 模块；主线程只做
 * WebGL 渲染与逐帧 frameTimeMs 采集。两边通过消息通信，工作量在 Worker 线程真实发生。
 *
 * 消息协议（主线程 → Worker）：
 *   {type:'build', id, chunks, height, seed, mobCap, viewDist, simDist}
 *   {type:'tick',  id, dtSec, intensity, modules}   // 一个模拟 tick
 *   {type:'reset'}
 * Worker → 主线程：
 *   {type:'built', id, vertexCount, tile, entityCount, genMs, nbt}
 *   {type:'ticked', id, tickMs, work, stats}        // stats = moduleStats()
 * 网格数据通过 transferable Float32Array 发送（避免结构化克隆开销）。
 */
"use strict";

let SB = (typeof self !== "undefined" ? self : globalThis).SB;
// importScripts 在 module worker 之外可用；若环境无 SB 则尝试加载
if (!SB && typeof importScripts === "function") {
  importScripts("voxel.js");
  SB = self.SB;
}
if (!SB || !SB.VoxelWorld) throw new Error("sim.worker: 无法加载 voxel.js");

let world = null;
let lastMesh = null;

function postMesh() {
  if (!world || !world.mesh) return;
  const m = world.mesh;
  // 复制以避免转移后丢失 world.mesh（渲染只需一份）
  const position = m.position.slice();
  const uv = m.uv.slice();
  const light = m.light.slice();
  self.postMessage(
    { type: "mesh", vertexCount: m.vertexCount, position, uv, light },
    [position.buffer, uv.buffer, light.buffer]
  );
}

self.onmessage = (ev) => {
  const d = ev.data || {};
  try {
    switch (d.type) {
      case "build": {
        const t0 = performance.now();
        world = new SB.VoxelWorld(d.chunks, d.height, d.seed | 0, d.mobCap | 0, d.viewDist | 0, d.simDist | 0);
        world.regenerate();
        const genMs = performance.now() - t0;
        const nbt = world.nbtRoundTrip();
        world.buildMesh();
        // 估算地表平均高度供相机机位使用（确定性采样）
        let sum = 0, c = 0;
        for (let i = 0; i < world.heightmap.length; i += 37) { sum += world.heightmap[i]; c++; }
        const groundY = c ? sum / c : world.h * 0.3;
        self.postMessage({
          type: "built", id: d.id, vertexCount: world.mesh.vertexCount,
          entityCount: world.entities.length, genMs, nbt,
          sx: world.sx, sz: world.sz, h: world.h, groundY,
        });
        postMesh();
        break;
      }
      case "tick": {
        if (!world) { self.postMessage({ type: "ticked", id: d.id, tickMs: 0, work: 0 }); break; }
        const r = world.stepTick(d.dtSec || 0.05, d.intensity || {}, d.modules || null);
        self.postMessage({
          type: "ticked", id: d.id, tickMs: r.ms, work: r.work, stats: world.moduleStats(),
          entities: world.entitySnapshot(),
        });
        break;
      }
      case "remesh": {
        if (!world) break;
        world.buildMesh();
        postMesh();
        break;
      }
      case "reset": {
        world = null; lastMesh = null;
        self.postMessage({ type: "reset" });
        break;
      }
    }
  } catch (err) {
    self.postMessage({ type: "error", id: d.id, message: String(err && err.message || err) });
  }
};
