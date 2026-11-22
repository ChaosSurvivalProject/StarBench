/* StarBench Web — 采集与计分（与 APK 同口径）
 * 帧耗时来自真实 requestAnimationFrame 间隔；浏览器无 CPU 占用/电池温度/ADPF/Thermal API，
 * 一律标记 unavailable，不伪造、不锁频、不对抗温控。
 */
(function (global) {
  "use strict";
  const SB = (global.SB = global.SB || {});

  const FrameStats = {
    harmonicMeanFps(ns) {
      if (!ns.length) return 0;
      let sum = 0;
      for (const v of ns) sum += Math.max(1, v);
      return 1e9 / (sum / ns.length) * (ns.length / ns.length); // = 1e9/平均帧时
    },
    lowPercentFps(ns, pct) {
      if (!ns.length) return 0;
      const sorted = Array.from(ns).sort((a, b) => b - a); // 降序：最慢在前
      const k = Math.max(1, Math.ceil(sorted.length * pct / 100));
      let sum = 0;
      for (let i = 0; i < k; i++) sum += sorted[i];
      return 1e9 / (sum / k);
    },
    p99FrameNs(ns) {
      if (!ns.length) return 0;
      const s = Array.from(ns).sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * 0.99))];
    },
    jankRate(ns, budgetNs) {
      if (!ns.length) return 0;
      let j = 0;
      for (const v of ns) if (v > budgetNs) j++;
      return j / ns.length;
    },
    // 剔除升温前窗口：取前 60s 内、排除最热尾段的最佳 1s 窗口峰值
    bestWindowFps(ns) {
      if (ns.length < 30) return ns.length ? 1e9 / (ns.reduce((a,b)=>a+b,0)/ns.length) : 0;
      let best = -Infinity;
      for (let i = 0; i + 30 <= Math.min(ns.length, 3600); i++) {
        let s = 0;
        for (let j = i; j < i + 30; j++) s += ns[j];
        const fps = 1e9 / (s / 30);
        if (fps > best) best = fps;
      }
      return best;
    },
  };
  SB.FrameStats = FrameStats;

  // 每个场景由 64×64 区块构成；chunks 为边长区块数，view/sim 距离按 ref 分离。
  // mobCap 按 creature cap 随区块数缩放（ref §四），并放大以形成真实压力。
  const EditionConfig = {
    JAVA: {
      label: 'Java Edition',
      cases: [
        { label: '视距 3 · 低负载 · 4 区块', chunks: 2, height: 48, mobCap: 30, viewDist: 3, simDist: 3, rebuild: 3 },
        { label: '视距 4 · 中负载 · 9 区块', chunks: 3, height: 56, mobCap: 54, viewDist: 4, simDist: 4, rebuild: 4 },
        { label: '视距 5 · 高负载 · 16 区块', chunks: 4, height: 64, mobCap: 84, viewDist: 5, simDist: 5, rebuild: 6 },
      ],
    },
    BEDROCK: {
      label: 'Bedrock Edition',
      cases: [
        { label: '模拟距离 4 · 低负载 · 4 区块', chunks: 2, height: 48, mobCap: 28, viewDist: 4, simDist: 4, rebuild: 3 },
        { label: '模拟距离 8 · 中负载 · 9 区块', chunks: 3, height: 56, mobCap: 50, viewDist: 8, simDist: 6, rebuild: 4 },
        { label: '模拟距离 12 · 高负载 · 16 区块', chunks: 4, height: 64, mobCap: 78, viewDist: 12, simDist: 8, rebuild: 6 },
      ],
    },
  };
  SB.EditionConfig = EditionConfig;

  function score(edition, frames) {
    const avg = FrameStats.harmonicMeanFps(frames.avg || []);
    const onePct = FrameStats.lowPercentFps(frames.peak || [], 1.0);
    const peak = FrameStats.bestWindowFps(frames.peak || []);
    return {
      edition,
      peak: +peak.toFixed(1),
      average: +avg.toFixed(1),
      low1: +onePct.toFixed(1),
      low01: +FrameStats.lowPercentFps(frames.peak || [], 0.1).toFixed(1),
      p99ms: +(FrameStats.p99FrameNs(frames.avg || []) / 1e6).toFixed(2),
      jank: +(FrameStats.jankRate(frames.avg || [], 16666666) * 100).toFixed(2),
      frames: (frames.avg || []).length + (frames.peak || []).length,
    };
  }

  function advice(scores) {
    const out = [];
    for (const s of scores) {
      if (s.low1 < 30) out.push(`${s.edition}：1% Low 仅 ${s.low1} FPS，掉帧明显，建议降低视距/模拟距离或实体密度。`);
      else if (s.jank > 5) out.push(`${s.edition}：Jank ${s.jank}% 偏高，存在周期性卡顿，建议检查后台负载。`);
      else out.push(`${s.edition}：帧时间稳定，${s.average} FPS 平均表现良好。`);
      if (s.peak - s.average > 25) out.push(`${s.edition}：峰值 ${s.peak} 与平均 ${s.average} 差距大，存在明显负载波动。`);
    }
    out.push('温控：浏览器环境无法读取 SoC 结温 / thermal headroom，未做提频或绕过温控，相关项不可用。');
    out.push('视觉：本页为自绘体素场景，用于等效负载测试，非《我的世界》官方客户端，未宣称 1:1 还原。');
    return out;
  }

  SB.Scoring = { score, advice };
})(typeof window !== "undefined" ? window : globalThis);
