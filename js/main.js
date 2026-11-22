/* StarBench Web — 交互与报告 v0.5
 * 职责：WebGL 边界态、开始前检查清单、实时区、结果页解读、报告导出/复制、本地历史、
 * 导入导出（1MiB + 严格字段/有限数校验，外部导入标「未在本机验证」）。
 * UI 以 ≤5Hz 节流（onHud 来自 bench），状态用 aria-live 播报，不只用颜色区分。
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let renderer, runner, lastReport = null;
  const HISTORY_KEY = "starbench.history.v1";

  // ---- WebGL 初始化（含边界态）----
  const glCanvas = document.createElement("canvas");
  const screenCanvas = $("screen");
  try {
    renderer = new SB.WebGLRenderer(glCanvas, screenCanvas);
  } catch (e) {
    const err = $("glError");
    err.hidden = false;
    err.innerHTML = "<b>WebGL 不可用</b><br>" + e.message +
      "<br><br>指引：更新浏览器到最新版、在设置中开启硬件加速、或改用 Chrome/Edge/Firefox/Safari；" +
      "若在虚拟机/远程桌面中，可能仅有软件渲染，结果不具区分力。";
    $("startBtn").disabled = true;
    return;
  }

  const isSoftware = renderer.gl && (() => {
    const gl = renderer.gl, ext = gl.getExtension("WEBGL_debug_renderer_info");
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return /swiftshader|llvmpipe|software|softpipe/i.test(String(r));
  })();
  if (isSoftware) {
    const box = $("swWarn"); if (box) box.hidden = false;
  }

  function fmt(n, d) { const v = Number(n); return isFinite(v) ? v.toLocaleString("zh-CN", { maximumFractionDigits: d == null ? 1 : d }) : "--"; }

  // ---- HUD（≤5Hz，由 bench 节流）----
  function setHud(info) {
    $("hudPhase").textContent = info.phaseLabel || info.phase || "--";
    $("hudFps").textContent = fmt(info.fps, 1) + " FPS";
    $("hudFrame").textContent = fmt(info.frameMs, 2) + " ms";
    $("hudTick").textContent = fmt(info.tickMs, 2) + " ms";
    $("hudWork").textContent = fmt(info.work, 1) + " " + (info.workUnit || "/s");
    if (info.phase === "JAVA_RUN" || info.phase === "BEDROCK_RUN" || info.phase === "SUSTAINED") {
      renderer.addFrameSample(info.frameMs);
      drawCurve();
    }
    $("liveStatus").textContent = `${info.phaseLabel || info.phase} · FPS ${fmt(info.fps, 1)} · 帧时 ${fmt(info.frameMs, 2)}ms · tick ${fmt(info.tickMs, 2)}ms`;
  }

  function drawCurve() {
    const cv = $("curve"); if (!cv) return;
    const ctx = cv.getContext("2d");
    const data = renderer.curveSnapshot();
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const max = 50;
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.beginPath(); ctx.moveTo(0, h - (16.67 / max) * h); ctx.lineTo(w, h - (16.67 / max) * h); ctx.stroke();
    ctx.strokeStyle = "#6ea8ff"; ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * w;
      const y = h - Math.min(1, data[i] / max) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function onStatus(status, label, progress) {
    const names = {
      WARMUP: "预热中（帧已丢弃）", BUILD: "构建世界", RECOVERY: "回落观测窗口",
      JAVA_RUN: "Java 剖面", BEDROCK_RUN: "Bedrock 剖面", SUSTAINED: "持续观测", DONE: "完成", ERROR: "错误",
    };
    const text = (names[status] || status) + (label ? " · " + label : "");
    $("statusText").textContent = text;
    $("liveStatus").textContent = text;
    $("progressBar").style.width = (progress || 0).toFixed(1) + "%";
    $("progressText").textContent = (progress || 0).toFixed(0) + "%";
    if (status === "DONE") {
      $("startBtn").disabled = false;
      $("stopBtn").disabled = true;
      $("sustain2Btn").disabled = false;
      $("sustain5Btn").disabled = false;
    }
  }

  function onContextRestored() {
    try { renderer.rebuild(); $("statusText").textContent = "WebGL 上下文已恢复，可重新跑分"; }
    catch (e) { $("statusText").textContent = "WebGL 恢复失败：" + e.message; }
  }

  function stabilityRating(ratio) {
    if (ratio >= 0.85) return ["优秀", "good"];
    if (ratio >= 0.65) return ["良好", "muted"];
    if (ratio >= 0.45) return ["一般", "warn"];
    return ["较差", "warn"];
  }

  // 人类可读摘要（字段与 schema 报告一致，不额外编造）
  function humanSummary(schema) {
    const v = schema.validity;
    const lines = [];
    lines.push(`运行状态：${v.status === "valid" ? "有效" : "无效"} ${v.void_reasons.length ? "（" + v.void_reasons.join("；") + "）" : ""}`);
    lines.push(`版本：benchmark ${schema.benchmark_version} · score ${schema.score_version} · hash ${schema.workload_hash}`);
    lines.push(`环境：${schema.env.drawing_buffer} · DPR ${schema.env.dpr} · refresh≈${schema.env.refresh_hz}Hz · ${schema.env.software_renderer ? "软件渲染" : "渲染器未标明软件"} · power ${schema.env.power}`);
    lines.push(`配置：seed ${schema.config.seed} · 时长 ${schema.config.duration_ms}ms · 预热 ${schema.config.warmup_ms}ms · 模式 ${schema.config.mode}`);
    lines.push("");
    for (const s of schema.segments) {
      lines.push(`[${s.name}] 样本 ${s.sample_count} · avg ${s.avg_fps} FPS · 1%Low ${s.low1_fps} · p99 ${s.p99_frame_ms}ms · tick p95 ${s.tick_ms.p95}ms(>50ms ${s.tick_ms.over_50ms}) · chunks/s ${s.chunks_per_s} · mesh ${s.mesh_ms}ms · stutter ${s.stutter_count} · 稳定性 ${s.stability_ratio}`);
    }
    lines.push("");
    lines.push(`分数：sim ${schema.score.sim} · stability ${schema.score.stability} · render ${schema.score.render} · total ${schema.score.total}`);
    lines.push(`公式：${schema.score.formula}`);
    lines.push(`温度：${schema.thermal}`);
    lines.push(`说明：${schema.notes}`);
    return lines.join("\n");
  }

  function reportHTML(full) {
    const schema = SB.BenchRunner.toSchemaReport(full);
    const diag = full._diag || {};
    let html = "";
    if (schema.validity.status === "invalid") {
      html += `<div class="r-invalid">本轮作废：${schema.validity.void_reasons.join("；") || "样本无效"}。样本不进入分数，请重跑。</div>`;
    }
    html += `<div class="r-scores">
      <div><span>综合分</span><b>${fmt(schema.score.total, 2)}</b></div>
      <div><span>模拟吞吐</span><b>${fmt(schema.score.sim, 3)}</b></div>
      <div><span>帧稳定性</span><b>${fmt(schema.score.stability, 4)}</b></div>
      <div><span>渲染吞吐</span><b>${fmt(schema.score.render, 2)}</b></div>
    </div>`;
    html += `<table><thead><tr><th>分段</th><th>样本</th><th>平均FPS</th><th>1% Low</th><th>p99 ms</th><th>tick p95</th><th>稳定性</th></tr></thead><tbody>`;
    for (const s of schema.segments) {
      html += `<tr><td>${s.name}</td><td>${s.sample_count}</td><td>${fmt(s.avg_fps)}</td><td>${fmt(s.low1_fps)}</td><td>${fmt(s.p99_frame_ms, 2)}</td><td>${fmt(s.tick_ms.p95, 2)}</td><td>${fmt(s.stability_ratio, 3)}</td></tr>`;
    }
    html += `</tbody></table>`;

    // 解读区
    const advice = diag.advice || [];
    html += `<div class="r-interp"><div class="r-h">解读</div><ul>` + advice.map((a) => `<li>${a}</li>`).join("") + `</ul></div>`;

    // 各段折叠明细
    html += `<div class="r-h">分段明细（展开查看）</div>`;
    for (const s of schema.segments) {
      const extra = (diag.segments_detail || []).find((d) => d.name === s.name) || s;
      const rating = stabilityRating(s.stability_ratio);
      html += `<details class="r-detail"><summary>${s.name} · 稳定性 <b class="${rating[1]}">${rating[0]}</b></summary>
        <div class="r-grid">
          <span>预热丢弃帧</span><b>${extra.discarded_warmup_frames || 0}</b>
          <span>样本数</span><b>${s.sample_count}${s.sample_count < 300 ? "（样本不足）" : ""}</b>
          <span>p50/p95/p99 帧时</span><b>${fmt(extra.p50_frame_ms, 2)}/${fmt(extra.p95_frame_ms, 2)}/${fmt(s.p99_frame_ms, 2)} ms</b>
          <span>1% Low 定义</span><b>${extra.low1_definition || "最慢1%帧时间调和平均"}</b>
          <span>1%Low vs P99自洽</span><b>${extra.low1_vs_p99 ? "相对差 " + (extra.low1_vs_p99.relDiff * 100).toFixed(1) + "%" : "--"}</b>
          <span>chunks/s</span><b>${s.chunks_per_s}</b>
          <span>entity-updates/s</span><b>${fmt(extra.entity_updates_per_s, 1)}</b>
          <span>mesh 平均耗时</span><b>${fmt(s.mesh_ms, 3)} ms</b>
          <span>tick p50/p95/p99</span><b>${s.tick_ms.p50}/${s.tick_ms.p95}/${s.tick_ms.p99} ms</b>
          <span>超50ms tick</span><b>${s.tick_ms.over_50ms}</b>
          <span>卡顿帧(>50ms)</span><b>${s.stutter_count}</b>
          <span>峰值诊断(非主分数)</span><b>${fmt(extra.peak_diagnostic_fps, 1)} FPS</b>
          <span>刷新率封顶</span><b>${extra.refresh_capped && extra.refresh_capped.capped ? "是 ≈" + extra.refresh_capped.hz + "Hz" : "否"}</b>
        </div></details>`;
    }
    html += `<div class="r-meta">benchmark_version ${schema.benchmark_version} · score_version ${schema.score_version} · workload_hash ${schema.workload_hash} · run_id ${schema.run_id}</div>`;
    return html;
  }

  function renderReport(full) {
    lastReport = full;
    $("reportBody").innerHTML = reportHTML(full);
    $("report").hidden = false;
    $("copyBtn").disabled = false;
    $("downloadBtn").disabled = false;
    addHistory(SB.BenchRunner.toSchemaReport(full));
  }

  // ---- 本地历史（≤20 条）----
  function loadHistory() {
    try { const a = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); return Array.isArray(a) ? a.slice(0, 20) : []; }
    catch (e) { return []; }
  }
  function addHistory(report) {
    const h = loadHistory();
    h.unshift({ imported: false, at: new Date().toISOString(), report });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 20)));
    renderHistory();
  }
  function renderHistory() {
    const h = loadHistory();
    const box = $("history"); if (!box) return;
    if (!h.length) { box.innerHTML = '<div class="r-h" style="margin:0">本地历史：暂无</div>'; return; }
    box.innerHTML = '<div class="r-h">本地历史（最多 20 条）</div>' + h.map((x, i) => {
      const r = x.report || {};
      const tag = x.imported ? '<span class="tag-import">外部导入·未在本机验证</span>' : '<span class="tag-local">本机运行</span>';
      return `<div class="hist-row">${tag} <span>${(r.run_id || "?")}</span> <span>total ${fmt((r.score || {}).total, 2)}</span> <button class="btn-mini" data-h="${i}">查看</button></div>`;
    }).join("");
    box.querySelectorAll("[data-h]").forEach((b) => b.addEventListener("click", () => {
      const item = loadHistory()[+b.getAttribute("data-h")];
      if (item) { lastReport = { ...item.report, _diag: { advice: [], segments_detail: item.report.segments } }; $("reportBody").innerHTML = reportHTML(lastReport); $("report").hidden = false; }
    }));
  }

  // ---- 严格校验导入报告 ----
  const NUM_FIELDS = ["duration_ms", "warmup_ms", "refresh_hz", "dpr"];
  function validateSchemaReport(obj) {
    if (!obj || typeof obj !== "object") return "顶层不是对象";
    const req = ["schema_version", "benchmark_version", "score_version", "workload_hash", "run_id", "started_at", "validity", "env", "config", "segments", "score", "thermal", "notes"];
    for (const k of req) if (!(k in obj)) return "缺少字段 " + k;
    if (obj.schema_version !== "1.0") return "schema_version 必须为 1.0";
    if (!obj.validity || !Array.isArray(obj.validity.void_reasons) || !["valid", "invalid"].includes(obj.validity.status)) return "validity 非法";
    if (!Array.isArray(obj.segments)) return "segments 非法";
    for (const s of obj.segments) {
      if (typeof s.name !== "string" || !isFinite(s.sample_count) || s.sample_count < 0) return "segment.sample_count 非法";
      const numKeys = ["chunks_per_s", "mesh_ms", "avg_fps", "p99_frame_ms", "low1_fps", "stutter_count", "stability_ratio"];
      for (const k of numKeys) if (typeof s[k] !== "number" || !isFinite(s[k])) return "segment." + k + " 必须为有限数";
      if (!s.tick_ms || ["p50", "p95", "p99", "over_50ms"].some((k) => typeof s.tick_ms[k] !== "number" || !isFinite(s.tick_ms[k]))) return "segment.tick_ms 非法";
    }
    if (!obj.score || ["sim", "stability", "render", "total"].some((k) => typeof obj.score[k] !== "number" || !isFinite(obj.score[k]))) return "score 非法";
    if (!obj.env || typeof obj.env.drawing_buffer !== "string") return "env 非法";
    if (!obj.config || NUM_FIELDS.some((k) => (k in obj.config) && !isFinite(obj.config[k]))) return "config 数值非法";
    if (obj.thermal !== "unavailable") return "thermal 必须为 unavailable";
    return null;
  }

  function exportHistory() {
    const blob = new Blob([JSON.stringify(loadHistory(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "starbench-history.json"; a.click();
    URL.revokeObjectURL(a.href);
  }
  function importHistory(file) {
    if (!file) return;
    if (file.size > 1024 * 1024) { $("liveStatus").textContent = "导入失败：文件超过 1MiB"; return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const arr = Array.isArray(data) ? data : [data];
        const accepted = [];
        for (const item of arr) {
          const r = item && item.report ? item.report : item;
          const err = validateSchemaReport(r);
          if (err) { $("liveStatus").textContent = "导入失败：" + err; return; }
          accepted.push({ imported: true, at: new Date().toISOString(), report: r });
        }
        const h = loadHistory().concat(accepted).slice(0, 20);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
        renderHistory();
        $("liveStatus").textContent = `已导入 ${accepted.length} 条（未在本机验证）`;
      } catch (e) { $("liveStatus").textContent = "导入失败：JSON 解析错误"; }
    };
    reader.readAsText(file);
  }

  // ---- 初始化 ----
  runner = new SB.BenchRunner(renderer, { onStatus, onHud: setHud, onReport: renderReport, onContextRestored });
  runner.prepareIdle();

  // 空闲绘制（不采样）
  (function idle() {
    let last = performance.now();
    function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
      if (!runner.started) {
        runner.idleTick();
        renderer.draw(dt);
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();

  function canStart() {
    const chk = $("readyChk");
    return !chk || chk.checked;
  }
  function runStart(sustainedMs) {
    if (!canStart()) { $("liveStatus").textContent = "请先勾选「已完成开始前检查清单」"; return; }
    $("report").hidden = true;
    $("startBtn").disabled = true; $("stopBtn").disabled = false;
    $("sustain2Btn").disabled = true; $("sustain5Btn").disabled = true;
    runner.start(sustainedMs || 0);
  }
  $("startBtn").addEventListener("click", () => runStart(0));
  $("sustain2Btn").addEventListener("click", () => runStart(120000));
  $("sustain5Btn").addEventListener("click", () => runStart(300000));
  $("stopBtn").addEventListener("click", () => {
    runner.stop(); // 作废整轮
    $("startBtn").disabled = false; $("stopBtn").disabled = true;
    $("sustain2Btn").disabled = false; $("sustain5Btn").disabled = false;
    $("statusText").textContent = "已停止：本轮作废（停止即作废整轮），请重新开始";
    $("liveStatus").textContent = "已停止：本轮作废，请重新开始";
  });
  $("copyBtn").addEventListener("click", async () => {
    if (!lastReport) { $("liveStatus").textContent = "尚未跑分，无可复制内容"; return; }
    const text = JSON.stringify(SB.BenchRunner.toSchemaReport(lastReport), null, 2);
    try { await navigator.clipboard.writeText(text); $("copyBtn").textContent = "已复制 JSON ✓"; }
    catch (e) { $("copyBtn").textContent = "复制失败"; }
    setTimeout(() => { $("copyBtn").textContent = "复制报告 JSON"; }, 1500);
  });
  $("downloadBtn").addEventListener("click", () => {
    if (!lastReport) { $("liveStatus").textContent = "尚未跑分，无可下载内容"; return; }
    const text = JSON.stringify(SB.BenchRunner.toSchemaReport(lastReport), null, 2);
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "starbench-web-report.json"; a.click();
    URL.revokeObjectURL(a.href);
  });
  $("exportBtn") && $("exportBtn").addEventListener("click", exportHistory);
  $("importInput") && $("importInput").addEventListener("change", (e) => { importHistory(e.target.files[0]); e.target.value = ""; });

  // 初始按钮态：未跑分禁用
  $("copyBtn").disabled = true; $("downloadBtn").disabled = true;
  renderHistory();
})();
