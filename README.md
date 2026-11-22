# StarBench Web · 星穹旅驿等效负载在线跑分

> 打开网页即可在线跑分的 Web 版，与 [Android 版 APK](https://github.com/ChaosSurvivalProject/StarBench/releases/tag/v0.2.0-android9) 共用同一套「真实计算 + 三套计分 + 诚实边界」口径。
>
> **在线地址**：<https://chaos-survival-project.github.io/StarBench/>

## 它是什么

一个**真实运行的 WebGL 体素引擎跑分页**，不是图片轮播、不是预录视频、不是随机数/sleep 伪造负载：

- **真实体素世界**：确定性噪声地形、天空光 BFS 传播、实体逐帧推进、逐面剔除网格构建，全部在浏览器里逐帧计算。工作量随视距场景增长（实测小世界约 5 万 → 大世界约 16 万运算计数）。
- **真实渲染**：WebGL 1.0 从当帧网格绘制，固定运镜脚本，程序化自产贴图图集（无任何官方美术资源），天空与距离雾。
- **真实采集**：帧耗时来自 `requestAnimationFrame` 真实间隔。
- **一键流程**：预热 → Java 三场景 → 冷却判定 → Bedrock 三场景 → 报告。
- **三套独立计分**：峰值窗口 / 调和平均 / 1% Low，另附 0.1% Low、p99、Jank 率与分版本改进建议；报告可在页面复制或下载 JSON。

## 与 APK 一致的三条诚实边界

1. **非官方、非 1:1**：自绘体素场景用于等效负载测试，**不是《我的世界》官方客户端**，未宣称达到 1:1 还原验收，不含任何 Mojang/Microsoft 美术或商标资源。
2. **平台能力限制**：浏览器无法读取 SoC 结温 / thermal headroom，也没有 ADPF `PerformanceHintManager`。这些项一律标 `unavailable`，**不锁频、不提频、不对抗温控**。
3. **读数受环境影响**：切换到后台会被浏览器降帧；软件渲染（无 GPU）环境分数会明显偏低。分数用于同机同条件相对比较，不是跨设备绝对性能背书。

## 技术构成

纯静态站点，零运行时依赖、零构建步骤：

| 文件 | 职责 |
|---|---|
| `index.html` | 页面结构：画布、HUD、告知卡、报告 |
| `css/style.css` | 响应式布局与深色主题 |
| `js/voxel.js` | 体素引擎：地形/光照/实体/面剔除网格 |
| `js/textures.js` | 程序化贴图图集（4×3，12 瓦片） |
| `js/renderer.js` | WebGL 1.0 渲染器：着色器、相机、雾、绘制 |
| `js/scoring.js` | 计分口径与改进建议 |
| `js/bench.js` | 一键状态机 |
| `js/main.js` | 交互与报告导出 |

## 本地运行

```bash
cd StarBenchWeb
python3 -m http.server 8899
# 浏览器打开 http://localhost:8899/
```

需要支持 WebGL 的现代浏览器（Chrome / Edge / Firefox / Safari）。若 WebGL 不可用，页面会显示明确提示而非静默失败。

## 验证记录

- 6 个 JS 文件全部通过 `node --check` 语法检查。
- Node 功能测试：引擎工作计数随世界规模 52,709 → 163,193 增长，网格顶点 25,992 → 75,108；计分口径验证：1000 帧含 10 帧 100ms → 平均 59.4 FPS、1% Low 10 FPS、Jank 1%。
- Chromium + WebGL 端到端：六场景流程走完，进度 8%→100%，报告正常生成，控制台无错误、无 404。
- 像素采样 + canvas 导出：确认体素地形（草地/泥土/树叶/树木/天空）真实绘制，无异常色块。

## 许可

Apache-2.0 · ChaosSurvivalProject
