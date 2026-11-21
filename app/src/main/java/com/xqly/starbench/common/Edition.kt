package com.xqly.starbench.common

/** 两套引擎的标识。禁止用单一布尔开关冒充两套实现。 */
enum class Edition(val displayName: String) {
    JAVA("Java Edition"),
    BEDROCK("Bedrock Edition"),
}

/** 确定性种子：临时世界由此生成，跑完清理，不触碰玩家存档。 */
data class Seed(val value: Long)

/**
 * 一次 run 的可复现工作量计数。
 * 验收标准：同种子同参数下这些字段必须零差；切换 AssetPack(A↔B) 也必须零差。
 */
data class WorkloadCounters(
    val tickCount: Long = 0,
    val chunkRebuilds: Long = 0,
    val chunksTicked: Long = 0,
    val entityTicks: Long = 0,
    val lightUpdates: Long = 0,
    val redstoneUpdates: Long = 0,
    val packetsBroadcast: Long = 0,
)

/** 温度 / 频率采样点。NaN 或 null 表示设备不支持，报告中标 unavailable。 */
data class ThermalSample(val elapsedMs: Long, val celsius: Float?, val status: String)
data class FrequencySample(val elapsedMs: Long, val cpuKHz: Long?, val gpuKHz: Long?)

/** 单套引擎、单个场景、单次 run 的原始指标集合。Java / Bedrock 各自独立。 */
data class RunMetrics(
    val edition: Edition,
    val scenarioId: String,
    val repeatIndex: Int,
    val seed: Seed,
    val frameTimesNs: List<Long>,
    val tickTimesNs: List<Long>,
    val workload: WorkloadCounters,
    val thermal: List<ThermalSample>,
    val frequencies: List<FrequencySample>,
    val visualSpecVersion: String,
    val assetPackMode: String,
    val assetPackHash: String,
)
