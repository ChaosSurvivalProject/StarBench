# StarBench · 星穹旅驿一键等效负载跑分

> **星穹旅驿官方出品** · Android 平台「我的世界等效负载」一键自动跑分 App。

## ✅ 可下载 APK（基于 Android 9）

本仓库提供**真实可安装的 APK**，直接用浏览器打开下表的 GitHub Release 链接即可下载，传到 Android 9 设备安装：

| 版本 | 说明 | 下载 |
|---|---|---|
| v0.3.0-android9-faithful64x | **最新**：正式签名版，接入 Faithful 64x 材质（推荐） | 见仓库 [Releases](https://github.com/ChaosSurvivalProject/StarBench/releases) 页 |
| v0.2.0-android9-release | 旧版正式签名版（程序化自绘材质） | 见仓库 Releases 页 |
| v0.2.0-android9 | 旧版 Debug 版 | 见仓库 Releases 页 |

- 包名 `com.xqly.starbench`，`minSdk 21`（Android 5.0+）、**`targetSdk 28`（Android 9）**。
- **v0.3.0 画面材质**：OpenGL ES 2.0 渲染改用 [Faithful 64x](https://faithfulpack.net) 开源方块贴图（64×64，叶片 alpha 镂空），与网页版共用同一张图集、同步更新。
- 本地文件也可在 `downloads/` 目录找到，SHA-256 见 [downloads/SHA256SUMS.txt](../downloads/SHA256SUMS.txt)。
- 安装：允许「安装未知来源应用」后点击 APK；或 `adb install StarBench-v0.3.0-android9-faithful64x.apk`。

> **诚实声明（重要）**：这是一个**真实可运行的等效负载基线版**——世界生成、光照传播、实体推进、网格构建都是逐帧真实计算，画面由 OpenGL ES 2.0 逐帧渲染（非视频/截图/预录帧），CPU/温度/帧耗时为真实采集。画面方块材质采用 **[Faithful 64x](https://faithfulpack.net)** 开源贴图（非 Mojang / Microsoft 官方美术资源）。**但它尚未达到「1:1 还原我的世界」的硬验收**：引擎与场景为 clean-room 独立实现，未使用官方代码、模型、音效或商标。报告页会如实标注这一点。

> **第三方材质署名**：世界内方块贴图来自 Faithful Resource Pack 的 [Faithful-Java-64x](https://github.com/Faithful-Resource-Pack/Faithful-Java-64x)（64×64，含草、泥土、石头、橡木、树叶、水、沙子），依据 [Faithful License](THIRD_PARTY_LICENSES.txt) 使用；草顶 / 树叶 / 水按 Minecraft 生物群系 colormap 着色。Faithful 官网：<https://faithfulpack.net>。本项目与 Faithful 均非 Mojang / Microsoft 官方产品，未获其授权或认可。
>
> **Android 9 的平台事实**：`PerformanceHintManager`(API 31+) 与 Thermal API(API 29+) 在 Android 9 上不存在，因此 thermal headroom / ADPF 提频提示在报告中标 `unavailable`，未做忙等提频、锁频或绕过温控；温度取自电池温度计（整机口径）。

本仓库同时保留依据产品提示词落地的**完整工程骨架与核心接口契约**（模块边界、`VisualParitySpec`、`AssetPack`、一键状态机、计分/建议/报告数据契约、双引擎独立实现入口）。凡公开资料不足的细节，均以 `待验证 / 设计建议` 标注，不编造 API 名、版本号或具体数值。

> 本工程**不是** Mojang / Microsoft 官方产品，未获其授权或认可。默认仅走**路径 A（clean-room 独立重绘）**，发布包内不含任何官方代码、贴图、模型、音效或商标标识。

---

## 一句话体验

点一下「开始跑分」→ 屏幕全程显示逐帧实时计算的等效负载画面与 HUD → 自动跑完全部场景 → 实时显示 CPU / GPU 压力 → 输出峰值 / 平均 / 1% Low 三套独立分数与可操作的改进意见。

## 硬口径（不可偏离）

| # | 口径 |
|---|---|
| 1 | **一键全自动**：pre-flight → 世界加载 → 双引擎全部场景 → 网络压测 → 计分 → 报告，零二次点击 |
| 2 | **温度提前告知**：启动页常驻卡片 + 首启一次性说明，不阻断流程 |
| 3 | **只用合法手段提频**：`PerformanceHintManager` 按真实帧耗时上报 + `Thermal API` 前瞻调度；严禁忙等、空转、锁频、绑核、绕过温控、root |
| 4 | **三套分同时给**：峰值 / 平均 / 1% Low，另附 0.1% Low、p99、Jank 率、帧时间曲线、温控跌幅 |
| 5 | **双引擎彻底分离**：两套引擎 / run / 指标 / 分数 / 报告 / 建议 / 画面基线，禁止合并成一个总分 |
| 6 | **画面 1:1 还原**：由引擎当帧世界状态实时渲染，非视频 / 截图 / 预录帧 / 占位色块 |
| 7 | **运算全链路等价**：区块 / 光照 / 红石 / 实体 AI / 剔除 / 同步真实执行，禁随机数 / sleep / 空循环伪造负载 |
| 8 | **模组接口保留**：签名校验 + 沙箱 + 版本协商 + 资源配额 + 资源包授权门禁 |
| 9 | **授权前置门禁**：CI 发布门禁，未授权时只允许路径 A，且必须保留非官方声明 |

## 目录结构

```
app/src/main/
├── java/com/xqly/starbench/
│   ├── common/          版本、Edition、种子、结果等公共类型
│   ├── compliance/      温度告知、合规声明、授权门禁（路径 A/B）
│   ├── orchestrator/    一键状态机、pre-flight、场景矩阵、热身/重复
│   ├── engine/
│   │   ├── EditionEngine.kt        双引擎统一契约（各自独立实现）
│   │   ├── java/JavaEditionEngine.kt
│   │   └── bedrock/BedrockEditionEngine.kt
│   ├── render/voxel/    体素渲染器接口（当帧世界状态 → 画面）
│   ├── visual/spec/     VisualParitySpec：逐维度版本化对齐清单
│   ├── visual/pack/     AssetPack：路径 A 重绘 / 路径 B 授权包
│   ├── telemetry/       帧时间、CPU/GPU、温度、内存、功耗（分级降级）
│   ├── network/         本地虚拟玩家差集广播 + 自有远端端点实测
│   ├── plugin/api/      模组 IDL 契约、registerAssetPack
│   ├── scoring/         峰值 / 平均 / 1% Low 三套独立计分
│   ├── advice/          规则化改进意见 + 瓶颈判定
│   ├── report/          Markdown / JSON / CSV / system.json 导出
│   └── ui/              启动页、温度告知卡、实时 HUD、报告页
└── cpp/                 NDK：双引擎原生内核 + Vulkan/OpenGL ES 渲染骨架
```

## 关键文档

- [架构与关键取舍说明](docs/ARCHITECTURE.md) —— 重点回答需求第十四节的四个问题
- [1:1 视觉对齐规范 VisualParitySpec](docs/VISUAL_PARITY_SPEC.md)
- [指标定义](docs/METRICS.md)
- [验收自测清单](docs/SELFTEST_CHECKLIST.md)
- [授权前置检查表](docs/AUTHORIZATION_PRECHECK.md)
- [合规声明与温度告知文案](docs/COMPLIANCE.md)

## 技术选型

- **Kotlin + C++/NDK**：编排、采集、计分、报告用 Kotlin；体素世界运算与渲染用 C++。
- **Vulkan 优先，OpenGL ES 降级**：移动 GPU 上 Vulkan 的多线程命令录制与显式控制更贴合「渲染即压力源」的目标；老设备回退 OpenGL ES。选型理由见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。
- **画面资产双路径**：路径 A 独立重绘（默认、可无条件发布）；路径 B 预留 `AssetPack` 接口，仅在取得 Mojang / Microsoft 书面授权后启用并写入凭证编号。

## 构建

> 本骨架给出 Gradle 配置与全部接口签名。完整编译需要 Android SDK（本骨架使用 AGP，compileSdk 目标见 `app/build.gradle.kts`）。

```bash
# 生成 Gradle Wrapper（若尚未提交 jar）
gradle wrapper --gradle-version 8.9
./gradlew :app:assembleDebug
```

## 许可与合规

本项目源码以 [Apache License 2.0](LICENSE) 开源。**开源的是本工程自身的代码**，不包含也不得包含任何 Minecraft 官方资产。参见 [授权前置检查表](docs/AUTHORIZATION_PRECHECK.md)。
