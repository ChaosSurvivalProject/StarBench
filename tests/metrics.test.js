/* StarBench Web — 指标单测（Node，零依赖）
 * 运行：node tests/metrics.test.js
 * 覆盖：百分位、1% Low 与 P99 自洽、refresh-capped 检测、样本不足标记、作废段不计分。
 */
"use strict";
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  PASS", name); } else { fail++; console.log("  FAIL", name); } }
function approx(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-6); }

global.window = global;
require("../js/scoring.js");
const F = SB.FrameStats, S = SB.Scoring;

console.log("== 百分位与 1% Low ==");
{
  const xs = Array.from({ length: 1000 }, (_, i) => 16.6 + (i % 3) * 0.1);
  const s = F.sorted(xs);
  ok(approx(F.percentile(s, 0.5), 16.7, 0.01), "P50 线性插值");
  ok(F.p99FrameMs(s) >= F.percentile(s, 0.5), "P99 >= P50");
  ok(approx(F.avgFps(xs), 1000 / F.meanMs(xs), 0.001), "avgFps 由平均帧时导出");
}
{
  const xs = Array.from({ length: 1000 }, () => 16.6);
  for (let i = 0; i < 10; i++) xs[i] = 100; // 最慢 1%
  const low1 = F.low1Fps(xs);
  ok(approx(low1, 10, 0.01), "1% Low = 100/平均慢帧时间 = 10 FPS");
  const cmp = F.low1VsP99(xs);
  ok(cmp.relDiff < 0.15, "1% Low 与 1000/P99 自洽（相对差 <15%）: " + cmp.relDiff);
  ok(F.stutterCount(xs, 50) === 10, "卡顿帧(>50ms)计数 = 10");
}

console.log("== refresh-capped 检测 ==");
{
  const pure60 = Array.from({ length: 300 }, (_, i) => 16.666 + Math.sin(i) * 0.01);
  const c60 = F.detectRefreshCap(pure60);
  ok(c60.capped && c60.hz === 60, "纯 60Hz 标记为 refresh-capped(60)");
  const varied = Array.from({ length: 300 }, (_, i) => 12 + Math.abs(Math.sin(i * 1.7)) * 20);
  const cv = F.detectRefreshCap(varied);
  ok(!cv.capped, "高方差不误判为 capped");
}

console.log("== 样本不足与作废 ==");
{
  const seg = S.makeSegment({ frameTimeMs: [16, 17, 18], tickMs: [5], meshMs: [1] },
    { name: "java/s1", warmupMs: 1600, discardedWarmupFrames: 96, durationMs: 2600,
      chunksProcessed: 10, entityUpdates: 0, validity: { status: "valid", void_reasons: [] } });
  ok(seg.sample_insufficient === true, "sample_count<300 标样本不足");
  ok(seg.discarded_warmup_frames === 96, "报告写入预热丢弃帧数");
  const invalid = S.makeSegment({ frameTimeMs: [], tickMs: [], meshMs: [] },
    { name: "java/s2", warmupMs: 1600, durationMs: 2600, chunksProcessed: 0, entityUpdates: 0,
      validity: { status: "invalid", void_reasons: ["页面切到后台"] } });
  ok(invalid.validity.status === "invalid" && invalid.sample_count === 0, "作废段 0 样本");
  const score = S.computeScore([seg, invalid], { drawing_buffer: "1280x720" });
  ok(score.sim > 0 && score.render > 0, "有效段仍参与计分");
  ok(S.computeScore([invalid], { drawing_buffer: "1280x720" }).total === 0, "全作废段 total=0");
}

console.log("== 分数版本与几何平均 ==");
{
  ok(/^[0-9a-f]{8}$/.test(S.WORKLOAD_HASH), "workload_hash 为 8 位十六进制");
  ok(S.SCORE_VERSION === "1.0" && S.BENCHMARK_VERSION === "0.5.0-web", "版本字段正确");
  const segs = ["java/s1", "java/s2"].map((name) => S.makeSegment(
    { frameTimeMs: Array.from({ length: 400 }, (_, i) => 12 + (i % 5)), tickMs: [5], meshMs: [1] },
    { name, warmupMs: 1600, durationMs: 2600, chunksProcessed: 500, entityUpdates: 200, validity: { status: "valid", void_reasons: [] } }));
  const sc = S.computeScore(segs, { drawing_buffer: "1280x720" });
  const gmCheck = Math.pow(sc.sim * sc.stability * sc.render * Math.pow(1, 3), 1 / 3);
  ok(sc.formula.includes("几何平均") || sc.formula.includes("GM"), "公式声明几何平均");
  ok(sc.total > 0 && isFinite(sc.total), "综合分为有限正数: " + sc.total);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
