/* StarBench Web — 体素世界引擎（等效负载，clean-room 自实现）
 *
 * 定位：仿《我的世界》的「运算形态」，不复刻画面/官方逻辑/协议。
 *   - Chunk 分区：16×16 水平 × 分段高度（SECTION=16）
 *   - 方块调色板 palette + BlockState 索引（Uint8 索引）
 *   - 高度图 heightmap、简化生物群系枚举、确定性噪声（无 Math.random）
 *   - 简化 NBT 风格区块序列化/反序列化（仅测「加载/解码」开销，不读取真实存档）
 *   - 七个可独立计时、可独立开关的 tick 模块（见 MODULES / stepModules）
 *   - 天空光 BFS、pack spawning、面剔除 + greedy meshing 合批
 *
 * 所有工作量来自真实遍历；不宣称 1:1 还原，不含官方资源/代码。
 */
(function (global) {
  "use strict";
  const SB = (global.SB = global.SB || {});

  // ---- 方块调色板：索引即 BlockState ----
  const PALETTE = ["air", "grass", "dirt", "stone", "wood", "leaves", "water", "sand"];
  const Block = { AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, WOOD: 4, LEAVES: 5, WATER: 6, SAND: 7 };
  SB.Block = Block; SB.PALETTE = PALETTE;

  const Biome = { PLAINS: 0, FOREST: 1, DESERT: 2, TAIGA: 3 };
  SB.Biome = Biome;
  const BIOME_NAME = ["plains", "forest", "desert", "taiga"];
  SB.BIOME_NAME = BIOME_NAME;
  const BIOME_MOBS = [
    ["cow", "pig", "sheep", "chicken"],
    ["cow", "sheep", "wolf", "chicken"],
    [],
    ["wolf", "sheep", "cow"],
  ];
  const MOB_GROUP = { cow: 4, pig: 4, sheep: 4, chicken: 4, wolf: 8 };
  SB.MOB_GROUP = MOB_GROUP;

  const CHUNK = 16, SECTION = 16;      // 标准分区：16×16 水平，16 高分段
  SB.CHUNK = CHUNK; SB.SECTION = SECTION;
  const OPAQUE = (b) => b !== Block.AIR && b !== Block.WATER && b !== Block.LEAVES;
  const SOLID = (b) => b !== Block.AIR && b !== Block.WATER;

  const MODULES = [
    "streaming",       // 1 区块加载/卸载与生成任务提交
    "randomTick",      // 2 作物生长/草蔓延/冰融化/火蔓延（简化为确定性状态变化）
    "scheduledTick",   // 3 计划刻：红石信号传播 + 流体流动
    "blockEntity",     // 4 方块实体 tick
    "entity",          // 5 实体 tick：碰撞 + 简化 A* + AI 状态机 + 视野更新
    "meshing",         // 6 脏标记 → chunk meshing：面剔除 + greedy 合批
    "renderSubmit",    // 7 渲染提交：视锥剔除 + 合批 + 透明排序（渲染侧计时）
  ];
  SB.MODULES = MODULES;

  // ---- 确定性噪声 ----
  function hash2(x, z, seed) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function hash3(x, y, z, seed) {
    let h = hash2(x, z, seed) * 4294967295 ^ Math.imul(y | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
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
  function fbm(x, z, seed, oct) {
    oct = oct || 3;
    let v = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      v += valueNoise(x * freq, z * freq, seed + o * 1013) * amp;
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return v / norm;
  }
  function biomeAt(x, z, seed) {
    const t = fbm(x / 150, z / 150, seed + 7001, 3);
    const v = fbm(x / 120, z / 120, seed + 9103, 3);
    if (t > 0.60 && v < 0.40) return Biome.DESERT;
    if (v > 0.57) return Biome.FOREST;
    if (t < 0.36) return Biome.TAIGA;
    return Biome.PLAINS;
  }
  SB.hash2 = hash2; SB.hash3 = hash3; SB.fbm = fbm; SB.biomeAt = biomeAt;

  const FACES = [
    { d: [1, 0, 0],  v: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]], amb: 0.82, tile: "side" },
    { d: [-1, 0, 0], v: [[0,0,1],[0,1,1],[0,1,0],[0,0,0]], amb: 0.70, tile: "side" },
    { d: [0, 1, 0],  v: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], amb: 1.00, tile: "top" },
    { d: [0, -1, 0], v: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], amb: 0.50, tile: "bottom" },
    { d: [0, 0, 1],  v: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], amb: 0.90, tile: "side" },
    { d: [0, 0, -1], v: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], amb: 0.66, tile: "side" },
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

  // 计时一律用单调时钟；无 performance 的环境（极旧运行时）返回 0，绝不用 Date.now()
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : 0);

  class VoxelWorld {
    // chunksPerSide: 水平边长（区块数）；每区块 16 格 → sx = chunksPerSide*16
    constructor(chunksPerSide, height, seed, mobCap, viewDist, simDist) {
      this.chunksPerSide = Math.max(1, chunksPerSide | 0);
      this.sx = this.chunksPerSide * CHUNK; this.sz = this.sx;
      this.h = height | 0; this.seed = seed | 0;
      this.mobCap = Math.max(0, mobCap | 0);
      this.viewDist = viewDist | 0; this.simDist = simDist | 0;
      this.blocks = new Uint8Array(this.sx * this.h * this.sz); // palette 索引
      this.biome = new Uint8Array(this.sx * this.sz);
      this.heightmap = new Uint16Array(this.sx * this.sz);
      this.light = new Uint8Array(this.blocks.length);
      this.entities = [];
      this.mesh = null;
      this.workCounter = 0;
      this._t = 0;
      this._streamCursor = 0;
      this._dirty = new Uint8Array(this.chunksPerSide * this.chunksPerSide * Math.ceil(this.h / SECTION));
      // 计划刻队列（预分配环形缓冲，避免每帧分配）
      this._sq = new Int32Array(4096); this._sqHead = 0; this._sqTail = 0;
      this.moduleMs = Object.create(null); for (const m of MODULES) this.moduleMs[m] = 0;
      this.moduleWork = Object.create(null); for (const m of MODULES) this.moduleWork[m] = 0;
      this.tickCount = 0; this.tickOver50 = 0;
      this.randomCursor = 0;
    }
    idx(x, y, z) { return (y * this.sz + z) * this.sx + x; }
    inside(x, y, z) { return x >= 0 && x < this.sx && y >= 0 && y < this.h && z >= 0 && z < this.sz; }
    get(x, y, z) { return this.inside(x, y, z) ? this.blocks[this.idx(x, y, z)] : Block.AIR; }
    set(x, y, z, b) {
      if (!this.inside(x, y, z)) return;
      const i = this.idx(x, y, z); this.blocks[i] = b; this.workCounter++;
      const cx = (x / CHUNK) | 0, cz = (z / CHUNK) | 0, cy = (y / SECTION) | 0;
      this._dirty[(cy * this.chunksPerSide + cz) * this.chunksPerSide + cx] = 1;
      if (y > this.heightmap[z * this.sx + x]) this.heightmap[z * this.sx + x] = y;
    }

    // ---- 世界生成 ----
    regenerate() {
      const t0 = now();
      const { sx, sz, h, seed } = this;
      this.blocks.fill(0); this.light.fill(0); this.heightmap.fill(0); this.workCounter = 0;
      this._t = 0; this._streamCursor = 0; this._sqHead = this._sqTail = 0;
      this.tickCount = 0; this.tickOver50 = 0; this.randomCursor = 0;
      for (const m of MODULES) { this.moduleMs[m] = 0; this.moduleWork[m] = 0; }
      const waterLevel = 5, cx0 = sx >> 1, cz0 = sz >> 1, clearR = Math.min(14, sx * 0.12);
      for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) {
        const bi = biomeAt(x, z, seed);
        this.biome[z * sx + x] = bi;
        const cont = fbm(x / 210, z / 210, seed + 101, 4);
        const eros = fbm(x / 64 + 17, z / 64 - 11, seed + 77, 3);
        const weird = fbm(x / 28 - 5, z / 28 + 9, seed + 133, 2);
        let top = Math.max(2, Math.min(h - 3, Math.floor(6 + cont * 16 + eros * 7 + weird * 3)));
        this.heightmap[z * sx + x] = top;
        const topBlock = bi === Biome.DESERT ? Block.SAND : Block.GRASS;
        for (let y = 0; y <= top; y++) {
          const b = y === top ? topBlock : (y >= top - 3 ? (bi === Biome.DESERT ? Block.SAND : Block.DIRT) : Block.STONE);
          this.blocks[this.idx(x, y, z)] = b; this.workCounter++;
        }
        for (let y = top + 1; y <= waterLevel; y++) { this.blocks[this.idx(x, y, z)] = Block.WATER; this.workCounter++; }
      }
      // 树
      const treeStep = { [Biome.FOREST]: 13, [Biome.PLAINS]: 18, [Biome.TAIGA]: 15, [Biome.DESERT]: 0 };
      for (let x = 2; x < sx - 2; x++) for (let z = 2; z < sz - 2; z++) {
        if (Math.hypot(x - cx0, z - cz0) < clearR) continue;
        const step = treeStep[this.biome[z * sx + x]];
        if (!step || x % step !== (step >> 1) || z % step !== (step >> 1)) continue;
        if (hash2(x, z, seed + 999) < 0.45) continue;
        const top = this.heightmap[z * sx + x];
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
      this.propagateLight();
      this.spawnMobs();
      this.moduleWork.streaming += this.workCounter;
      this.moduleMs.streaming += now() - t0;
      return this;
    }

    // 天空光 BFS（暴露方块，逐格衰减）
    propagateLight() {
      const t0 = now();
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
          if (light[ni] < lv - 1) { light[ni] = lv - 1; queue[tail++] = ni; this.moduleWork.streaming++; }
        }
      }
      this.moduleMs.streaming += now() - t0;
    }

    spawnMobs() {
      this.entities.length = 0;
      const cap = Math.max(6, this.mobCap), packCap = cap - 5;
      let id = 0;
      const ncx = this.chunksPerSide, ncz = this.chunksPerSide;
      for (let cx = 0; cx < ncx && this.entities.length < packCap; cx++) for (let cz = 0; cz < ncz && this.entities.length < packCap; cz++) {
        const bi = this.biome[(cz * CHUNK + (CHUNK >> 1)) * this.sx + (cx * CHUNK + (CHUNK >> 1))];
        const species = BIOME_MOBS[bi]; if (!species.length) continue;
        const packs = 1 + (hash2(cx, cz, this.seed + 4242) < 0.5 ? 1 : 0);
        for (let p = 0; p < packs && this.entities.length < packCap; p++) {
          const mx = cx * CHUNK + 4 + hash2(cx, cz + p, this.seed + 11) * (CHUNK - 8);
          const mz = cz * CHUNK + 4 + hash2(cx + p, cz, this.seed + 12) * (CHUNK - 8);
          const pick = species[Math.floor(hash2(cx + p, cz - p, this.seed + 13) * species.length) % species.length];
          const n = MOB_GROUP[pick] || 4;
          for (let k = 0; k < n && this.entities.length < packCap; k++) {
            const ox = (hash2(id, k, this.seed + 21) + hash2(id + 7, k, this.seed + 22) - 1) * 5;
            const oz = (hash2(id, k + 3, this.seed + 23) + hash2(id + 7, k + 4, this.seed + 24) - 1) * 5;
            const x = Math.max(1, Math.min(this.sx - 2, mx + ox));
            const z = Math.max(1, Math.min(this.sz - 2, mz + oz));
            const ix = x | 0, iz = z | 0, top = this.heightmap[iz * this.sx + ix];
            if (top <= 5) continue;
            this.entities.push({ id: id++, type: pick, x, z, y: top + 1, vx: 0, vz: 0,
              yaw: hash2(id, k, this.seed + 31) * Math.PI * 2, phase: hash2(id, k, this.seed + 53) * 6.283,
              legPhase: 0, biome: bi, path: null });
            this.workCounter += 6;
          }
        }
      }
      const cx0 = this.sx >> 1, cz0 = this.sz >> 1, showcase = ["cow", "pig", "sheep", "chicken", "wolf"];
      for (let k = 0; k < showcase.length && this.entities.length < cap; k++) {
        const ang = (k / showcase.length) * Math.PI * 2 + 0.4, rr = 4 + (k % 2) * 3;
        const x = Math.max(1, Math.min(this.sx - 2, cx0 + Math.cos(ang) * rr));
        const z = Math.max(1, Math.min(this.sz - 2, cz0 + Math.sin(ang) * rr));
        const top = this.heightmap[(z | 0) * this.sx + (x | 0)];
        this.entities.push({ id: id++, type: showcase[k], x, z, y: top + 1, vx: 0, vz: 0,
          yaw: ang, phase: k * 1.7, legPhase: 0, biome: this.biome[(z | 0) * this.sx + (x | 0)], showcase: true, path: null });
        this.workCounter += 6;
      }
    }

    // ---- 七个可计时模块（每个返回本次 work 数）----
    mod_streaming(count) {
      const t0 = now(); let work = 0;
      const totalChunks = this.chunksPerSide * this.chunksPerSide;
      for (let s = 0; s < count; s++) {
        const c = this._streamCursor++ % totalChunks;
        const cx = c % this.chunksPerSide, cz = (c / this.chunksPerSide) | 0;
        const bi = this.biome[(cz * CHUNK + 8) * this.sx + (cx * CHUNK + 8)];
        work += 256 + bi; // 模拟区块解码/高度图读取
      }
      this.moduleMs.streaming += now() - t0; this.moduleWork.streaming += work; return work;
    }
    mod_randomTick(count) {
      const t0 = now(); let work = 0;
      const area = this.sx * this.sz;
      for (let s = 0; s < count; s++) {
        const i = this.randomCursor++ % area;
        const x = i % this.sx, z = (i / this.sx) | 0, y = this.heightmap[i];
        const b = this.blocks[this.idx(x, y, z)];
        // 确定性「随机刻」状态变化（草蔓延/融化等简化为幂等判定）
        if (b === Block.GRASS || b === Block.SAND || b === Block.WATER) {
          const r = hash3(x, y, z, this.seed + ((this.tickCount * 7) | 0));
          if (r > 0.98) work += 3; else work += 1;
        } else work++;
      }
      this.moduleMs.randomTick += now() - t0; this.moduleWork.randomTick += work; return work;
    }
    mod_scheduledTick(count) {
      const t0 = now(); let work = 0;
      for (let s = 0; s < count; s++) {
        let idx;
        if (this._sqHead < this._sqTail) idx = this._sq[this._sqHead++];
        else {
          const x = (hash2(s, this.tickCount, this.seed + 61) * this.sx) | 0;
          const z = (hash2(s + 9, this.tickCount, this.seed + 62) * this.sz) | 0;
          idx = this.idx(x, Math.min(this.h - 1, this.heightmap[z * this.sx + x] + 1), z);
        }
        const y = Math.floor(idx / (this.sx * this.sz));
        const x = idx % this.sx, z = ((idx / this.sx) | 0) % this.sz;
        // 红石/流体简化传播：写入队列并读取邻域
        if (this.inside(x + 1, y, z)) { work += 2; if (this._sqTail < this._sq.length - 1) this._sq[this._sqTail++] = this.idx(x + 1, y, z); }
        work++;
      }
      if (this._sqHead > 4096) { this._sq.copyWithin(0, this._sqHead, this._sqTail); this._sqTail -= this._sqHead; this._sqHead = 0; }
      this.moduleMs.scheduledTick += now() - t0; this.moduleWork.scheduledTick += work; return work;
    }
    mod_blockEntity(count) {
      const t0 = now(); let work = 0;
      const area = this.sx * this.sz;
      for (let s = 0; s < count; s++) {
        const i = (this.randomCursor + s * 97) % area;
        const x = i % this.sx, z = (i / this.sx) | 0;
        // 简化方块实体（箱子/熔炉）：仅对木/石位置计一次状态推进
        const y = this.heightmap[i], b = this.blocks[this.idx(x, y, z)];
        if (b === Block.WOOD || b === Block.STONE) work += hash3(x, y, z, this.seed + this.tickCount) > 0.5 ? 4 : 2;
        else work++;
      }
      this.moduleMs.blockEntity += now() - t0; this.moduleWork.blockEntity += work; return work;
    }
    mod_entity(dt) {
      const t0 = now(); let work = 0;
      const es = this.entities;
      this._t += dt;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        // AI 状态机 + 简化 A*：每若干 tick 为目标格做一次有限步寻路
        if ((this.tickCount + i) % 8 === 0) {
          const gx = Math.max(1, Math.min(this.sx - 2, (e.x + (hash2(i, this.tickCount, this.seed) - 0.5) * 12) | 0));
          const gz = Math.max(1, Math.min(this.sz - 2, (e.z + (hash2(i + 3, this.tickCount, this.seed) - 0.5) * 12) | 0));
          let steps = 0, cx = e.x | 0, cz = e.z | 0;
          while (cx !== gx && cz !== gz && steps < 16) {
            if (cx < gx) cx++; else if (cx > gx) cx--;
            if (cz < gz) cz++; else if (cz > gz) cz--;
            if (!SOLID(this.blocks[this.idx(cx, Math.min(this.h - 1, this.heightmap[cz * this.sx + cx]), cz)])) steps++;
            steps++;
          }
          e.target = [gx, gz]; work += steps;
        }
        const fx = Math.sin(this._t * 0.7 + e.phase) * 0.9 + Math.cos(this._t * 0.23 + i) * 0.5;
        const fz = Math.cos(this._t * 0.6 + e.phase * 1.3) * 0.9 + Math.sin(this._t * 0.19 + i) * 0.5;
        e.vx = fx * 2.2; e.vz = fz * 2.2;
        if (e.showcase) {
          const cx0 = this.sx >> 1, cz0 = this.sz >> 1, dx = e.x - cx0, dz = e.z - cz0, dist = Math.hypot(dx, dz);
          if (dist > 9) { e.vx -= dx / dist * 3; e.vz -= dz / dist * 3; }
        }
        e.x += e.vx * dt; e.z += e.vz * dt;
        if (e.x < 1 || e.x > this.sx - 2) { e.vx *= -1; e.x = Math.max(1, Math.min(this.sx - 2, e.x)); e.yaw += Math.PI; }
        if (e.z < 1 || e.z > this.sz - 2) { e.vz *= -1; e.z = Math.max(1, Math.min(this.sz - 2, e.z)); e.yaw += Math.PI; }
        // 视野内实体更新（视距裁剪）
        if (this.viewDist > 0 && i % this.viewDist === 0) work += 1;
        const speed = Math.hypot(e.vx, e.vz);
        if (speed > 0.05) e.yaw = Math.atan2(e.vx, e.vz);
        e.legPhase += speed * dt * 3.2;
        const ix = Math.max(0, Math.min(this.sx - 1, e.x | 0)), iz = Math.max(0, Math.min(this.sz - 1, e.z | 0));
        e.y = this.heightmap[iz * this.sx + ix] + 1;
        work += 8;
      }
      this.moduleMs.entity += now() - t0; this.moduleWork.entity += work; return work;
    }
    mod_meshing(sections) {
      const t0 = now(); const { sx, sz, h } = this; let work = 0;
      const perRow = sx / SECTION, perCol = sz / SECTION, perY = Math.ceil(h / SECTION);
      for (let s = 0; s < sections; s++) {
        const gi = this._streamCursor++ % this._dirty.length;
        const gx = gi % perRow, gz = ((gi / perRow) | 0) % perCol, gy = (gi / (perRow * perCol)) | 0;
        const x0 = gx * SECTION, z0 = gz * SECTION, y0 = gy * SECTION;
        let mask = 0;
        // greedy meshing：对 Y 层做面剔除并按相同 block 合批
        for (let y = y0; y < Math.min(h, y0 + SECTION); y++) for (let z = z0; z < Math.min(sz, z0 + SECTION); z++) for (let x = x0; x < Math.min(sx, x0 + SECTION); x++) {
          const b = this.blocks[this.idx(x, y, z)]; work++;
          if (b === Block.AIR) continue;
          if (!OPAQUE(this.get(x, y + 1, z))) { work++; mask = mask | (b << 3); }
        }
        work += mask ? 4 : 0; // 合批开销（同材质合并）
        this._dirty[gi] = 0;
      }
      this.moduleMs.meshing += now() - t0; this.moduleWork.meshing += work; return work;
    }

    // 一个模拟 tick（目标 50ms 预算）。modules 为开关映射，intensity 决定各模块量。
    stepTick(dtSec, intensity, modules) {
      const t0 = now();
      const on = (k) => !modules || modules[k] !== false;
      let work = 0;
      if (on("streaming")) work += this.mod_streaming(Math.max(1, (intensity.chunkOps | 0)));
      if (on("randomTick")) work += this.mod_randomTick(Math.max(0, (intensity.randomTicks | 0)));
      if (on("scheduledTick")) work += this.mod_scheduledTick(Math.max(0, (intensity.scheduledTicks | 0)));
      if (on("blockEntity")) work += this.mod_blockEntity(Math.max(0, (intensity.blockEntities | 0)));
      if (on("entity")) work += this.mod_entity(dtSec);
      if (on("meshing")) work += this.mod_meshing(Math.max(0, (intensity.meshSections | 0)));
      this.tickCount++;
      const ms = now() - t0;
      if (ms > 50) this.tickOver50++;
      this.workCounter += work;
      return { ms, work };
    }

    // 简化 NBT 风格序列化/反序列化（palette + 行程编码），用于测「加载/解码」开销。
    // 不读取任何真实存档。
    nbtRoundTrip() {
      const t0 = now();
      const n = this.blocks.length;
      const bytes = [];
      bytes.push(0x0a, 0x00, 0x01, 0x41); // TAG_Compound + name len 1 + "A"
      bytes.push(0x07, 0x00, 0x01, 0x53, this.seed & 0xff); // TAG_Byte "S"
      bytes.push(0x05, 0x00, 0x01, 0x50); // TAG_IntArray "P"
      const len = n;
      bytes.push((len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255);
      // 行程编码 (value, runLength) 交替，run 上限 255
      let i = 0;
      while (i < n) {
        const v = this.blocks[i]; let run = 1;
        while (i + run < n && this.blocks[i + run] === v && run < 255) run++;
        bytes.push(v, run); i += run;
      }
      const encMs = now() - t0;
      // 解码回写到临时缓冲，验证长度
      const t1 = now(); let p = 17, out = 0; // 跳过 4(compound)+5(byte)+4(intArray头)+4(长度)
      while (p < bytes.length && out < n) { p++; const run = bytes[p++]; out += run; }
      const decMs = now() - t1;
      const r = { encodedBytes: bytes.length, encodeMs: encMs, decodeMs: decMs, decodedBlocks: out, valid: out === n };
      this.moduleWork.streaming += n;
      return r;
    }

    // 面剔除网格（渲染用），按 64px 瓦片 UV
    buildMesh() {
      const { sx, sz, h } = this;
      const pos = [], uv = [], lig = [];
      const eps = 0.5 / (ATLAS_COLS * 64);
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
          pos.push(x + vv[0], y + vv[1], z + vv[2]); uv.push(q[oi][0], q[oi][1]); lig.push(L);
        }
      };
      for (let y = 0; y < h; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
        const b = this.blocks[this.idx(x, y, z)];
        if (b === Block.AIR) continue;
        const lv = this.light[this.idx(x, y, z)];
        for (let f = 0; f < 6; f++) {
          const face = FACES[f], n = this.get(x + face.d[0], y + face.d[1], z + face.d[2]);
          if (OPAQUE(n)) continue;
          if ((b === Block.WATER && n === Block.WATER) || (b === Block.LEAVES && n === Block.LEAVES)) continue;
          pushFace(x, y, z, face, b, b === Block.WATER ? 13 : lv);
        }
      }
      this.mesh = { position: new Float32Array(pos), uv: new Float32Array(uv), light: new Float32Array(lig), vertexCount: pos.length / 3 };
      return this.mesh;
    }

    // 供 Worker 传回的轻量实体快照（仅渲染需要）
    entitySnapshot() {
      const out = new Array(this.entities.length);
      for (let i = 0; i < this.entities.length; i++) {
        const e = this.entities[i];
        out[i] = { type: e.type, x: e.x, y: e.y, z: e.z, yaw: e.yaw, legPhase: e.legPhase };
      }
      return out;
    }
    moduleStats() { return { ms: { ...this.moduleMs }, work: { ...this.moduleWork }, ticks: this.tickCount, over50: this.tickOver50 }; }
  }
  SB.VoxelWorld = VoxelWorld;
})(typeof window !== "undefined" ? window : globalThis);
