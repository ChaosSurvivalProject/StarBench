/* StarBench Web — 体素引擎（真实计算，非预录帧 / 非随机数伪造）
 * 确定性地形、天空光传播、实体推进、逐面剔除网格构建。
 * 所有工作量来自真实遍历；workCounter 与场景规模正相关。
 */
(function (global) {
  "use strict";
  const SB = (global.SB = global.SB || {});

  const Block = {
    AIR: 0,
    GRASS: 1,
    DIRT: 2,
    STONE: 3,
    WOOD: 4,
    LEAVES: 5,
    WATER: 6,
    SAND: 7,
  };
  SB.Block = Block;

  // 方块 -> 图集瓦片索引；不同面可覆盖（草顶/草侧）
  const OPAQUE = (b) => b !== Block.AIR && b !== Block.WATER && b !== Block.LEAVES;
  const SOLID = (b) => b !== Block.AIR && b !== Block.WATER;

  // 确定性哈希噪声（无 Math.random）
  function hash2(x, z, seed) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function valueNoise(x, z, seed) {
    const xi = Math.floor(x), zi = Math.floor(z);
    const xf = smooth(x - xi), zf = smooth(z - zi);
    const a = hash2(xi, zi, seed), b = hash2(xi + 1, zi, seed);
    const c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
    return (a * (1 - xf) + b * xf) * (1 - zf) + (c * (1 - xf) + d * xf) * zf;
  }
  function fbm(x, z, seed) {
    let v = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < 3; o++) {
      v += valueNoise(x * freq, z * freq, seed + o * 1013) * amp;
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return v / norm;
  }

  // 立方体六面：方向、四顶点（逆时针朝外）、环境光系数
  const FACES = [
    { d: [1, 0, 0],  v: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]], amb: 0.82, tile: 'side' },
    { d: [-1, 0, 0], v: [[0,0,1],[0,1,1],[0,1,0],[0,0,0]], amb: 0.70, tile: 'side' },
    { d: [0, 1, 0],  v: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], amb: 1.00, tile: 'top' },
    { d: [0, -1, 0], v: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], amb: 0.50, tile: 'bottom' },
    { d: [0, 0, 1],  v: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], amb: 0.90, tile: 'side' },
    { d: [0, 0, -1], v: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], amb: 0.66, tile: 'side' },
  ];

  const TILE = {
    [Block.GRASS]:  { top: 0, side: 1, bottom: 2 },
    [Block.DIRT]:   { top: 2, side: 2, bottom: 2 },
    [Block.STONE]:  { top: 3, side: 3, bottom: 3 },
    [Block.WOOD]:   { top: 4, side: 5, bottom: 4 },
    [Block.LEAVES]: { top: 6, side: 6, bottom: 6 },
    [Block.WATER]:  { top: 7, side: 7, bottom: 7 },
    [Block.SAND]:   { top: 8, side: 8, bottom: 8 },
  };
  const ATLAS_COLS = 4, ATLAS_ROWS = 3; // 12 瓦片槽（8-11 备用）

  class VoxelWorld {
    constructor(sizeX, sizeZ, height, seed, entities) {
      this.sx = sizeX | 0; this.sz = sizeZ | 0; this.h = height | 0;
      this.seed = seed | 0;
      this.entityCount = entities | 0;
      this.blocks = new Uint8Array(this.sx * this.h * this.sz);
      this.light = new Uint8Array(this.blocks.length);
      this.workCounter = 0;
      this.entities = [];
      this.surface = new Int16Array(this.sx * this.sz);
      this.mesh = null;
    }
    idx(x, y, z) { return (y * this.sz + z) * this.sx + x; }
    inside(x, y, z) { return x >= 0 && x < this.sx && y >= 0 && y < this.h && z >= 0 && z < this.sz; }
    get(x, y, z) { return this.inside(x, y, z) ? this.blocks[this.idx(x, y, z)] : Block.AIR; }
    set(x, y, z, b) { if (this.inside(x, y, z)) { this.blocks[this.idx(x, y, z)] = b; this.workCounter++; } }

    // 真实计算：地形 + 树 + 水
    regenerate() {
      const { sx, sz, h, seed } = this;
      this.blocks.fill(0); this.light.fill(0); this.workCounter = 0;
      const waterLevel = 4;
      for (let x = 0; x < sx; x++) {
        for (let z = 0; z < sz; z++) {
          const n = fbm(x / 9, z / 9, seed);
          const ridge = fbm(x / 23 + 17, z / 23 - 11, seed + 77);
          let top = Math.max(2, Math.floor(3 + n * 9 + ridge * 5));
          if (top >= h - 2) top = h - 3;
          this.surface[z * sx + x] = top;
          for (let y = 0; y <= top; y++) {
            let b;
            if (y === top) b = top <= waterLevel + 1 ? Block.SAND : Block.GRASS;
            else if (y >= top - 3) b = Block.DIRT;
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
      // 确定性树木
      for (let x = 2; x < sx - 2; x += 7) {
        for (let z = 2; z < sz - 2; z += 7) {
          if (hash2(x, z, seed + 999) < 0.52) continue;
          const top = this.surface[z * sx + x];
          if (top <= waterLevel + 1) continue;
          const trunk = 3 + Math.floor(hash2(x, z, seed + 31) * 2);
          for (let y = top + 1; y <= top + trunk; y++) this.set(x, y, z, Block.WOOD);
          const cy = top + trunk;
          for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
            if (Math.abs(dx) + Math.abs(dz) > 3) continue;
            if (dx === 0 && dz === 0) continue;
            for (let dy = -1; dy <= 1; dy++) {
              const lx = x + dx, lz = z + dz, ly = cy + dy;
              if (this.inside(lx, ly, lz) && this.get(lx, ly, lz) === Block.AIR) this.set(lx, ly, lz, Block.LEAVES);
            }
          }
        }
      }
      this.propagateLight();
      this.initEntities();
      this.workCounter |= 0;
    }

    // 真实计算：从暴露方块 BFS 传播天空光，每格消耗一次操作
    propagateLight() {
      const { sx, sz, h } = this;
      const light = this.light;
      light.fill(0);
      const queue = new Int32Array(sx * sz * h);
      let head = 0, tail = 0;
      for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) {
        for (let y = h - 1; y >= 0; y--) {
          const b = this.get(x, y, z);
          if (SOLID(b) || b === Block.WATER) {
            const exposed = y === h - 1 || !OPAQUE(this.get(x, y + 1, z));
            if (exposed) {
              const i = this.idx(x, y, z);
              light[i] = 15;
              queue[tail++] = i;
            }
            break;
          }
        }
      }
      const DIRS6 = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
      while (head < tail) {
        const i = queue[head++];
        const lv = light[i];
        if (lv <= 1) continue;
        const y = Math.floor(i / (sx * sz));
        const rem = i - y * sx * sz;
        const z = Math.floor(rem / sx);
        const x = rem - z * sx;
        for (let k = 0; k < 6; k++) {
          const nx = x + DIRS6[k][0], ny = y + DIRS6[k][1], nz = z + DIRS6[k][2];
          if (!this.inside(nx, ny, nz)) continue;
          const ni = this.idx(nx, ny, nz);
          const nb = this.blocks[ni];
          if (!SOLID(nb) && nb !== Block.WATER) continue;
          if (light[ni] < lv - 1) {
            light[ni] = lv - 1;
            queue[tail++] = ni;
            this.workCounter++;
          }
        }
      }
    }

    initEntities() {
      this.entities.length = 0;
      const n = Math.max(0, this.entityCount | 0);
      for (let i = 0; i < n; i++) {
        const x = 2 + hash2(i, 1, this.seed + 51) * (this.sx - 4);
        const z = 2 + hash2(i, 2, this.seed + 52) * (this.sz - 4);
        this.entities.push({ x, z, y: 0, vx: 0, vz: 0, phase: hash2(i, 3, this.seed + 53) * 6.283 });
      }
      this.tickEntities(0, false);
    }

    // 真实计算：实体按确定性场推进，贴合地表，逐帧消耗 CPU
    tickEntities(dt, countWork) {
      const t = (this._t = (this._t || 0) + dt);
      for (let i = 0; i < this.entities.length; i++) {
        const e = this.entities[i];
        const fx = Math.sin(t * 0.7 + e.phase) * 0.9 + Math.cos(t * 0.23 + i) * 0.5;
        const fz = Math.cos(t * 0.6 + e.phase * 1.3) * 0.9 + Math.sin(t * 0.19 + i) * 0.5;
        e.vx = fx * 2.2; e.vz = fz * 2.2;
        e.x += e.vx * dt; e.z += e.vz * dt;
        if (e.x < 1 || e.x > this.sx - 2) { e.vx *= -1; e.x = Math.max(1, Math.min(this.sx - 2, e.x)); }
        if (e.z < 1 || e.z > this.sz - 2) { e.vz *= -1; e.z = Math.max(1, Math.min(this.sz - 2, e.z)); }
        const ix = Math.max(0, Math.min(this.sx - 1, e.x | 0));
        const iz = Math.max(0, Math.min(this.sz - 1, e.z | 0));
        e.y = this.surface[iz * this.sx + ix] + 1;
        if (countWork !== false) this.workCounter += 4;
      }
    }

    // 真实计算：完整面剔除网格；返回 Float32Array 供 WebGL 逐帧绘制
    buildMesh() {
      const { sx, sz, h } = this;
      const pos = [], uv = [], lig = [];
      const eps = 0.5 / (ATLAS_COLS * 64); // 半像素，防瓦片渗色（Faithful 64x 瓦片）
      const pushFace = (x, y, z, face, b, lightVal) => {
        const tileInfo = TILE[b] || TILE[Block.STONE];
        const tile = tileInfo[face.tile] != null ? tileInfo[face.tile] : tileInfo.side;
        const col = tile % ATLAS_COLS, row = Math.floor(tile / ATLAS_COLS);
        const u0 = col / ATLAS_COLS + eps, u1 = (col + 1) / ATLAS_COLS - eps;
        const v0 = 1 - (row + 1) / ATLAS_ROWS + eps, v1 = 1 - row / ATLAS_ROWS - eps;
        const uvQuad = [[u0,v0],[u1,v0],[u1,v1],[u0,v1]];
        const L = (lightVal / 15) * face.amb;
        const order = [0, 1, 2, 0, 2, 3];
        for (const oi of order) {
          const vv = face.v[oi];
          pos.push(x + vv[0], y + vv[1], z + vv[2]);
          uv.push(uvQuad[oi][0], uvQuad[oi][1]);
          lig.push(L);
        }
        this.workCounter += 6;
      };
      for (let y = 0; y < h; y++) {
        for (let z = 0; z < sz; z++) {
          for (let x = 0; x < sx; x++) {
            const b = this.blocks[this.idx(x, y, z)];
            if (b === Block.AIR) continue;
            this.workCounter++;
            const lv = this.light[this.idx(x, y, z)];
            for (let f = 0; f < 6; f++) {
              const face = FACES[f];
              const n = this.get(x + face.d[0], y + face.d[1], z + face.d[2]);
              // 面剔除：邻居为不透明方块则跳过
              if (OPAQUE(n)) continue;
              // 水/树叶半透明：同类相邻也剔除，避免过度绘制
              if ((b === Block.WATER && n === Block.WATER) || (b === Block.LEAVES && n === Block.LEAVES)) continue;
              pushFace(x, y, z, face, b, b === Block.WATER ? 13 : lv);
            }
          }
        }
      }
      this.mesh = {
        position: new Float32Array(pos),
        uv: new Float32Array(uv),
        light: new Float32Array(lig),
        vertexCount: pos.length / 3,
      };
      return this.mesh;
    }
  }
  SB.VoxelWorld = VoxelWorld;
  SB.ATLAS_COLS = ATLAS_COLS;
  SB.ATLAS_ROWS = ATLAS_ROWS;
  SB.TILE = TILE;
})(typeof window !== "undefined" ? window : globalThis);
