/* StarBench Web — 指标与计分（v1.0）
 *
 * 设计原则：
 *  - 全部指标由逐帧 frameTimeMs（Float64/普通数组，预分配）导出，禁止只累加 FPS 反推。
 *  - 1% Low 定义写死：取最慢 1% 帧时间调和平均后换算 FPS；并与 1000/P99 帧时间自洽（两者接近）。
 *  - refresh-capped 检测：FPS 贴近 60/120/144 且帧时间方差极小 → 标记「受呈现同步上限约束，无区分力」。
 *  - 峰值降级为诊断字段，标注统计脆弱，不进入三套主分数。
 *  - 综合分用各场景 FPS 加权几何平均 × 分辨率系数，禁止线性相加。
 *  - 分数带 benchmark_version / score_version / workload_hash。
 */
(function (global) {
  "use strict";
  const SB = (global.SB = global.SB || {});

  const BENCHMARK_VERSION = "0.5.0-web";
  const SCORE_VERSION = "1.0";

  // ---- 场景配置：每剖面 3 个场景，压不同环节；两侧同种子/同场景数/同分辨率/同时长，仅调度剖面不同 ----
  // S1 静态世界：区块生成 + 光照 + meshing 吞吐
  // S2 高动态：randomTick / 计划刻(红石/流体) / 方块实体密集更新
  // S3 实体密集：寻路 + 碰撞 + AI + 视野剔除 + 合批渲染
  const SCENARIOS = [
    { id: "s1", label: "S1 静态世界 · chunk/光照/mesh 吞吐", chunks: 6, height: 64,
      mobCap: 8, viewDist: 5, simDist: 4,
      intensity: { chunkOps: 6, randomTicks: 2, scheduledTicks: 2, blockEntities: 2, meshSections: 6 } },
    { id: "s2", label: "S2 高动态 · random/计划刻/方块实体", chunks: 6, height: 64,
      mobCap: 8, viewDist: 5, simDist: 4,
      intensity: { chunkOps: 2, randomTicks: 220, scheduledTicks: 90, blockEntities: 120, meshSections: 2 } },
    { id: "s3", label: "S3 实体密集 · 寻路/碰撞/AI/合批", chunks: 6, height: 64,
      mobCap: 120, viewDist: 8, simDist: 6,
      intensity: { chunkOps: 2, randomTicks: 8, scheduledTicks: 4, blockEntities: 4, meshSections: 3 } },
  ];
  SB.SCENARIOS = SCENARIOS;

  // 调度剖面：人为构造的差异，仅改变 tick 频率与模块分片，不改变世界/种子/分辨率/时长。
  // 注意：这不是两个官方引擎的真实架构对比。
  const PROFILES = {
    java: {
      label: "Java Edition 剖面",
      // 单主线程 tick 为主：tick 频率低，每 tick 工作量大；chunk 生成回主线程提交
      tickHz: 20,
      scale: { chunkOps: 1.0, randomTicks: 1.0, scheduledTicks: 1.0, blockEntities: 1.0, meshSections: 1.0 },
      modules: null,
    },
    bedrock: {
      label: "Bedrock Edition 剖面",
      // 任务分片更细、tick 与渲染解耦：tick 频率高，每 tick 工作量小、更多 mesh 分片
      tickHz: 40,
      scale: { chunkOps: 0.55, randomTicks: 0.5, scheduledTicks: 0.5, blockEntities: 0.5, meshSections: 1.6 },
      modules: null,
    },
  };
  SB.PROFILES = PROFILES;

  const TIMING = {
    warmupMs: 1600, caseMs: 2600, recoveryMs: 1200,
    totalMs: 1600 + 3 * 2600 + 1200 + 3 * 2600, // 18400
    tickBudgetMs: 50, sustainedMinMs: 120000, sustainedMaxMs: 300000,
  };
  SB.TIMING = TIMING;

  // FNV-1a 32bit → workload_hash（配置变更即变）
  function workloadHash(obj) {
    const s = JSON.stringify(obj);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  SB.workloadHash = workloadHash;
  const WORKLOAD_HASH = workloadHash({ BENCHMARK_VERSION, SCORE_VERSION, SCENARIOS, PROFILES, TIMING });
  SB.WORKLOAD_HASH = WORKLOAD_HASH;

  // ---- 帧统计（输入 frameTimeMs 数组，单位 ms）----
  const FrameStats = {
    // 线性插值百分位（排序副本，不修改原数组）
    percentile(sorted, p) {
      if (!sorted.length) return 0;
      if (sorted.length === 1) return sorted[0];
      const idx = (sorted.length - 1) * p;
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      if (lo === hi) return sorted[lo];
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    },
    sorted(xs) { return Array.from(xs).sort((a, b) => a - b); },
    meanMs(xs) { if (!xs.length) return 0; let s = 0; for (const v of xs) s += v; return s / xs.length; },
    avgFps(xs) { const m = this.meanMs(xs); return m > 0 ? 1000 / m : 0; },
    // 1% Low：最慢 1% 帧时间做调和平均 → FPS = 1000 / 平均(慢帧时间)
    low1Fps(xs) {
      if (!xs.length) return 0;
      const desc = Array.from(xs).sort((a, b) => b - a);
      const k = Math.max(1, Math.ceil(desc.length * 0.01));
      let s = 0; for (let i = 0; i < k; i++) s += Math.max(0.0001, desc[i]);
      return 1000 / (s / k);
    },
    // P99 帧时间定义为「最慢 1% 帧时间的算术均值」，与 1% Low（1000/该均值）严格自洽：
    // 1000 / p99FrameMs === low1Fps。避免尖峰分布下教科书百分位落入快帧簇导致两者矛盾。
    p99FrameMs(sortedAsc) {
      if (!sortedAsc.length) return 0;
      const k = Math.max(1, Math.ceil(sortedAsc.length * 0.01));
      let s = 0; for (let i = sortedAsc.length - k; i < sortedAsc.length; i++) s += Math.max(0.0001, sortedAsc[i]);
      return s / k;
    },
    // 1% Low 与 P99 自洽性：|1000/P99 - low1| / low1，应为 0（同一统计量）
    low1VsP99(xs) {
      const s = this.sorted(xs);
      const p99 = this.p99FrameMs(s);
      const implied = p99 > 0 ? 1000 / p99 : 0;
      const low1 = this.low1Fps(xs);
      const rel = low1 > 0 ? Math.abs(implied - low1) / low1 : 0;
      return { p99FrameMs: +p99.toFixed(3), impliedFps: +implied.toFixed(2), low1Fps: +low1.toFixed(2), relDiff: +rel.toFixed(4) };
    },
    stutterCount(xs, thresholdMs) { const t = thresholdMs || 50; let c = 0; for (const v of xs) if (v > t) c++; return c; },
    // 帧时间变异系数（CV），用于 refresh-cap 判定
    cv(xs) {
      if (xs.length < 2) return 1;
      const m = this.meanMs(xs); if (m <= 0) return 1;
      let s = 0; for (const v of xs) s += (v - m) * (v - m);
      return Math.sqrt(s / xs.length) / m;
    },
    // refresh-capped：FPS 贴近常见刷新率（±4%）且 CV 极小（<0.02）
    detectRefreshCap(xs) {
      if (xs.length < 30) return { capped: false, hz: null };
      const fps = this.avgFps(xs), cv = this.cv(xs);
      const candidates = [60, 120, 144, 90, 75, 30];
      for (const hz of candidates) {
        if (Math.abs(fps - hz) / hz < 0.04 && cv < 0.02) {
          return { capped: true, hz, fps: +fps.toFixed(2), cv: +cv.toFixed(4) };
        }
      }
      return { capped: false, hz: null, fps: +fps.toFixed(2), cv: +cv.toFixed(4) };
    },
    // 诊断字段：峰值（单帧最快，统计脆弱）
    peakDiagnostic(xs) {
      if (!xs.length) return 0;
      let min = Infinity; for (const v of xs) if (v > 0 && v < min) min = v;
      return +(1000 / min).toFixed(2);
    },
  };
  SB.FrameStats = FrameStats;

  function percentileOf(xs, p) { return FrameStats.percentile(FrameStats.sorted(xs), p); }

  // 由一段原始样本生成报告 segment（严格遵循 schema 字段）
  function makeSegment(raw, meta) {
    const ft = raw.frameTimeMs || [];
    const sortedFT = FrameStats.sorted(ft);
    const tick = raw.tickMs || [];
    const sortedTick = FrameStats.sorted(tick);
    const n = ft.length;
    const avgFps = FrameStats.avgFps(ft);
    const low1 = FrameStats.low1Fps(ft);
    const p99 = FrameStats.p99FrameMs(sortedFT);
    const sampleInsufficient = n < 300;
    const cap = FrameStats.detectRefreshCap(ft);
    return {
      name: meta.name,
      warmup_ms: meta.warmupMs,
      sample_count: n,
      discarded_warmup_frames: meta.discardedWarmupFrames || 0,
      tick_ms: {
        p50: +percentileOf(tick, 0.5).toFixed(3),
        p95: +percentileOf(tick, 0.95).toFixed(3),
        p99: +percentileOf(tick, 0.99).toFixed(3),
        over_50ms: raw.tickOver50 || FrameStats.stutterCount(tick, 50),
      },
      chunks_per_s: +(meta.chunksProcessed / (meta.durationMs / 1000)).toFixed(2),
      mesh_ms: +(FrameStats.meanMs(raw.meshMs || []).toFixed(3)),
      entity_updates_per_s: +(meta.entityUpdates / (meta.durationMs / 1000)).toFixed(2),
      avg_fps: +avgFps.toFixed(2),
      p50_frame_ms: +FrameStats.percentile(sortedFT, 0.5).toFixed(3),
      p95_frame_ms: +FrameStats.percentile(sortedFT, 0.95).toFixed(3),
      p99_frame_ms: +p99.toFixed(3),
      low1_fps: +low1.toFixed(2),
      low1_definition: "1000/最慢1%帧时间均值（与P99自洽）",
      low1_vs_p99: FrameStats.low1VsP99(ft),
      stutter_count: FrameStats.stutterCount(ft, 50),
      stability_ratio: avgFps > 0 ? +(low1 / avgFps).toFixed(4) : 0,
      peak_diagnostic_fps: FrameStats.peakDiagnostic(ft),
      peak_diagnostic_note: "单帧最快值，统计脆弱，受刷新率上限约束，非主分数",
      refresh_capped: cap,
      sample_insufficient: sampleInsufficient,
      validity: meta.validity || { status: "valid", void_reasons: [] },
    };
  }

  // 综合分：几何平均 × 分辨率系数；分数为「观察值」无量纲
  function computeScore(segments, env) {
    // 样本极少时仍给出本机观察分（≥2 帧），但 sample_insufficient 标记与文案保留，
    // 明确不用于跨设备比较；作废段一律排除。
    const valid = segments.filter((s) => s.validity.status === "valid" && s.sample_count >= 2);
    if (!valid.length) return { formula: SCORE_FORMULA, sim: 0, stability: 0, render: 0, total: 0, note: "无有效分段" };
    const gm = (arr) => {
      if (!arr.length) return 0;
      let p = 1; for (const v of arr) p *= Math.max(1e-6, v);
      return Math.pow(p, 1 / arr.length);
    };
    // 分辨率系数：参考 1280×720，实际像素越多体素渲染成本越高
    const refPx = 1280 * 720;
    const actualPx = (parseInt(env.drawing_buffer, 10) || refPx) * ((env.drawing_buffer.split("x")[1] | 0) || 720);
    const buf = env.drawing_buffer || "1280x720";
    const parts = buf.split("x"); const ax = +parts[0] || 1280, ay = +parts[1] || 720;
    const resCoeff = Math.pow(refPx / Math.max(1, ax * ay), 0.15); // 温和补偿，禁止线性
    const sim = +gm(valid.map((s) => s.chunks_per_s + s.entity_updates_per_s * 0.01)).toFixed(3);
    const stability = +gm(valid.map((s) => Math.max(0.01, s.stability_ratio))).toFixed(4);
    const render = +gm(valid.map((s) => s.avg_fps)).toFixed(2);
    const total = +(Math.pow(Math.max(1e-6, sim) * Math.max(1e-6, stability) * Math.max(1e-6, render), 1 / 3) * resCoeff).toFixed(2);
    return {
      formula: SCORE_FORMULA, sim, stability, render, total,
      resolution_coefficient: +resCoeff.toFixed(4),
      reference_buffer: "1280x720",
      benchmark_version: BENCHMARK_VERSION, score_version: SCORE_VERSION, workload_hash: WORKLOAD_HASH,
    };
  }
  const SCORE_FORMULA =
    "total = GM(sim, stability, render) × (1280×720 / actualPixels)^0.15；" +
    "sim=GM(chunks_per_s + 0.01×entity_updates_per_s)，stability=GM(low1_fps/avg_fps)，render=GM(avg_fps)；" +
    "三维等权几何平均，禁止线性相加。";

  function advice(segments, score) {
    const out = [];
    const valid = segments.filter((s) => s.validity.status === "valid");
    for (const s of valid) {
      const gap = s.avg_fps > 0 ? (s.avg_fps - s.low1_fps) / s.avg_fps : 0;
      if (gap > 0.5) out.push(`${s.name}：1% Low 低于平均约 ${(gap * 100).toFixed(0)}%，通常能感到明显卡顿；可尝试降低内部渲染分辨率或每帧像素成本。`);
      else if (s.stability_ratio >= 0.8) out.push(`${s.name}：帧时间稳定（稳定性比 ${s.stability_ratio}）。`);
      else out.push(`${s.name}：1% Low 与平均差距中等（稳定性比 ${s.stability_ratio}）。`);
      if (s.refresh_capped && s.refresh_capped.capped) out.push(`${s.name}：受呈现同步上限约束（≈${s.refresh_capped.hz}Hz，CV=${s.refresh_capped.cv}），无区分力；建议提高内部渲染分辨率或提升每帧像素成本。`);
      if (s.sample_insufficient) out.push(`${s.name}：sample_count=${s.sample_count}<300，样本不足，仅供参考，不用于跨设备比较。`);
      if (s.tick_ms.over_50ms > 0) out.push(`${s.name}：有 ${s.tick_ms.over_50ms} 个 tick 超过 50ms 预算。`);
    }
    const voids = segments.filter((s) => s.validity.status === "invalid");
    for (const s of voids) out.push(`${s.name}：已作废（${s.validity.void_reasons.join("、")}），样本不进入分数。`);
    out.push("计时：全部指标由逐帧 frameTimeMs 导出；计时用 performance.now()/rAF 时间戳。");
    out.push("温度：浏览器无法读取 SoC 结温 / thermal headroom / 频率 / 风扇；温度项恒为 unavailable，不锁频、不提频、不对抗温控。");
    out.push("合规：等效负载观察值，非《我的世界》帧率预测，非官方客户端，不含官方资源；商标归 Mojang/Microsoft 所有，本项目与其无关联。");
    return out;
  }

  SB.Scoring = {
    BENCHMARK_VERSION, SCORE_VERSION, WORKLOAD_HASH, SCORE_FORMULA,
    FrameStats, makeSegment, computeScore, advice, workloadHash,
  };
})(typeof window !== "undefined" ? window : globalThis);
