# 验收清单（v0.5.0-web）

逐条可勾选。对应任务书「验收标准」。

## 测量可信度
- [x] 同一设备、同浏览器、同配置连跑 3 次，综合分波动可解释，报告中带 `sample_count`（本地 3 次短跑已观察：软件渲染下 7–9 FPS 段，波动来自软件光栅化，均标样本不足）
- [x] 跑分中切到后台再切回，对应段标 `invalid` 且样本不进入分数（Playwright 单测 + e2e 均通过）
- [x] 60Hz 设备上识别并标记 refresh-capped，不把 60 FPS 当硬件上限结论（`detectRefreshCap` + 文案）
- [x] 页面任意位置不出现「过热/降频诊断」结论，温度字段恒 `unavailable`（合规区 + schema `thermal:"unavailable"`）
- [x] 1% Low 由逐帧 `frameTimeMs` 导出，与 P99 自洽（`1000/p99FrameMs === low1Fps`，单测验证）
- [x] 导出 JSON 可被导入校验通过，跨 `benchmark_version` 的分数被拒绝比较（导入严格字段校验 + 版本随 hash bump）
- [x] 预热帧被丢弃并在报告写明丢弃帧数（`discarded_warmup_frames`，UI 明细可见）
- [x] 六个场景同种子、同分辨率、同 2.6s 时长，仅调度剖面不同（`SCENARIOS` × `PROFILES`）
- [x] 无任何官方资源引用、无网络上报、无设备权限请求（Faithful/22i 为开源社区资产，纯静态零后端）

## 工程与合规
- [x] 单页静态站点、零后端、零账号；WebGL2 优先 + WebGL1 回退说明
- [x] CPU 模拟放 Worker 与渲染解耦（transferable mesh）
- [x] 保留并补强「温度告知与合规声明」区块；Apache-2.0 与署名未改
- [x] README 含方法论/模块清单/剖面人为构造说明/分数公式权重/已知偏差/版本策略/复现/商标声明
- [x] CHANGELOG.md、report.schema.json + 示例报告、issue 模板（强制 JSON）
- [x] CI：Playwright 截图回归 + schema 校验 + 百分位/1% Low 单测 + visibilitychange 作废单测 + 刷新率封顶单测
- [x] 依赖最小化 + lockfile + 一键本地运行命令

## 一键本地验证
```bash
cd StarBenchWeb
npm ci                       # 测试依赖（含 lockfile）
npm test                     # 指标单测（17 项）
python3 -m http.server 8899  # 另开终端：本地站点
# 浏览器打开 http://localhost:8899/，勾选检查清单后开始
npx playwright install chromium --with-deps && npm run test:e2e   # 端到端 + 截图
```
