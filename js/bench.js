/* StarBench Web — 跑分状态机 v0.5
 *
 * 计时：performance.now() / rAF 时间戳，禁止 Date.now() 与 setInterval 计时。
 * 采样：逐帧 frameTimeMs 写入预分配 Float64Array；tickMs/meshMs 同；无每帧分配、无每帧 DOM 写入。
 * UI：onHud 以 ≤5Hz 节流。
 * 作废：visibilitychange 隐藏 / contextlost / resize / DPR 变化 / 休眠恢复 → 当前段 invalid、丢弃样本、提示重跑。
 * 流程：预热1.6s(丢弃帧计数) → Java S1/S2/S3 → 回落观测1.2s → Bedrock S1/S2/S3 = 18.4s。
 * 两侧同种子/同场景/同分辨率/同时长，仅调度剖面不同。
 */
(function (global) {
  "use strict";
  const SB = (global.SB = global.SB || {});
  const T = SB.TIMING, SC = SB.Scoring;
  const CAP = 8192; // 每段预分配样本上限（2.6s 远低于此）

  function newAcc(name, warmupMs, durationMs) {
    return {
      name, warmupMs, durationMs,
      frameTimeMs: new Float64Array(CAP), frameN: 0,
      tickMs: new Float64Array(CAP), tickN: 0,
      meshMs: new Float64Array(CAP), meshN: 0,
      chunksProcessed: 0, entityUpdates: 0, tickOver50: 0,
      discardedWarmupFrames: 0, overflow: false,
      validity: { status: "valid", void_reasons: [] },
      _lastStats: null,
    };
  }
  function push(arr, i, v, acc) { if (i < CAP) arr[i] = v; else acc.overflow = true; }

  class BenchRunner {
    constructor(renderer, hooks) {
      this.renderer = renderer;
      this.hooks = hooks || {};
      this.state = "IDLE";
      this.started = false;
      this.worker = null;
      this.msgId = 0;
      this._seed = 20261122;
      this._accs = [];
      this._phaseIdx = 0;
      this._phaseStart = 0;
      this._nominalBefore = 0;
      this._runStart = 0;
      this._last = 0;
      this._accum = 0;
      this._lastHud = 0;
      this._discardedTotal = 0;
      this._warmupDeltas = [];
      this._abortReason = null;
      this._paused = false;
      this._sustained = false;
      this._sustainedUntil = 0;
      this._lastReport = null;
      this._env = null;
      this._loopBound = (now) => this._loop(now);
      this._bindEvents();
    }

    _emitStatus(status, label, progress) {
      if (this.hooks.onStatus) this.hooks.onStatus(status, label, progress);
    }
    _emitHud(info) { if (this.hooks.onHud) this.hooks.onHud(info); }
    _emitReport(r) { if (this.hooks.onReport) this.hooks.onReport(r); }

    _bindEvents() {
      const onHide = () => {
        if (document.hidden && this.started) this._invalidate("页面切到后台（visibilitychange）");
      };
      document.addEventListener("visibilitychange", onHide);
      global.addEventListener("resize", () => {
        if (this.started) this._invalidate("窗口尺寸变化（resize）");
      });
      // devicePixelRatio 变化
      const watchDpr = () => {
        const d = global.devicePixelRatio || 1;
        if (this._lastDpr == null) this._lastDpr = d;
        else if (Math.abs(d - this._lastDpr) > 0.01 && this.started) this._invalidate("devicePixelRatio 变化");
        this._lastDpr = d;
        global.matchMedia(`(resolution: ${d}dppx)`).addEventListener("change", watchDpr, { once: true });
      };
      if (global.matchMedia) watchDpr();
      const gl = this.renderer && this.renderer.gl;
      if (gl && this.renderer.canvas) {
        this.renderer.canvas.addEventListener("webglcontextlost", (e) => {
          e.preventDefault(); if (this.started) this._invalidate("WebGL context lost");
        }, false);
        this.renderer.canvas.addEventListener("webglcontextrestored", () => {
          if (this.hooks.onContextRestored) this.hooks.onContextRestored();
        }, false);
      }
    }

    _ensureWorker() {
      if (this.worker) return true;
      try {
        this.worker = new Worker("js/sim.worker.js");
        this.worker.onmessage = (e) => this._onWorker(e.data || {});
        this.worker.onerror = (e) => {
          this._invalidate("模拟 Worker 错误：" + (e.message || "unknown"));
        };
        return true;
      } catch (err) {
        this._emitStatus("ERROR", "无法启动模拟 Worker：" + (err.message || err), 0);
        return false;
      }
    }
    _post(msg, transfer) { if (this.worker) this.worker.postMessage(msg, transfer || []); }

    _onWorker(d) {
      switch (d.type) {
        case "built":
          if (this.renderer && this.renderer.setWorldMeta) {
            this.renderer.setWorldMeta(d.sx, d.sz, d.h, d.groundY, []);
          }
          if (this._buildPending) {
            this._buildPending = false;
            this._acc = newAcc(this._phase.name, this._phase.warmupMs, this._phase.ms);
            this._acc.discardedWarmupFrames = this._discardedTotal;
            this._phaseStart = performance.now();
            this._nominalBefore = this._phase.nominal;
            this._accum = 0;
            this.state = this._phase.state;
            this._emitStatus(this.state, this._phase.label, this._progress());
          }
          break;
        case "mesh":
          if (this.renderer && this.renderer.uploadMesh) this.renderer.uploadMesh(d);
          break;
        case "ticked": {
          if (this.renderer && this.renderer.setEntities && d.entities) this.renderer.setEntities(d.entities);
          const acc = this._acc;
          if (acc && this.state !== "WARMUP" && this.started && !this._paused) {
            if (acc.tickN < CAP) acc.tickMs[acc.tickN++] = d.tickMs;
            const st = d.stats;
            if (st) {
              if (acc._lastStats) {
                acc.chunksProcessed += Math.max(0, st.work.streaming - acc._lastStats.work.streaming);
                acc.entityUpdates += Math.max(0, st.work.entity - acc._lastStats.work.entity);
                acc.tickOver50 += Math.max(0, st.over50 - acc._lastStats.over50);
                const md = Math.max(0, st.ms.meshing - acc._lastStats.ms.meshing);
                if (acc.meshN < CAP) acc.meshMs[acc.meshN++] = md;
              }
              acc._lastStats = st;
            }
          }
          break;
        }
        case "error":
          this._invalidate("模拟 Worker 异常：" + d.message);
          break;
      }
    }

    _buildPhases(sustainedMs) {
      const phases = [
        { kind: "warmup", state: "WARMUP", name: "warmup", label: "预热 · 构建世界（丢弃帧）", ms: T.warmupMs, warmupMs: 0, nominal: 0 },
      ];
      const editions = [
        { key: "java", state: "JAVA_RUN" },
        { key: "bedrock", state: "BEDROCK_RUN" },
      ];
      let nominal = T.warmupMs;
      editions.forEach((ed, ei) => {
        if (ei === 1) {
          phases.push({ kind: "recovery", state: "RECOVERY", name: "recovery", label: "回落观测窗口（不作温控诊断）", ms: T.recoveryMs, warmupMs: 0, nominal });
          nominal += T.recoveryMs;
        }
        SB.SCENARIOS.forEach((sc, si) => {
          phases.push({
            kind: "case", state: ed.state, edition: ed.key, scenario: sc, index: si,
            name: `${ed.key}/${sc.id}`, label: `${SB.PROFILES[ed.key].label} · ${sc.label}`,
            ms: T.caseMs, warmupMs: T.warmupMs, nominal,
          });
          nominal += T.caseMs;
        });
      });
      if (sustainedMs) {
        phases.push({ kind: "sustained", state: "SUSTAINED", name: "sustained", label: "持续观测（不产出跨设备分数）", ms: sustainedMs, warmupMs: 0, nominal });
      }
      return phases;
    }

    // 待机预览：在 Worker 里构建一个小世界供空闲时渲染（不进入任何采样）
    prepareIdle() {
      if (!this._ensureWorker()) return;
      this._post({
        type: "build", id: ++this.msgId,
        chunks: 3, height: 56, seed: this._seed | 0, mobCap: 24, viewDist: 4, simDist: 4,
      });
    }
    idleTick() {
      if (this.started || !this.worker) return;
      this._post({
        type: "tick", id: ++this.msgId, dtSec: 0.016,
        intensity: { chunkOps: 2, randomTicks: 8, scheduledTicks: 4, blockEntities: 4, meshSections: 2 },
        modules: null,
      });
    }

    start(sustainedMs) {
      if (this.started) return;
      if (!this._ensureWorker()) return;
      this._sustained = !!sustainedMs;
      this._sustainedUntil = sustainedMs || 0;
      this.started = true;
      this.state = "WARMUP";
      this._abortReason = null;
      this._accs = [];
      this._acc = null;
      this._phaseIdx = 0;
      this._nominalBefore = 0;
      this._discardedTotal = 0;
      this._warmupDeltas = [];
      this._paused = false;
      this._runStart = performance.now();
      this._last = this._runStart;
      this.startedAtISO = new Date().toISOString(); // 仅用于报告时间戳，不用于计时
      this.runId = "sb-" + this._seed + "-" + Math.floor(this._runStart).toString(36);
      this._phases = this._buildPhases(sustainedMs);
      this._env = this._detectEnv();
      if (this.renderer && this.renderer.lockBuffer) this.renderer.lockBuffer();
      this._enterPhase();
      this._raf = requestAnimationFrame(this._loopBound);
    }

    _enterPhase() {
      const p = this._phases[this._phaseIdx];
      this._phase = p;
      this._phaseStart = performance.now();
      this._nominalBefore = p.nominal;
      this._accum = 0;
      if (p.kind === "warmup") {
        this._acc = newAcc("warmup", 0, p.ms);
        this._buildWorld({ chunks: 2, height: 48, mobCap: 16, viewDist: 3, simDist: 3 },
          { chunkOps: 4, randomTicks: 20, scheduledTicks: 10, blockEntities: 10, meshSections: 4 }, null);
        this.state = "WARMUP";
        this._emitStatus("WARMUP", p.label, this._progress());
      } else if (p.kind === "recovery") {
        this._acc = newAcc("recovery", 0, p.ms);
        this.state = "RECOVERY";
        this._emitStatus("RECOVERY", p.label, this._progress());
      } else if (p.kind === "case") {
        const sc = p.scenario, prof = SB.PROFILES[p.edition];
        const intensity = {};
        for (const k of Object.keys(sc.intensity)) intensity[k] = Math.max(1, Math.round(sc.intensity[k] * prof.scale[k]));
        this._buildWorld(
          { chunks: sc.chunks, height: sc.height, seed: this._seed, mobCap: sc.mobCap, viewDist: sc.viewDist, simDist: sc.simDist },
          intensity, prof.modules
        );
        this.state = "BUILD";
        this._emitStatus("BUILD", "构建世界：" + p.label, this._progress());
      } else if (p.kind === "sustained") {
        const sc = SB.SCENARIOS[2], prof = SB.PROFILES.java;
        const intensity = {};
        for (const k of Object.keys(sc.intensity)) intensity[k] = Math.max(1, Math.round(sc.intensity[k] * prof.scale[k]));
        this._buildWorld(
          { chunks: sc.chunks, height: sc.height, seed: this._seed, mobCap: sc.mobCap, viewDist: sc.viewDist, simDist: sc.simDist },
          intensity, prof.modules
        );
        this.state = "BUILD";
        this._emitStatus("BUILD", "持续观测：构建世界", this._progress());
      }
    }

    _buildWorld(worldCfg, intensity, modules) {
      this._buildPending = true;
      this._post({
        type: "build", id: ++this.msgId,
        chunks: worldCfg.chunks, height: worldCfg.height, seed: worldCfg.seed | 0,
        mobCap: worldCfg.mobCap, viewDist: worldCfg.viewDist, simDist: worldCfg.simDist,
      });
      this._pendingIntensity = intensity;
      this._pendingModules = modules;
    }

    _invalidate(reason) {
      if (!this.started || this.state === "DONE") return;
      this._paused = true;
      if (this._acc) {
        this._acc.validity.status = "invalid";
        if (!this._acc.validity.void_reasons.includes(reason)) this._acc.validity.void_reasons.push(reason);
        // 丢弃该段样本
        this._acc.frameN = 0; this._acc.tickN = 0; this._acc.meshN = 0;
        this._acc.chunksProcessed = 0; this._acc.entityUpdates = 0; this._acc.tickOver50 = 0;
        this._acc._lastStats = null;
      }
      this._abortReason = (this._abortReason ? this._abortReason + "；" : "") + reason;
      // 当前正在采样的 case 段：以 invalid + 0 样本入报告，明确可见「该段被作废」
      if (this._acc && this._phase && this._phase.kind === "case") {
        this._accs.push({
          seg: SC.makeSegment({ frameTimeMs: [], tickMs: [], meshMs: [], tickOver50: 0 }, {
            name: this._phase.name, warmupMs: this._phase.warmupMs,
            discardedWarmupFrames: this._discardedTotal, durationMs: this._phase.ms,
            chunksProcessed: 0, entityUpdates: 0, validity: this._acc.validity,
          }),
          raw: null, meta: null,
        });
      }
      this._acc = null;
      this._finalize();
    }

    stop() {
      // 明确：停止 = 作废整轮
      if (!this.started) return;
      this._invalidate("用户主动停止（整轮作废）");
    }

    _detectEnv() {
      let rendererName = "unknown", vendor = "unknown", software = false;
      try {
        const gl = this.renderer && this.renderer.gl;
        if (gl) {
          const ext = gl.getExtension("WEBGL_debug_renderer_info");
          rendererName = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
          vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
          software = /swiftshader|llvmpipe|software|softpipe|mesa offscreen/i.test(String(rendererName));
        }
      } catch (e) { /* 保持 unknown */ }
      // 刷新率：用预热阶段 rAF 间隔估计，未知时回退 60（refresh-cap 另有检测）
      let hz = 60;
      if (this._warmupDeltas.length > 10) {
        const s = Array.from(this._warmupDeltas).sort((a, b) => a - b);
        const med = s[Math.floor(s.length / 2)];
        const est = 1000 / Math.max(0.5, med);
        const common = [30, 60, 75, 90, 120, 144, 165, 240];
        hz = common.reduce((best, c) => Math.abs(c - est) < Math.abs(best - est) ? c : best, 60);
      }
      const buf = this.renderer && this.renderer.bufferSize ? this.renderer.bufferSize() : { w: 1280, h: 720 };
      const ua = navigator.userAgent || "";
      const os = navigator.platform || (navigator.userAgentData && navigator.userAgentData.platform) || "unknown";
      return {
        browser: ua, os, renderer: String(rendererName), vendor: String(vendor),
        software_renderer: software, refresh_hz: hz,
        drawing_buffer: `${buf.w}x${buf.h}`, dpr: +(global.devicePixelRatio || 1).toFixed(2),
        power: "unknown", hardware_accel: "unknown",
      };
    }

    _progress() {
      if (!this._phases) return 0;
      const total = this._phases.reduce((s, p) => s + p.ms, 0);
      const elapsed = this._phase ? Math.min(this._phase.ms, performance.now() - this._phaseStart) : 0;
      return Math.max(0, Math.min(100, ((this._nominalBefore + elapsed) / total) * 100));
    }

    _loop(now) {
      if (!this.started) return;
      let dtMs = now - this._last;
      this._last = now;
      if (!(dtMs > 0)) dtMs = 1000 / 60;
      if (dtMs > 1000) { this._invalidate("设备休眠/长时间停顿（rAF 间隔 " + Math.round(dtMs) + "ms）"); return; }

      const hidden = !!document.hidden;
      if (!hidden && !this._paused) {
        // 渲染（渲染提交耗时记入 renderer）
        if (this.renderer && this.renderer.draw) this.renderer.draw(dtMs / 1000);
        // 预热 rAF 间隔用于刷新率估计；预热帧全部丢弃并计数
        if (this.state === "WARMUP") {
          if (this._warmupDeltas.length < 600) this._warmupDeltas.push(dtMs);
          this._discardedTotal++;
          if (this._acc) this._acc.discardedWarmupFrames = this._discardedTotal;
        }
        // 采集当前采样段的逐帧时间
        const sample = this.state === "JAVA_RUN" || this.state === "BEDROCK_RUN" || this.state === "SUSTAINED";
        if (sample && this._acc) {
          push(this._acc.frameTimeMs, this._acc.frameN, dtMs, this._acc);
          this._acc.frameN++;
        }
        // 按剖面 tickHz 驱动 Worker（由 rAF 时间戳累计，不用 setInterval）
        const prof = this._phase && this._phase.edition ? SB.PROFILES[this._phase.edition] : SB.PROFILES.java;
        const interval = 1000 / (prof.tickHz || 20);
        this._accum += dtMs;
        let guard = 0;
        while (this._accum >= interval && guard++ < 4) {
          this._accum -= interval;
          this._post({
            type: "tick", id: ++this.msgId, dtSec: interval / 1000,
            intensity: this._pendingIntensity || {}, modules: this._pendingModules || null,
          });
        }
      }

      // 阶段推进
      const p = this._phase;
      const elapsed = now - this._phaseStart;
      if (!hidden && !this._paused && p) {
        if (p.kind === "warmup" && elapsed >= p.ms) { this._nextPhase(); }
        else if (p.kind === "recovery" && elapsed >= p.ms) { this._nextPhase(); }
        else if ((p.kind === "case") && this.state === p.state && elapsed >= p.ms) {
          this._finalizeSegment(); this._nextPhase();
        } else if (p.kind === "sustained" && elapsed >= p.ms) {
          this._finalizeSegment(); this._finalize(); return;
        }
      }

      // HUD ≤5Hz
      if (now - this._lastHud >= 200) {
        this._lastHud = now;
        const acc = this._acc;
        const label = p ? p.label : "";
        const cd = p ? Math.max(0, (p.ms - (now - this._phaseStart)) / 1000) : 0;
        const fps = dtMs > 0 ? 1000 / dtMs : 0;
        const tickMs = acc && acc.tickN ? acc.tickMs[acc.tickN - 1] : 0;
        const dur = Math.max(0.001, (now - this._phaseStart) / 1000);
        const workUnit = (p && p.scenario && p.scenario.id === "s2") ? "ticks/s"
          : (p && p.scenario && p.scenario.id === "s3") ? "entity-updates/s" : "chunks/s";
        const workRate = acc ? (workUnit === "entity-updates/s"
          ? acc.entityUpdates / dur
          : workUnit === "ticks/s" ? (acc.tickN / dur) : (acc.chunksProcessed / dur)) : 0;
        this._emitHud({
          fps, frameMs: dtMs, tickMs, work: workRate, workUnit,
          phase: this.state, phaseLabel: label,
          countdown: cd, countdownTotal: p ? p.ms / 1000 : 0,
          progress: this._progress(),
        });
      }
      this._raf = requestAnimationFrame(this._loopBound);
    }

    _finalizeSegment() {
      if (!this._acc) return;
      if (this._phase && this._phase.kind === "case") {
        const meta = {
          name: this._phase.name, warmupMs: this._phase.warmupMs,
          discardedWarmupFrames: this._discardedTotal,
          durationMs: this._phase.ms,
          chunksProcessed: this._acc.chunksProcessed,
          entityUpdates: this._acc.entityUpdates,
          validity: this._acc.validity,
        };
        const raw = {
          frameTimeMs: Array.from(this._acc.frameTimeMs.subarray(0, this._acc.frameN)),
          tickMs: Array.from(this._acc.tickMs.subarray(0, this._acc.tickN)),
          meshMs: Array.from(this._acc.meshMs.subarray(0, this._acc.meshN)),
          tickOver50: this._acc.tickOver50,
        };
        this._accs.push({ seg: SC.makeSegment(raw, meta), raw, meta });
      }
    }

    _nextPhase() {
      this._phaseIdx++;
      if (this._phaseIdx >= this._phases.length) { this._finalize(); return; }
      this._enterPhase();
    }

    _finalize() {
      if (this.state === "DONE") return;
      this.started = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
      this.state = "DONE";
      if (this.renderer && this.renderer.unlockBuffer) this.renderer.unlockBuffer();
      // 若作废发生在已完成的 case 段之后，其余 case 段未采样：整体作废
      const segments = this._accs.map((x) => x.seg);
      const overallInvalid = !!this._abortReason || segments.some((s) => s.validity.status === "invalid");
      const validity = {
        status: overallInvalid ? "invalid" : "valid",
        void_reasons: this._abortReason ? [this._abortReason] : [],
      };
      const score = SC.computeScore(segments, this._env || this._detectEnv());
      // 无效轮次：分数不参与任何比较，归零并标注
      if (overallInvalid) { score.total = 0; score.sim = 0; score.stability = 0; score.render = 0; score.note = "本轮作废，分数无效"; }
      // 持续观测模式：不产出跨设备分数
      if (this._sustained) { score.total = 0; score.note = "持续观测模式，不产出跨设备分数"; }
      const full = {
        schema_version: "1.0",
        benchmark_version: SC.BENCHMARK_VERSION,
        score_version: SC.SCORE_VERSION,
        workload_hash: SC.WORKLOAD_HASH,
        run_id: this.runId,
        started_at: this.startedAtISO,
        validity,
        env: this._env || this._detectEnv(),
        config: {
          seed: this._seed,
          profile: "java+bedrock",
          duration_ms: T.totalMs,
          warmup_ms: T.warmupMs,
          mode: this._sustained ? "sustained" : "short",
          sustained_ms: this._sustained ? this._sustainedUntil : 0,
        },
        segments,
        score: { formula: score.formula, sim: score.sim, stability: score.stability, render: score.render, total: score.total },
        thermal: "unavailable",
        notes: "浏览器等效负载观察值，非《我的世界》帧率预测",
        // 以下为 UI 内部诊断，不进入对外 schema 报告
        _diag: {
          discarded_warmup_frames: this._discardedTotal,
          advice: SC.advice(segments, score),
          score_note: score.note || "",
          segments_detail: segments,
        },
      };
      this._lastReport = full;
      this._emitStatus("DONE", overallInvalid ? "本轮作废 · " + this._abortReason : "跑分完成", 100);
      this._emitReport(full);
    }

    // 对外严格 schema 报告（复制/下载用），剔除 _diag
    static toSchemaReport(full) {
      const r = {
        schema_version: full.schema_version,
        benchmark_version: full.benchmark_version,
        score_version: full.score_version,
        workload_hash: full.workload_hash,
        run_id: full.run_id,
        started_at: full.started_at,
        validity: full.validity,
        env: full.env,
        config: full.config,
        segments: (full.segments || []).map((s) => ({
          name: s.name, warmup_ms: s.warmup_ms, sample_count: s.sample_count,
          tick_ms: s.tick_ms, chunks_per_s: s.chunks_per_s, mesh_ms: s.mesh_ms,
          avg_fps: s.avg_fps, p99_frame_ms: s.p99_frame_ms, low1_fps: s.low1_fps,
          stutter_count: s.stutter_count, stability_ratio: s.stability_ratio,
        })),
        score: full.score,
        thermal: full.thermal,
        notes: full.notes,
      };
      return r;
    }
    lastReport() { return this._lastReport; }

    dispose() { if (this._raf) cancelAnimationFrame(this._raf); if (this.worker) this.worker.terminate(); }
  }
  SB.BenchRunner = BenchRunner;
})(typeof window !== "undefined" ? window : globalThis);
