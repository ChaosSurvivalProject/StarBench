# 架构与关键取舍说明

> 对应需求提示词**第十四节**要求的四点必答。本文是设计说明；具体到「权威资料不足」的细节一律标 `待验证 / 设计建议`，不冒充官方数值。

---

## 1. 两套引擎如何真分离（逻辑与画面各自独立基线）

**分离不是靠一个 `if (edition)` 开关，而是靠类型系统 + 独立实现 + 独立基线三层约束。**

### 1.1 类型层：统一契约，独立实现

`EditionEngine` 只是一个契约接口，强制两套引擎**各自**实现六个真方法：

```kotlin
interface EditionEngine {
    val edition: Edition                 // JAVA / BEDROCK
    fun tick(ctx: TickContext): TickResult
    fun chunkSchedule(ctx: ChunkContext): ChunkResult
    fun lighting(ctx: LightingContext): LightingResult
    fun redstone(ctx: RedstoneContext): RedstoneResult
    fun entityAI(ctx: EntityContext): EntityResult
    fun networkSync(ctx: NetworkContext): SyncResult
    fun worldState(): WorldState          // 供渲染层读取的同一份世界状态
}
```

编排层只持有 `List<EditionEngine>`，通过注册得到 `JavaEditionEngine` 与 `BedrockEditionEngine` 两个实例，**分别对各自实例驱动完整 run**。编译期就没有「一个引擎切两个模式」的路径。

### 1.2 规则层：两套独立规则包，取值范围不互用

| 维度 | Java | Bedrock |
|---|---|---|
| Tick | 单主线程 20 TPS | C++ 风格多线程，P-Tick / C-Tick 双相双缓冲 |
| 模拟距离 | 5–32，默认 12，随时可改、全局共享 | 偶数 4–12，默认 4，按世界保存、加载中不可改 |
| 渲染距离 | 与模拟距离关联度更高 | 与模拟距离**解耦**，可见但不 tick 的区块允许存在 |
| Tick 区 | `(2s+1)²` 方阵 + 外一圈红石/流体/作物 | 曼哈顿/方形，无常驻出生区块 |
| 网络 | TCP + VarInt 同构帧 | UDP + RakNet 风格可靠层（仅同构编码，不接官方服务） |

两套规则包分别以 `data class` + 资源文件承载，带 `provenance` 字段（来源 / 是否待验证）。**任何共享的只有接口与数据结构定义，没有共享的逻辑实现。**

### 1.3 画面层：两份独立 `VisualParitySpec`

`VisualParitySpec` 带 `edition` 字段，Java 与 Bedrock 各自维护一份基线，逐维度（贴图/几何/光照/群系/实体/流体红石/UI/版本差异）描述并对齐。**禁止用一份基线通吃两个版本**——例如叶片透明、天空与光照平滑、雾、VSync 观感在两版本表现不同，分别写入各自 spec。CI 校验两份 spec 的 `edition` 与资源包哈希都与引擎匹配。

### 1.4 产物层：两套指标 / 分数 / 报告 / 建议

`RunResult` 按 `edition` 分文件中式存储，`ScoreCard`、`AdviceReport`、`BenchmarkReport` 全部带 `edition` 维度。报告提供并排对比页，但**不出合并总分**——评分层根本没有 `combinedScore` 字段。

---

## 2. 峰值 / 平均 / 1% Low 三套计分口径与温控如何只观测不对抗

### 2.1 三套分分开计算、分开显示、分开计分

| 指标 | 口径 | 代码入口 |
|---|---|---|
| **峰值性能** | 全程**未触发温控降频**的窗口内，取最佳连续窗口（如 60s）的平均 FPS / 最低 tick ms / 最高区块吞吐，并标注该窗口温度与均频；**禁止拿冷机第一帧当峰值** | `scoring.PeakScore` |
| **平均（持续）性能** | 热身结束后正式期全程的**调和平均 FPS** 与平均帧时间、平均 tick ms，标注热稳态温度与均频 | `scoring.SustainedScore` |
| **1% Low** | 所有帧生成时间降序取最慢 1% 样本的平均，换算 FPS；同时给 0.1% Low、p99 帧时间、Jank 率（>2×目标帧预算的帧占比） | `scoring.LowPercentScore` |

三者是 `ScoreCard` 中**三个独立字段**，UI 分三块展示，报告分三张表。任何「一个总分」的聚合在类型上不存在。

### 2.2 温控：只观测，不对抗

- **观测**：`Thermal API` 同时读当前状态与 `forecastSeconds=10` 预测（部分厂商提前 3–5 秒）；返回 `NaN` 标 `unavailable`。记录热状态时间线与频率曲线。
- **顺势调度**：`PerformanceHintManager.createHintSession` 传入长期存活的渲染 / 逻辑线程 id 与目标时长（纳秒），用 `reportActualWorkDuration` **按真实帧耗时**上报，`updateTargetWorkDuration` 对齐帧预算；渲染器同步调整帧预算才使提示生效。
- **明确禁止**：忙等提频、空转烧机、手动锁频、绑核 / affinity、绕过温控、root 提权。这些在代码中既无实现也无开关。
- **承认温控是设备固有属性**：`thermalDrop = (峰值 − 持续) / 峰值 × 100%`，把跌幅本身作为**诊断信号**喂给建议层，而不是试图消灭它。

