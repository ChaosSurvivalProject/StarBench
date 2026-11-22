# StarBench Web · 星穹旅驿等效负载在线跑分

> 打开网页即可在线跑分的 Web 版，与 [Android 版 APK](https://github.com/ChaosSurvivalProject/StarBench/releases/tag/v0.2.0-android9) 共用同一套「真实计算 + 三套计分 + 诚实边界」口径。
>
> **在线地址**：<https://chaos-survival-project.github.io/StarBench/>
>
> **v0.4.0（当前）**：世界升级为 **64×64 区块**，加入**确定性群系 + pack 刷怪 + mob cap + 16³ 区块段重建**，并接入 [22i 的 1:1 Minecraft 生物体素模型（GPL-3.0）](https://github.com/22i/minecraft-voxel-blender-models)——牛、猪、羊、鸡、狼按群系生成、带 UV 贴图与步态动画，压力显著提升。
>
> **v0.3.0**：画面材质升级为 [Faithful 64x](https://faithfulpack.net) 开源贴图（64×64 方块纹理，草/叶/水按 Minecraft 生物群系 colormap 着色），与 Android APK 同步更新。3D 场景与 2D 显示画布使用同一套材质。

## 它是什么

一个**真实运行的 WebGL 体素引擎跑分页**，不是图片轮播、不是预录视频、不是随机数/sleep 伪造负载：

- **真实体素世界**：确定性噪声地形、天空光 BFS 传播、实体逐帧推进、逐面剔除网格构建，全部在浏览器里逐帧计算。工作量随视距场景增长（实测小世界约 5 万 → 大世界约 16 万运算计数）。
- **真实渲染**：WebGL 1.0 从当帧网格绘制，固定运镜脚本，采用 **Faithful 64x 开源材质**（离屏烘焙成 4×3 图集，叶片 alpha 镂空），天空与距离雾。渲染结果每帧拷贝到一个可见的 2D 显示画布，规避部分浏览器/GPU 上 WebGL 画布不参与页面合成导致"看不到画面"的问题。3D 场景与 2D 显示用的是同一套 Faithful 材质。
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
| `js/voxel.js` | 体素引擎：64×64 区块、群系噪声、天空光、pack 刷怪、16³ 段重建、面剔除网格 |
| `js/mobdata.js` | 22i 生物模型数据（顶点/UV/三角形，GPL-3.0） |
| `js/textures.js` | Faithful 方块图集 + 动物图集加载（异步 + 纹理重传） |
| `textures/atlas64.png` | Faithful 64x 方块贴图烘焙图集（256×192） |
| `textures/mobatlas.png` | 22i 生物 UV 贴图烘焙图集（256×64，GPL-3.0） |
| `js/renderer.js` | WebGL 1.0 渲染器：地形 + 动物两套程序、相机、雾、绘制 |
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

## 第三方材质署名

本项目渲染画面使用了 [Faithful 64x](https://faithfulpack.net) 资源包中的方块贴图（草、泥土、石头、橡木、树叶、水、沙子）。Faithful 是开源社区项目，依据 [Faithful License](THIRD_PARTY_LICENSES.txt) 使用。材质取自官方仓库 [Faithful-Resource-Pack/Faithful-Java-64x](https://github.com/Faithful-Resource-Pack/Faithful-Java-64x)，草顶/树叶/水在原灰度贴图上按 Minecraft 生物群系 colormap 着色。本项目非 Mojang / Microsoft 官方产品，未获其授权或认可。

### 动物模型署名（GPL-3.0）

牛、猪、羊、鸡、狼的体素模型来自 [22i/minecraft-voxel-blender-models](https://github.com/22i/minecraft-voxel-blender-models)（**GPL-3.0**）。真实 `.b3d` 模型的顶点 / UV / 三角索引经导出烘焙为 `js/mobdata.js` + `textures/mobatlas.png`。该模型是社区 1:1 复刻（Mineclonia / MineClone2 生物模型同源），**非 Mojang / Microsoft 官方美术**。依据 GPL-3.0，保留原版权声明与许可全文（见 `THIRD_PARTY_LICENSES.txt`），源码见上方 Source URL。

## 许可

站点代码 Apache-2.0 · ChaosSurvivalProject；Faithful 64x 与 GPL-3.0 动物模型的第三方许可见 `THIRD_PARTY_LICENSES.txt`。

---

# 方法论（v0.5.0-web）

> **定位**：StarBench 不是《我的世界》跑分器，而是**仿照 MC 运算过程的等效负载生成器**。它用自写的体素世界结构、自写噪声、自写网格、自绘贴图图集，复现 MC 的**运算形态**（CPU 侧世界模拟 + 区块网格重建 + 体素渲染）；只宣称「浏览器内等效负载观察值」，**不宣称 1:1 还原、不预测 MC 真实帧率、不与 3DMark/安兔兔/原生客户端分数互换**。

## 1. 负载模块清单与计时点

世界数据层：`16×16 区块 × 16 高分段`、`palette + BlockState 索引`、`heightmap`、简化生物群系枚举、确定性噪声（无 `Math.random`）。`nbtRoundTrip()` 做简化 NBT 风格序列化/反序列化，只测「加载/解码」开销，不读取任何真实存档。

每个模拟 tick（目标 20 TPS / 50ms 预算，剖面可调）拆成七个**可独立计时、可独立开关**的模块，耗时记为 `moduleMs`：

| 模块 | 对应运算形态 | 计时点 |
|---|---|---|
| 1 区块流转 `streaming` | 加载/卸载与生成任务提交 + 光照 BFS | `mod_streaming` / `propagateLight` |
| 2 `randomTick` | 作物生长/草蔓延/冰融化/火蔓延（简化为确定性状态变化） | `mod_randomTick` |
| 3 `scheduledTick` | 计划刻：红石信号 + 流体流动 | `mod_scheduledTick` |
| 4 `blockEntity` | 方块实体 tick | `mod_blockEntity` |
| 5 `entity` | 碰撞 + 简化 A* 寻路 + AI 状态机 + 视野内实体更新 | `mod_entity` |
| 6 `meshing` | 脏标记 → chunk meshing：面剔除 + greedy 合批 | `mod_meshing` / `buildMesh` |
| 7 `renderSubmit` | 视锥剔除 + draw call 合批 + 图集 + 透明排序 | 渲染器 `draw()` 内计时 |

## 2. 两个剖面的「人为构造」说明

- **Java 剖面**：`tickHz=20`，每 tick 工作量大，模拟单主线程串行 tick、光照同步提交的压力。
- **Bedrock 剖面**：`tickHz=40`，每 tick 工作量小、mesh 分片更多，模拟任务分片更细、tick 与渲染解耦的压力。

**两侧使用同一种子 `20261122`、同样 3 个场景、同一 drawing buffer、同一 2.6s 时长，只有调度剖面（tickHz 与模块 scale）不同**。这是**人为构造的负载剖面差异**，不代表两个官方引擎的真实架构对比。

三个场景分别压不同环节：
- **S1 静态世界**：区块生成 + 光照 + meshing 吞吐 → 单位 `chunks/s`
- **S2 高动态**：randomTick + 计划刻（红石/流体）+ 方块实体密集更新 → 单位 `ticks/s`
- **S3 实体密集**：寻路 + 碰撞 + AI + 视野剔除 + 合批渲染 → 单位 `entity-updates/s`

## 3. 测试流程与计时口径

| 阶段 | 时长 | 处理 |
|---|---|---|
| 预热 / 构建世界 | 1.6s | 编译着色器、生成首批区块、填满 meshing 队列；**预热帧全部丢弃并在报告写明丢弃帧数** |
| Java S1/S2/S3 | 3×2.6s | 逐帧采样 |
| 回落观测窗口 | 1.2s | 原名「冷却判定」，易误解为能诊断温控；**FPS 变化可能来自温控、省电、后台任务、驱动或浏览器调度，本页不作诊断** |
| Bedrock S1/S2/S3 | 3×2.6s | 逐帧采样 |
| **总计** | **18.4s** | UI 显示总进度 + 当前段名 + 逐段倒计时 |

另有可选「持续观测模式」2–5 分钟，用于看趋势，**不产出跨设备分数**。

**样本充分性**：单段 2.6s 在 60Hz 下约 156 帧，最慢 1% 仅 1–2 帧；任何 `sample_count < 300` 的结果标「样本不足，仅供参考，不用于跨设备比较」。

## 4. 指标定义

- 计时一律 `performance.now()` / rAF 时间戳，**禁止 `Date.now()` 与 `setInterval` 计时**；逐帧 `frameTimeMs` 写入**预分配 TypedArray + 对象池**，避免每帧分配导致 GC 假卡顿；每帧不做字符串拼接/DOM 写入，UI ≤5Hz 节流。
- **1% Low**：`1000 / 最慢1%帧时间均值`，与 P99 帧时间严格自洽（`1000/p99FrameMs === low1Fps`），报告给出 `sample_count`。
- **峰值**降级为诊断字段，标注「单帧最快值，统计脆弱，受刷新率上限约束」，不作为主分数。
- **refresh-capped**：FPS 贴近 60/120/144 且帧时间变异系数 CV 极小 → 标「受呈现同步上限约束，无区分力」，建议提高内部渲染分辨率或每帧像素成本。
- **作废**：`visibilitychange` 隐藏、WebGL context lost、resize、DPR 变化、设备休眠恢复（rAF 间隔 >1000ms）→ 当前段标 `invalid`、丢弃样本、整轮不作废的段也不进入跨设备比较。

## 5. 分数公式与权重

```
sim        = GM( chunks_per_s + 0.01 × entity_updates_per_s )      # 各有效段几何平均
stability  = GM( max(0.01, low1_fps / avg_fps) )                   # 帧稳定性比
render     = GM( avg_fps )                                         # 渲染吞吐
resCoeff   = (1280×720 / actualPixels)^0.15
total      = GM( sim, stability, render ) × resCoeff
```

三维**等权几何平均**（禁止线性相加）；分辨率系数做温和补偿。分数带 `benchmark_version`、`score_version`、`workload_hash`，**任一场景/公式变更即 bump 版本，跨版本分数显式标记不可比**。

## 6. 已知偏差

- 浏览器无 GPU 计时扩展时无法测真实 GPU 时间；`renderSubmit` 是 JS 提交耗时，不是 GPU 执行时间。
- 软件渲染（SwiftShader/llvmpipe）下分数受软件光栅化瓶颈主导，不具跨设备区分力，页面会明确提示。
- refresh_hz 在无 `WEBGL_debug_renderer_info` 时由预热 rAF 间隔估计，可能不准；refresh-capped 另有独立检测。
- 温度/频率/风扇/电源状态浏览器不可读，恒 `unavailable`；不使用 FPS 反推温控。

## 7. 版本策略与复现流程

- `benchmark_version` 随负载/场景/引擎变更 bump；`score_version` 随计分公式变更 bump；`workload_hash` 由配置序列化后 FNV-1a 得出，配置一变即变。
- 复现：同一设备、同浏览器、同分辨率、同版本，勾选检查清单后连跑 2–3 次取中位数与波动范围；切后台会导致该段作废，需重跑。

## 8. 合规与商标声明

浏览器无法读取 SoC 结温/thermal headroom/频率/风扇，相关字段恒 `unavailable`；不锁频、不提频、不对抗温控；不请求任何设备权限、不读取传感器、不做长时间高负载折磨测试；提供随时停止与自动结束。纯本地运行，不上传逐帧数据、无账号、无排行榜。引擎为 clean-room 自实现，美术来自开源社区（Faithful / 22i），非 Mojang/Microsoft 官方产品。**Minecraft / Java Edition / Bedrock Edition 名称仅作负载剖面描述，商标归 Mojang/Microsoft 所有，本项目与其无关联。**
