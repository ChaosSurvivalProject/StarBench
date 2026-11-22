/* StarBench Web — 交互引导 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const canvas = $('gl');
  let renderer, runner, lastReport = null;

  try {
    renderer = new SB.WebGLRenderer(canvas);
  } catch (e) {
    const err = $('glError');
    err.hidden = false;
    err.textContent = 'WebGL 初始化失败：' + e.message + '。请使用支持 WebGL 的现代浏览器（Chrome / Edge / Firefox / Safari）。';
    return;
  }

  function fmt(n) { return Number(n).toLocaleString('zh-CN'); }

  const CIRC = 2 * Math.PI * 52; // 圆环周长

  function setHud(info) {
    $('hudPhase').textContent = info.phase || '--';
    $('hudFps').textContent = (info.fps || 0).toFixed(1) + ' FPS';
    $('hudWork').textContent = fmt(info.work || 0);
    if (info.countdown != null) {
      $('countdown').hidden = false;
      $('cdLabel').textContent = info.phaseLabel || info.phase || '';
      $('cdNum').textContent = info.countdown.toFixed(1);
      const remain = Math.max(0, Math.min(1, info.countdown / (info.countdownTotal || 1)));
      $('cdArc').style.strokeDashoffset = String(CIRC * (1 - remain));
    }
  }

  function hideCountdown() { $('countdown').hidden = true; }

  function onStatus(status, label, progress) {
    const names = {
      WARMUP: '预热中', COOLDOWN: '冷却判定', DONE: '完成',
      JAVA_RUN: 'Java 场景', BEDROCK_RUN: 'Bedrock 场景',
    };
    $('statusText').textContent = (names[status] || status) + (label ? ' · ' + label : '');
    $('progressBar').style.width = (progress || 0) + '%';
    if (status === 'DONE') {
      $('startBtn').disabled = false;
      $('stopBtn').disabled = true;
      hideCountdown();
    }
  }

  function renderReport(r) {
    lastReport = r;
    const rows = r.scores.map((s) => `
      <tr>
        <td>${s.edition === 'JAVA' ? 'Java' : 'Bedrock'}</td>
        <td class="hi">${s.peak}</td>
        <td>${s.average}</td>
        <td>${s.low1}</td>
        <td>${s.low01}</td>
        <td>${s.p99ms}</td>
        <td>${s.jank}%</td>
      </tr>`).join('');
    $('reportBody').innerHTML = `
      <table>
        <thead><tr><th>版本</th><th>峰值</th><th>平均</th><th>1% Low</th><th>0.1% Low</th><th>p99 ms</th><th>Jank</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <ul class="advice">${r.advice.map((a) => `<li>${a}</li>`).join('')}</ul>
      <div class="advice">不可用项：${r.unavailable.join('、')}</div>`;
    $('report').hidden = false;
  }

  runner = new SB.BenchmarkRunner(renderer, {
    onStatus,
    onHud: setHud,
    onReport: renderReport,
  });

  // 待机时也真实绘制预热世界
  (function idle() {
    let last = performance.now();
    function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      if (!runner.started && runner.world) {
        runner.world.tickEntities(dt, false);
        renderer.draw(dt);
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();

  $('startBtn').addEventListener('click', () => {
    $('report').hidden = true;
    $('startBtn').disabled = true;
    $('stopBtn').disabled = false;
    $('hudPhase').textContent = '预热';
    hideCountdown();
    runner.start();
  });
  $('stopBtn').addEventListener('click', () => {
    runner.stop();
    $('startBtn').disabled = false;
    $('stopBtn').disabled = true;
    $('hudPhase').textContent = '待机';
    hideCountdown();
    $('statusText').textContent = '已停止，可重新开始';
  });
  $('copyBtn').addEventListener('click', async () => {
    if (!lastReport) return;
    const text = JSON.stringify(lastReport, null, 2);
    try { await navigator.clipboard.writeText(text); $('copyBtn').textContent = '已复制 ✓'; }
    catch (e) { $('copyBtn').textContent = '复制失败'; }
    setTimeout(() => { $('copyBtn').textContent = '复制报告'; }, 1500);
  });
  $('downloadBtn').addEventListener('click', () => {
    if (!lastReport) return;
    const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'starbench-web-report.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
})();
