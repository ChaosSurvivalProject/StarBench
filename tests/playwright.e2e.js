/* StarBench Web — Playwright 场景截图回归 + 端到端流程校验
 * 运行：node tests/playwright.e2e.js（需先 npm i && npx playwright install chromium）
 * 校验：页面加载无 JS 报错、6 段报告生成、copy/download 按钮启用、作废路径、截图落盘。
 */
"use strict";
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = 8899;
const OUT = path.join(ROOT, "test-results");
fs.mkdirSync(OUT, { recursive: true });

function serve() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end("404"); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }).listen(PORT);
}

(async () => {
  const server = serve();
  const sysChromium = fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || sysChromium,
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERR " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE " + m.text().slice(0, 160)); });
  let fail = 0;
  const ok = (c, n) => { console.log((c ? "  PASS " : "  FAIL ") + n); if (!c) fail++; };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1200);
    const idle = await page.evaluate(() => ({
      hasRenderer: !!(window.SB && SB.WebGLRenderer),
      glError: !document.getElementById("glError").hidden,
      copyDisabled: document.getElementById("copyBtn").disabled,
    }));
    ok(idle.hasRenderer && !idle.glError, "WebGL 初始化成功且无错误层");
    ok(idle.copyDisabled, "未跑分时复制/下载按钮禁用");
    await page.screenshot({ path: path.join(OUT, "01-idle.png") });

    // checklist gate
    await page.click("#startBtn");
    await page.waitForTimeout(200);
    const gated = await page.locator("#liveStatus").textContent();
    ok(/检查清单/.test(gated), "未完成检查清单时拒绝开始");

    await page.check("#readyChk");
    await page.click("#startBtn");
    await page.waitForFunction(() => !document.getElementById("report").hidden, { timeout: 50000 });
    const rep = await page.evaluate(() => ({
      details: document.querySelectorAll("#reportBody details").length,
      copyDisabled: document.getElementById("copyBtn").disabled,
      hasScore: document.getElementById("reportBody").innerText.includes("综合分"),
      thermalUnavailable: document.getElementById("reportBody").innerText.includes("unavailable"),
    }));
    ok(rep.details === 6, "报告含 6 段明细");
    ok(!rep.copyDisabled && rep.hasScore, "报告生成后按钮启用、分数可见");
    await page.screenshot({ path: path.join(OUT, "02-report.png"), fullPage: true });

    // visibilitychange 作废路径
    await page.click("#startBtn");
    await page.waitForTimeout(4200);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => !document.getElementById("report").hidden, { timeout: 10000 });
    const inv = await page.evaluate(() => document.getElementById("reportBody").innerText);
    ok(/本轮作废/.test(inv) && /已作废/.test(inv), "visibilitychange 作废当前段且样本不计分");
    ok(errors.length === 0, "全程无 JS 报错" + (errors.length ? ": " + errors[0] : ""));
  } catch (e) {
    console.error("E2E FATAL", e.message); fail++;
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`E2E 结果：${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
