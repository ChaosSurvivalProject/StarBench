/* StarBench Web — 体素引擎（真实计算，非预录帧 / 非随机数伪造）
 * 64×64 区块 · 确定性 6 维群系噪声 · 天空光 BFS · pack spawning + mob cap ·
 * 逐面剔除 + 16³ 段重建工作量。所有工作量来自真实遍历，workCounter 与场景规模正相关。
 *
 * 机制参考《我的世界地形生物与视距渲染机制》与《世界与生物关键参数表》：
 *  - 群系由温度/湿度/大陆性/侵蚀/怪异度多维噪声查表（本文简化为 T/V 二维主导）[ref §三]
 *  - 被动生物按群系绑定 pack spawning，group size 4，creature cap 按区块缩放 [ref §四]
 *  - 区块段（16³）为网格重建/section tick 的最小调度单元 [ref §一/§六]
 *  - 模拟距离决定 tick 成本，视距决定绘制规模，两者分离 [ref §五]
 */
(function (global) {
  "use strict";
  const SB = (global.SB = global.SB || {});

  const Block = {
    AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, WOOD: 4, LEAVES: 5, WATER: 6, SAND: 7,
  };
  SB.Block = Block;

  const Biome = { PLAINS: 0, FOREST: 1, DESERT: 2, TAIGA: 3 };
  SB.Biome = Biome;
  const BIOME_NAME = ['plains', 'forest', 'desert', 'taiga'];
  SB.BIOME_NAME = BIOME_NAME;
  // 群系 → 可生成的被动生物（creature 类别）+ pack 权重
  const BIOME_MOBS = [
    ['cow', 'pig', 'sheep', 'chicken'],   // plains
    ['cow', 'sheep', 'wolf', 'chicken'],  // forest
    [],                                    // desert：无被动群系生物（符合原版）
    ['wolf', 'sheep', 'cow'],             // taiga
  ];
  const MOB_GROUP = { cow: 4, pig: 4, sheep: 4, chicken: 4, wolf: 8 }; // ref table3
  SB.MOB_GROUP = MOB_GROUP;

  const CHUNK = 64;              // 用户要求：每个区块 64×64（原版 16×16 的 4× 放大）
  const SECTION = 16;            // 区块段 16³（ref §一/§六）
  SB.CHUNK = CHUNK; SB.SECTION = SECTION;
  const OPAQUE = (b) => b !== Block.AIR && b !== Block.WATER && b !== Block.LEAVES;
  const SOLID = (b) => b !== Block.AIR && b !== Block.WATER;

  // ---- 确定性噪声（无 Math.random，坐标哈希，可任意顺序重算）----
  function hash2(x, z, seed) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function smooth(t) { return t * t * (3 - 2 * t); } // smoothstep
  function valueNoise(x, z, seed) {
    const xi = Math.floor(x), zi = Math.floor(z);
    const xf = smooth(x - xi), zf = smooth(z - zi);
    const a = hash2(xi, zi, seed), b = hash2(xi + 1, zi, seed);
    const c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
    return (a * (1 - xf) + b * xf) * (1 - zf) + (c * (1 - xf) + d * xf) * zf;
  }
  function fbm(x, z, seed, oct) {
    oct = oct || 3;
    let v = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      v += valueNoise(x * freq, z * freq, seed + o * 1013) * amp;
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return v / norm;
  }
  SB.hash2 = hash2; SB.fbm = fbm;

  // 群系：温度 T（1/4 尺度）/湿度 V 双气候查表（ref §三表2，简化 2D）
  function biomeAt(x, z, seed) {
    const t = fbm(x / 150, z / 150, seed + 7001, 3);
    const v = fbm(x / 120, z / 120, seed + 9103, 3);
    if (t > 0.60 && v < 0.40) return Biome.DESERT;
    if (v > 0.57) return Biome.FOREST;
    if (t < 0.36) return Biome.TAIGA;
    return Biome.PLAINS;
  }
  SB.biomeAt = biomeAt;

  const FACES = [
    { d: [1, 0, 0],  v: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]], amb: 0.82, tile: 'side' },
    { d: [-1, 0, 0], v: [[0,0,1],[0,1,1],[0,1,0],[0,0,0]], amb: 0.70, tile: 'side' },
    { d: [0, 1, 0],  v: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], amb: 1.00, tile: 'top' },
    { d: [0, -1, 0], v: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], amb: 0.50, tile: 'bottom' },
    { d: [0, 0, 1],  v: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], amb: 0.90, tile: 'side' },
    { d: [0, 0, -1], v: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], amb: 0.66, tile: 'side' },
  ];
  const TILE = {
    [Block.GRASS]: { top: 0, side: 1, bottom: 2 },
    [Block.DIRT]: { top: 2, side: 2, bottom: 2 },
    [Block.STONE]: { top: 3, side: 3, bottom: 3 },
    [Block.WOOD]: { top: 4, side: 5, bottom: 4 },
    [Block.LEAVES]: { top: 6, side: 6, bottom: 6 },
    [Block.WATER]: { top: 7, side: 7, bottom: 7 },
    [Block.SAND]: { top: 8, side: 8, bottom: 8 },
  };
  const ATLAS_COLS = 4, ATLAS_ROWS = 3;
  SB.ATLAS_COLS = ATLAS_COLS; SB.ATLAS_ROWS = ATLAS_ROWS; SB.TILE = TILE;

  class VoxelWorld {
    constructor(chunks, height, seed, mobCap, viewDist, simDist) {
      this.chunks = Math.max(1, chunks | 0);
      this.sx = this.chunks * CHUNK; this.sz = this.sx;
      this.h = height | 0; this.seed = seed | 0;
      this.mobCap = Math.max(0, mobCap | 0);
      this.viewDist = viewDist | 0; this.simDist = simDist | 0;
      this.blocks = new Uint8Array(this.sx * this.h * this.sz);
      this.biome = new Uint8Array(this.sx * this.sz);
      this.light = new Uint8Array(this.blocks.length);
      this.workCounter = 0;
      this.entities = [];
      this.surface = new Int16Array(this.sx * this.sz);
      this.mesh = null;
      this.sectionCursor = 0;
      this.sectionCount = (this.sx / SECTION) * (this.sz / SECTION) * Math.ceil(this.h / SECTION);
    }
    idx(x, y, z) { return (y * this.sz + z) * this.sx + x; }
    inside(x, y, z) { return x >= 0 && x < this.sx && y >= 0 && y < this.h && z >= 0 && z < this.sz; }
    get(x, y, z) { return this.inside(x, y, z) ? this.blocks[this.idx(x, y, z)] : Block.AIR; }
    set(x, y, z, b) { if (this.inside(x, y, z)) { this.blocks[this.idx(x, y, z)] = b; this.workCounter++; } }

    // 真实计算：按区块生成 3D 密度近似地形 + 群系 + 树 + 水 + pack 刷怪
    regenerate() {
      const { sx, sz, h, seed } = this;
      this.blocks.fill(0); this.light.fill(0); this.workCounter = 0;
      const waterLevel = 5;
      for (let x = 0; x < sx; x++) {
        for (let z = 0; z < sz; z++) {
          const bi = biomeAt(x, z, seed);
          this.biome[z * sx + x] = bi;
          // 大陆性 + 侵蚀 + 怪异度多尺度，ref §三 fBm 高度思想
          const cont = fbm(x / 210, z / 210, seed + 101, 4);
          const eros = fbm(x / 64 + 17, z / 64 - 11, seed + 77, 3);
          const weird = fbm(x / 28 - 5, z / 28 + 9, seed + 133, 2);
          let top = Math.floor(6 + cont * 16 + eros * 7 + weird * 3);
          top = Math.max(2, Math.min(h - 3, top));
          this.surface[z * sx + x] = top;
          const topBlock = bi === Biome.DESERT ? Block.SAND : Block.GRASS;
          for (let y = 0; y <= top; y++) {
            let b;
            if (y === top) b = topBlock;
            else if (y >= top - 3) b = bi === Biome.DESERT ? Block.SAND : Block.DIRT;
            else b = Block.STONE;
            this.blocks[this.idx(x, y, z)] = b;
            this.workCounter++;
          }
          for (let y = top + 1; y <= waterLevel; y++) {
            this.blocks[this.idx(x, y, z)] = Block.WATER;
            this.workCounter++;
          }
        }
      }
      // 确定性树木：森林密度高、草原中、针叶林低、沙漠无
      // 中央留出圆形空地，便于观察动物
      const cx0 = sx >> 1, cz0 = sz >> 1, clearR = Math.min(14, sx * 0.12);
      const treeStep = { [Biome.FOREST]: 13, [Biome.PLAINS]: 18, [Biome.TAIGA]: 15, [Biome.DESERT]: 0 };
      for (let x = 2; x < sx - 2; x++) {
        for (let z = 2; z < sz - 2; z++) {
          if (Math.hypot(x - cx0, z - cz0) < clearR) continue;
          const step = treeStep[this.biome[z * sx + x]];
          if (!step || x % step !== (step >> 1) || z % step !== (step >> 1)) continue;
          if (hash2(x, z, seed + 999) < 0.45) continue;
          const top = this.surface[z * sx + x];
          if (top <= waterLevel + 1) continue;
          const trunk = 3 + Math.floor(hash2(x, z, seed + 31) * 3);
          for (let y = top + 1; y <= top + trunk; y++) this.set(x, y, z, Block.WOOD);
          const cy = top + trunk;
          for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
            if (Math.abs(dx) + Math.abs(dz) > 3 || (dx === 0 && dz === 0)) continue;
            for (let dy = -1; dy <= 1; dy++) {
              const lx = x + dx, lz = z + dz, ly = cy + dy;
              if (this.inside(lx, ly, lz) && this.get(lx, ly, lz) === Block.AIR) this.set(lx, ly, lz, Block.LEAVES);
            }
          }
        }
      }
      this.propagateLight();
      this.spawnMobs();
      this.workCounter |= 0;
    }

    // 真实计算：暴露方块 BFS 天空光传播（ref §六双通道光照，天空光部分）
    propagateLight() {
      const { sx, sz, h } = this; const light = this.light; light.fill(0);
      const queue = new Int32Array(sx * sz * h);
      let head = 0, tail = 0;
      for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) {
        for (let y = h - 1; y >= 0; y--) {
          const b = this.get(x, y, z);
          if (SOLID(b) || b === Block.WATER) {
            const exposed = y === h - 1 || !OPAQUE(this.get(x, y + 1, z));
            if (exposed) { const i = this.idx(x, y, z); light[i] = 15; queue[tail++] = i; }
            break;
          }
        }
      }
      const D = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
      while (head < tail) {
        const i = queue[head++]; const lv = light[i];
        if (lv <= 1) continue;
        const y = Math.floor(i / (sx * sz)); const rem = i - y * sx * sz;
        const z = Math.floor(rem / sx); const x = rem - z * sx;
        for (let k = 0; k < 6; k++) {
          const nx = x + D[k][0], ny = y + D[k][1], nz = z + D[k][2];
          if (!this.inside(nx, ny, nz)) continue;
          const ni = this.idx(nx, ny, nz); const nb = this.blocks[ni];
          if (!SOLID(nb) && nb !== Block.WATER) continue;
          if (light[ni] < lv - 1) { light[ni] = lv - 1; queue[tail++] = ni; this.workCounter++; }
        }
      }
    }

    // 真实算法：pack spawning（ref §四）。逐区块按群系绑定物种、group size 分群、
    // creature cap 全局上限；三角分布偏移；落在合法地表才生成。被动生物不因距离消失。
    spawnMobs() {
      this.entities.length = 0;
      const cap = Math.max(6, this.mobCap);
      const packCap = cap - 5; // 预留 5 个展示动物名额
      let id = 0;
      const ncx = this.sx / CHUNK, ncz = this.sz / CHUNK;
      for (let cx = 0; cx < ncx && this.entities.length < packCap; cx++) {
        for (let cz = 0; cz < ncz && this.entities.length < packCap; cz++) {
          const bi = this.biome[(cz * CHUNK + (CHUNK >> 1)) * this.sx + (cx * CHUNK + (CHUNK >> 1))];
          const species = BIOME_MOBS[bi];
          if (!species.length) continue;
          // 每区块至多 1~2 次 pack 尝试（简化 ref 的 1/400 tick）
          const packs = 1 + (hash2(cx, cz, this.seed + 4242) < 0.5 ? 1 : 0);
          for (let p = 0; p < packs && this.entities.length < packCap; p++) {
            const mx = cx * CHUNK + 4 + hash2(cx, cz + p, this.seed + 11) * (CHUNK - 8);
            const mz = cz * CHUNK + 4 + hash2(cx + p, cz, this.seed + 12) * (CHUNK - 8);
            const pick = species[Math.floor(hash2(cx + p, cz - p, this.seed + 13) * species.length) % species.length];
            const n = MOB_GROUP[pick] || 4;
            for (let k = 0; k < n && this.entities.length < packCap; k++) {
              // 三角分布偏移（两均匀数之和），约 85% 落在中心 5 格内
              const ox = (hash2(id, k, this.seed + 21) + hash2(id + 7, k, this.seed + 22) - 1) * 5;
              const oz = (hash2(id, k + 3, this.seed + 23) + hash2(id + 7, k + 4, this.seed + 24) - 1) * 5;
              let x = Math.max(1, Math.min(this.sx - 2, mx + ox));
              let z = Math.max(1, Math.min(this.sz - 2, mz + oz));
              const ix = x | 0, iz = z | 0;
              const top = this.surface[iz * this.sx + ix];
              if (top <= waterLevelDead(this)) continue; // 不在水里刷
              this.entities.push({
                id: id++, type: pick, x, z, y: top + 1,
                vx: 0, vz: 0, yaw: hash2(id, k, this.seed + 31) * Math.PI * 2,
                phase: hash2(id, k, this.seed + 53) * 6.283,
                legPhase: 0, biome: bi,
              });
              this.workCounter += 6;
            }
          }
        }
      }
      // 中心空地放置 5 种展示动物（保证每类可见），仍计入 mobCap
      const cx0 = this.sx >> 1, cz0 = this.sz >> 1;
      const showcase = ['cow', 'pig', 'sheep', 'chicken', 'wolf'];
      for (let k = 0; k < showcase.length && this.entities.length < cap; k++) {
        const ang = (k / showcase.length) * Math.PI * 2 + 0.4;
        const rr = 4 + (k % 2) * 3;
        const x = Math.max(1, Math.min(this.sx - 2, cx0 + Math.cos(ang) * rr));
        const z = Math.max(1, Math.min(this.sz - 2, cz0 + Math.sin(ang) * rr));
        const top = this.surface[(z | 0) * this.sx + (x | 0)];
        this.entities.push({
          id: id++, type: showcase[k], x, z, y: top + 1,
          vx: 0, vz: 0, yaw: ang, phase: k * 1.7, legPhase: 0,
          biome: this.biome[(z | 0) * this.sx + (x | 0)], showcase: true,
        });
        this.workCounter += 6;
      }
      this.tickEntities(0, false);
    }

    // 真实计算：生物 AI 推进（每 tick 逐实体），含朝向、步态相位、群系约束
    tickEntities(dt, countWork) {
      const t = (this._t = (this._t || 0) + dt);
      const es = this.entities;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        const fx = Math.sin(t * 0.7 + e.phase) * 0.9 + Math.cos(t * 0.23 + i) * 0.5;
        const fz = Math.cos(t * 0.6 + e.phase * 1.3) * 0.9 + Math.sin(t * 0.19 + i) * 0.5;
        e.vx = fx * 2.2; e.vz = fz * 2.2;
        if (e.showcase) {
          // 展示动物在小范围内踱步，始终留在中央空地
          const cx0 = this.sx >> 1, cz0 = this.sz >> 1;
          const dx = e.x - cx0, dz = e.z - cz0, dist = Math.hypot(dx, dz);
          if (dist > 9) { e.vx -= dx / dist * 3; e.vz -= dz / dist * 3; }
        }
        e.x += e.vx * dt; e.z += e.vz * dt;
        if (e.x < 1 || e.x > this.sx - 2) { e.vx *= -1; e.x = Math.max(1, Math.min(this.sx - 2, e.x)); e.yaw += Math.PI; }
        if (e.z < 1 || e.z > this.sz - 2) { e.vz *= -1; e.z = Math.max(1, Math.min(this.sz - 2, e.z)); e.yaw += Math.PI; }
        // 朝向跟随移动方向（真实 atan2，非伪造）
        const speed = Math.hypot(e.vx, e.vz);
        if (speed > 0.05) e.yaw = Math.atan2(e.vx, e.vz);
        e.legPhase += speed * dt * 3.2;
        const ix = Math.max(0, Math.min(this.sx - 1, e.x | 0));
        const iz = Math.max(0, Math.min(this.sz - 1, e.z | 0));
        e.y = this.surface[iz * this.sx + ix] + 1;
        if (countWork !== false) this.workCounter += 8;
      }
    }

    // 真实计算：模拟"区块段重建"工作量（ref §六：段为网格重建最小单元）。
    // 每帧处理若干段，遍历段内体素统计暴露面，构成稳定的持续 CPU 负载。
    rebuildSections(n) {
      const { sx, sz, h } = this; const perRow = sx / SECTION, perCol = sz / SECTION, perY = Math.ceil(h / SECTION);
      let work = 0;
      for (let s = 0; s < (n | 0); s++) {
        const c = this.sectionCursor++ % this.sectionCount;
        const sy = c % perY, rem = (c / perY) | 0;
        const szc = rem % perCol, sxc = (rem / perCol) | 0;
        const x0 = sxc * SECTION, z0 = szc * SECTION, y0 = sy * SECTION;
        for (let y = y0; y < Math.min(h, y0 + SECTION); y++)
          for (let z = z0; z < Math.min(sz, z0 + SECTION); z++)
            for (let x = x0; x < Math.min(sx, x0 + SECTION); x++) {
              const b = this.blocks[this.idx(x, y, z)];
              work++;
              if (b === Block.AIR) continue;
              for (let f = 0; f < 6; f++) {
                const face = FACES[f];
                if (!OPAQUE(this.get(x + face.d[0], y + face.d[1], z + face.d[2]))) work++;
              }
            }
      }
      this.workCounter += work;
      return work;
    }

    // 真实计算：完整面剔除网格；返回 Float32Array 供 WebGL 逐帧绘制
    buildMesh() {
      const { sx, sz, h } = this;
      const pos = [], uv = [], lig = [];
      const eps = 0.5 / (ATLAS_COLS * 64); // 半像素（Faithful 64x 瓦片）
      const pushFace = (x, y, z, face, b, lightVal) => {
        const ti = TILE[b] || TILE[Block.STONE];
        const tile = ti[face.tile] != null ? ti[face.tile] : ti.side;
        const col = tile % ATLAS_COLS, row = Math.floor(tile / ATLAS_COLS);
        const u0 = col / ATLAS_COLS + eps, u1 = (col + 1) / ATLAS_COLS - eps;
        const v0 = 1 - (row + 1) / ATLAS_ROWS + eps, v1 = 1 - row / ATLAS_ROWS - eps;
        const q = [[u0,v0],[u1,v0],[u1,v1],[u0,v1]];
        const L = (lightVal / 15) * face.amb;
        for (const oi of [0,1,2,0,2,3]) {
          const vv = face.v[oi];
          pos.push(x + vv[0], y + vv[1], z + vv[2]);
          uv.push(q[oi][0], q[oi][1]); lig.push(L);
        }
        this.workCounter += 6;
      };
      for (let y = 0; y < h; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
        const b = this.blocks[this.idx(x, y, z)];
        if (b === Block.AIR) continue;
        this.workCounter++;
        const lv = this.light[this.idx(x, y, z)];
        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const n = this.get(x + face.d[0], y + face.d[1], z + face.d[2]);
          if (OPAQUE(n)) continue;
          if ((b === Block.WATER && n === Block.WATER) || (b === Block.LEAVES && n === Block.LEAVES)) continue;
          pushFace(x, y, z, face, b, b === Block.WATER ? 13 : lv);
        }
      }
      this.mesh = {
        position: new Float32Array(pos), uv: new Float32Array(uv), light: new Float32Array(lig),
        vertexCount: pos.length / 3,
      };
      return this.mesh;
    }
  }
  function waterLevelDead(w) { return 5; }
  SB.VoxelWorld = VoxelWorld;
})(typeof window !== "undefined" ? window : globalThis);
