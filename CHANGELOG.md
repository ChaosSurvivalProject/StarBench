# Changelog

本项目所有重要变更记录于此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.5.0-web] - 2026-11-22

### 新增
- CPU 模拟迁入 **Web Worker**（`js/sim.worker.js`），主线程只做 WebGL 渲染与逐帧 `frameTimeMs` 采集，两者解耦；网格用 transferable ArrayBuffer 回传。
- 世界数据层对齐 MC 运算形态：**16×16 区块分区 + 16 高分段**、**palette + BlockState 索引**、**高度图**、**简化 NBT 序列化/反序列化**（测加载解码开销）。
- 七个可独立计时/开关的 tick 模块：区块流转、randomTick、scheduledTick（红石/流体）、方块实体、实体（碰撞 + 简化 A* + AI + 视野）、meshing（面剔除 + greedy 合批）、渲染提交。
- **刷新率封顶检测**（FPS 贴近 60/120/144 且 CV 极小 → 标记无区分力）、**样本不足标记**（sample_count<300）、**作废段机制**。
- **分维度分数**：模拟吞吐 / 帧稳定性 / 渲染吞吐 + 综合分（三维等权几何平均 × 分辨率系数）；带 `benchmark_version / score_version / workload_hash`。
- 定版报告 schema v1.0（`schema/report.schema.json`）+ 示例报告；复制/下载内容字段严格一致。
- 本地历史（≤20 条）、导出/导入（1MiB + 严格字段与有限数校验，外部导入标「未在本机验证」）。
- 开始前检查清单、持续观测模式（2/5 分钟，不产出跨设备分数）、帧时间曲线（预分配缓冲 5Hz）。
- WebGL2 优先 + WebGL1 回退；`prefers-reduced-motion`、触摸目标 ≥44px、`aria-live` 状态播报。
- 单测 `tests/metrics.test.js`、GitHub Actions `web-ci.yml`、issue 模板（强制附 JSON 报告）、本 CHANGELOG。

### 变更
- 流程统一为：预热/构建世界 1.6s（丢弃帧并计数）→ Java S1/S2/S3 各 2.6s → 回落观测窗口 1.2s → Bedrock S1/S2/S3 各 2.6s = **18.4s**；原「冷却判定」改名「回落观测窗口」并注明不作温控诊断。
- 两个剖面使用**同种子/同场景数/同分辨率/同时长**，仅 tickHz 与模块分片不同；明确声明是人为构造的调度剖面差异，非官方引擎架构对比。
- 1% Low 定义写死为 `1000 / 最慢1%帧时间均值`，与 P99 严格自洽；**峰值降级为诊断字段**，不再作为主分数。
- 「停止」语义明确为作废整轮。
- 计时一律 `performance.now()` / rAF 时间戳；`visibilitychange` 隐藏、context lost、resize、DPR 变化、休眠恢复均作废当前段并丢弃样本。

### 保留
- Faithful 64x 方块贴图、22i GPL-3.0 动物模型及署名、Apache-2.0 主体许可、「温度告知与合规声明」区块（在原精神上补强）。

## [0.4.0-web] - 2026-11-22

- 世界升级为 64×64 区块，加入确定性群系 + pack 刷怪 + mob cap + 16³ 段重建；接入 22i 的 1:1 生物模型。

## [0.3.0-web] - 2026-11-22

- 材质升级为 Faithful 64x 开源贴图，3D 与 2D 显示画布共用同一套材质。

## [0.2.0-web] - 2026-11-22

- 首个在线跑分版：WebGL 体素引擎 + 三套计分（峰值/平均/1% Low）。
