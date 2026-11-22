/* StarBench Web — 一键跑分状态机
 * 预热 → Java 三场景 → 冷却 → Bedrock 三场景 → 三套计分。
 * 每帧驱动真实体素运算与 WebGL 绘制，记录真实 rAF 帧间隔。
 */
(function (global) {
  "use strict";
  const SB = (global.SB = global.SB || {});

  const CASE_MS = 2600, WARMUP_MS = 1600, COOLDOWN_MS = 1200;

  class BenchmarkRunner {
    constructor(renderer, hooks) {
      this.renderer = renderer;
      this.hooks = hooks || {};
      this.state = 'IDLE';
      this.world = null;
      this.raf = 0;
      this.started = false;
      this.frames = { JAVA: { avg: [], peak: [] }, BEDROCK: { avg: [], peak: [] } };
      this.caseWork = { JAVA: [], BEDROCK: [] };
      this.scores = [];
      this.advice = [];
      this._last = 0;
      this._phaseStart = 0;
      this._phaseIdx = 0;
      this._caseWorkStart = 0;
      this._seed = 20261122;
      this.idleToken = 0;
      this._warmupWorld();
    }

    _warmupWorld() {
      const w = new SB.VoxelWorld(2, 40, this._seed, 24, 3, 3);
      w.regenerate(); w.buildMesh();
      this.world = w;
      this.renderer.upload(w);
    }

    _emit(status, label, progress) {
      if (this.hooks.onStatus) this.hooks.onStatus(status, label, progress);
    }
    _emitHud(info) {
      if (this.hooks.onHud) this.hooks.onHud(info);
    }

    start() {
      if (this.started) return;
      this.started = true;
      this.idleToken++; // 终止空闲绘制循环，避免累积
      this.frames = { JAVA: { avg: [], peak: [] }, BEDROCK: { avg: [], peak: [] } };
      this.caseWork = { JAVA: [], BEDROCK: [] };
      this.scores = []; this.advice = [];
      this.state = 'WARMUP';
      this._phaseStart = performance.now();
      this._last = this._phaseStart;
      this._emit('WARMUP', '预热中，构建世界…', 3);
      this._loop(this._phaseStart);
    }

    stop() {
      this.started = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.state = 'IDLE';
    }

    _enterEdition(edition) {
      this.currentEdition = edition;
      this._phaseIdx = 0;
      this._startCase();
    }

    _startCase() {
      const cfg = SB.EditionConfig[this.currentEdition];
      const c = cfg.cases[this._phaseIdx];
      const w = new SB.VoxelWorld(c.chunks, c.height, this._seed + this._phaseIdx * 17,
        c.mobCap, c.viewDist, c.simDist);
      w.regenerate(); w.buildMesh();
      w._rebuildPerFrame = c.rebuild;
      this.world = w;
      this.renderer.upload(w);
      this._caseWorkStart = w.workCounter;
      this._phaseStart = performance.now();
      this._emit(this.currentEdition + '_RUN', c.label, this._progress());
    }

    _progress() {
      // 阶段锚点：预热3 → Java 8/22/36 → 冷却48 → Bedrock 58/72/86 → 完成100
      return this.currentEdition === 'JAVA'
        ? [8, 22, 36][this._phaseIdx] ?? 8
        : [58, 72, 86][this._phaseIdx] ?? 58;
    }

    _finishCase() {
      const c = SB.EditionConfig[this.currentEdition].cases[this._phaseIdx];
      this.caseWork[this.currentEdition].push(this.world.workCounter - this._caseWorkStart);
      this._phaseIdx++;
      if (this._phaseIdx < SB.EditionConfig[this.currentEdition].cases.length) {
        this._startCase();
        return;
      }
      if (this.currentEdition === 'JAVA') {
        this.state = 'COOLDOWN';
        this._phaseStart = performance.now();
        this._emit('COOLDOWN', '冷却判定（仅观测，不锁频）', 48);
      } else {
        this._finish();
      }
    }

    _finish() {
      this.state = 'DONE';
      this.started = false;
      for (const ed of ['JAVA', 'BEDROCK']) {
        this.scores.push(SB.Scoring.score(ed, this.frames[ed]));
      }
      this.advice = SB.Scoring.advice(this.scores);
      const report = {
        app: 'StarBench Web',
        version: '0.4.0-web',
        timestamp: new Date().toISOString(),
        platform: (navigator.userAgent || ''),
        params: { warmupMs: WARMUP_MS, caseMs: CASE_MS, cooldownMs: COOLDOWN_MS },
        cases: {
          JAVA: SB.EditionConfig.JAVA.cases.map((c, i) => ({ ...c, work: this.caseWork.JAVA[i] })),
          BEDROCK: SB.EditionConfig.BEDROCK.cases.map((c, i) => ({ ...c, work: this.caseWork.BEDROCK[i] })),
        },
        scores: this.scores,
        advice: this.advice,
        unavailable: ['CPU 占用率', 'SoC 结温', 'thermal headroom', 'ADPF PerformanceHintManager', '锁频/提频对抗'],
        boundary: '等效负载测试；64x64 区块 + 群系 + pack 刷怪 + 22i GPL-3.0 生物模型；非官方客户端。',
      };
      this._emit('DONE', '跑分完成', 100);
      if (this.hooks.onReport) this.hooks.onReport(report);
      // 绘制交由页面的空闲循环接管（started=false 时持续渲染最终场景）
    }

    _loop = (now) => {
      if (!this.started) return;
      let dt = (now - this._last) / 1000;
      this._last = now;
      if (!(dt > 0)) dt = 1 / 60;
      dt = Math.min(0.25, dt);
      const elapsed = now - this._phaseStart;

      if (this.world) {
        this.world.tickEntities(dt, true);
        if (this.world._rebuildPerFrame) this.world.rebuildSections(this.world._rebuildPerFrame);
        this.renderer.draw(dt);
      }

      const fps = 1 / Math.max(1e-6, dt);
      const work = this.world ? this.world.workCounter : 0;
      let countdown = null, countdownTotal = 0, phaseLabel = '', phase = '';

      switch (this.state) {
        case 'WARMUP':
          phase = '预热'; phaseLabel = '构建世界中';
          countdown = Math.max(0, (WARMUP_MS - elapsed) / 1000); countdownTotal = WARMUP_MS / 1000;
          if (elapsed >= WARMUP_MS) this.state = 'JAVA_PENDING';
          break;
        case 'JAVA_PENDING':
          this._enterEdition('JAVA'); this.state = 'JAVA_RUN';
          phase = 'Java Edition'; phaseLabel = SB.EditionConfig.JAVA.cases[0].label;
          countdown = CASE_MS / 1000; countdownTotal = CASE_MS / 1000;
          break;
        case 'JAVA_RUN': {
          const ns = Math.max(1, dt * 1e9);
          if (ns < 1e9) { this.frames.JAVA.avg.push(ns); this.frames.JAVA.peak.push(ns); }
          phase = 'Java Edition'; phaseLabel = SB.EditionConfig.JAVA.cases[this._phaseIdx].label;
          countdown = Math.max(0, (CASE_MS - elapsed) / 1000); countdownTotal = CASE_MS / 1000;
          if (elapsed >= CASE_MS) this._finishCase();
          break;
        }
        case 'COOLDOWN':
          phase = '冷却判定'; phaseLabel = '仅观测 · 不锁频';
          countdown = Math.max(0, (COOLDOWN_MS - elapsed) / 1000); countdownTotal = COOLDOWN_MS / 1000;
          if (elapsed >= COOLDOWN_MS) { this._enterEdition('BEDROCK'); this.state = 'BEDROCK_RUN'; }
          break;
        case 'BEDROCK_RUN': {
          const ns = Math.max(1, dt * 1e9);
          if (ns < 1e9) { this.frames.BEDROCK.avg.push(ns); this.frames.BEDROCK.peak.push(ns); }
          phase = 'Bedrock Edition'; phaseLabel = SB.EditionConfig.BEDROCK.cases[this._phaseIdx].label;
          countdown = Math.max(0, (CASE_MS - elapsed) / 1000); countdownTotal = CASE_MS / 1000;
          if (elapsed >= CASE_MS) this._finishCase();
          break;
        }
      }

      // state 变为 DONE 时本帧不再回写 HUD，避免覆盖 DONE 回调里隐藏倒计时的操作
      if (countdown !== null && this.state !== 'DONE') {
        this._emitHud({ fps, work, phase, countdown, countdownTotal, phaseLabel });
      }
      this.raf = requestAnimationFrame(this._loop);
    };
  }
  SB.BenchmarkRunner = BenchmarkRunner;
})(typeof window !== "undefined" ? window : globalThis);