> 关键取舍：`PerformanceHintManager` 是「请系统按真实负载给算力」，属于合法协作；锁频 / 绑核是「强行改写系统调度」，属于对抗。二者严格区分。

---

## 3. 如何在满足「1:1 还原」硬验收的同时守住授权边界

这是本工程最重要的合规设计。**画面 1:1 与资产来源合规是两条正交的轴**：1:1 指「视觉与运算规则对齐」，不等于「用了官方文件」。

### 3.1 路径 A（默认）：clean-room 独立重绘逐项对齐

- 以**公开可观测的视觉规范**为依据（方块贴图网格结构、光照等级、雾随视距衰减、昼夜曲线、群系配色等），自行绘制贴图 / 模型 / 调色板 / 动画，做到视觉 1:1。
- `VisualParitySpec` 逐维度记录基线描述 + 资源包哈希 + `provenance`（来源、是否待验证）。开发期用并排截图、关键帧差异、调色板 / 网格 / 雾衰减曲线 / 昼夜亮度曲线核对。
- 每个资源文件带**创作记录**（`assets/packA/CREATION_LOG.md`），证明自产。
- 发布包内含**非官方声明**：「独立实现，视觉规范对齐，非 Mojang / Microsoft 官方产品，未获其授权或认可」。

### 3.2 路径 B（需授权）：`AssetPack` 接入与凭证门禁

- `AssetPack` 是可切换资源层接口：`open()` 返回一个资源句柄；切换 A ↔ B **只替换资源，不改变世界状态与工作量计数**（同种子同参数 tick / 区块 / 实体计数零差，由 CI 校验）。
- 路径 B 的启用受 `AuthorizationGate` 门禁：构建环境必须持有书面授权凭证编号，写入 `system.json` 与构建产物；`AssetPackMode.B_AUTHORIZED` 在没有有效凭证时**无法被构造为可发布**。
- 凭证编号写入合规声明，表述不得超出授权协议范围。

### 3.3 开发期比对素材为什么不进发布包

- 1:1 比对需要「参照素材」——这些素材可能受版权保护，**仅存在于开发期**。
- 通过 Gradle `sourceSets` / 打包排除规则，参照素材放在**不参与 release 打包**的目录（如 `tools/parity-reference/`，`.gitignore` 排除或仅 dev sourceSet），release 产物中不存在。
- CI 视觉回归门禁：Spec 版本或资源包哈希变化必须重跑对齐清单，未通过不允许出包；该门禁校验的是「自产资源是否对齐公开规范」，而非把参照素材打进包里。

> 一句话：拿官方画面当**比对标尺**在开发期看一眼可以；把它当**发布资产**打包进产品不行。标尺留在开发机，产品只装自己画的东西。

---

## 4. 逐帧实时渲染如何与运算层共用同一份世界状态

**核心手法：单一权威世界状态 + 只读快照，渲染是状态的投影，不是另一套驱动。**

### 4.1 单一权威状态

`EditionEngine.worldState(): WorldState` 返回引擎**当帧**的世界状态（区块网格、光照图、实体、流体、红石、粒子事件）。这份状态是唯一的权威数据源。渲染层通过 `VoxelRenderer.render(snapshot: WorldSnapshot, frameMeta)` 读取它——`WorldSnapshot` 是 `WorldState` 在帧边界的**不可变只读快照**，避免渲染线程与逻辑线程争用。

### 4.2 帧循环中的数据流

```
一次 tick（引擎）   →  更新 WorldState（区块重建 / 光照传播 / 红石 / 实体）
       ↓ 帧边界取快照
WorldSnapshot（不可变）→  VoxelRenderer 逐帧生成画面 + HUD
       ↓
采集层读取同一快照的「工作量计数」（tick ms、区块数、实体数），而非另算一套
```

- 区块重建、光照更新、红石与实体状态变化**在画面上可见**，因为它们来自同一份 WorldState。
- 流体流动、红石充能亮度、活塞更新与运算层真实状态同步，**不允许「画面演一套、运算跑一套」**。
- 采集层的 workload counter 也取自这份状态，保证「同种子同参数工作量计数零差」。

### 4.3 禁止项在架构上被排除

- 渲染层接口只接受 `WorldSnapshot`，**没有** `playVideo()` / `showImage()` / `preloadFrames()` 之类的入口。
- `WorldSnapshot` 带 `seed`、`tickIndex`、`frameNonce`，CI 可校验相邻帧快照确有状态变化，戳穿预录帧 / 静态壁纸。
- HUD 可收起但**不影响采集**：HUD 是渲染层叠加，采集层独立读取引擎状态。

### 4.4 性能取向的取舍

渲染本身就是压力源，1:1 还原不得以降低负载真实性为代价——因此不会因为「画面好看」而减少区块可见数或跳过光照传播。视距增大时，可见区块、雾衰减、实体可见范围**同步变化**，与工作量计数一致。

---

## 附：其余关键取舍

- **为什么 Gradle 模块化**：`orchestrator` / `engine` / `render` / `telemetry` / `scoring` 等独立模块，便于替换引擎或渲染后端而不影响计分口径。
- **为什么规则包 + provenance 热替换**：基岩细粒度实现（光照批处理粒度、寻路上坡权重、部分视觉参数）权威资料不足，做成可热替换规则包并标注「待验证」，避免把设计建议当官方事实写死。
- **为什么采集失败标 unavailable 而非 0**：报告诚信要求；`unavailable` 项从权重中剔除并注明原因，禁止填 0 或估算冒充实测。
