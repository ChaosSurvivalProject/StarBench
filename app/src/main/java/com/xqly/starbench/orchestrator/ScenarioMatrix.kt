package com.xqly.starbench.orchestrator

import com.xqly.starbench.common.Edition

/**
 * 视距 / 模拟距离变量矩阵（需求第八节）。
 * Java 与 Bedrock 各自使用本版本合法取值范围，不互用。
 * 每个 case：空平坦世界基线 + 固定运镜 + 固定时长 + 固定种子 + 热身/正式期 + ≥3 次重复。
 */
data class Scenario(
    val id: String,
    val renderDistance: Int,
    val simulateDistance: Int,
    val entityCount: Int,
    val redstoneDensity: Float,
    val virtualPlayers: Int,
    val networkTier: String,
    val warmupMs: Long,
    val measuredMs: Long,
    val cameraScriptId: String,
)

object ScenarioMatrix {
    const val DEFAULT_REPEATS = 3

    /** Java 模拟距离 5–32，可与渲染距离联动变化。 */
    fun javaCases(): List<Scenario> = listOf(
        Scenario("java-baseline-flat", 8, 5, 0, 0f, 0, "none", 60_000, 180_000, "orbit-flat"),
        Scenario("java-render-only-8", 8, 12, 150, 0.3f, 2, "lan", 60_000, 180_000, "sweep-8"),
        Scenario("java-render-only-16", 16, 12, 150, 0.3f, 2, "lan", 60_000, 180_000, "sweep-16"),
        Scenario("java-sim-only-12", 12, 12, 150, 0.3f, 2, "lan", 60_000, 180_000, "fixed-12"),
        Scenario("java-sim-only-24", 12, 24, 150, 0.3f, 2, "lan", 60_000, 180_000, "fixed-12"),
        Scenario("java-heavy", 32, 32, 400, 0.8f, 8, "wan", 90_000, 300_000, "rush-32"),
    )

    /** Bedrock 模拟距离偶数 4–12，按世界固定；渲染距离与模拟距离解耦，可见可不 tick。 */
    fun bedrockCases(): List<Scenario> = listOf(
        Scenario("bedrock-baseline-flat", 8, 4, 0, 0f, 0, "none", 60_000, 180_000, "orbit-flat"),
        Scenario("bedrock-render-only-8", 8, 4, 150, 0.3f, 2, "lan", 60_000, 180_000, "sweep-8"),
        Scenario("bedrock-render-only-16", 16, 4, 150, 0.3f, 2, "lan", 60_000, 180_000, "sweep-16"),
        Scenario("bedrock-sim-only-4", 12, 4, 150, 0.3f, 2, "lan", 60_000, 180_000, "fixed-12"),
        Scenario("bedrock-sim-only-8", 12, 8, 150, 0.3f, 2, "lan", 60_000, 180_000, "fixed-12"),
        Scenario("bedrock-heavy", 24, 12, 400, 0.8f, 8, "wan", 90_000, 300_000, "rush-24"),
    )

    fun casesFor(edition: Edition): List<Scenario> =
        if (edition == Edition.JAVA) javaCases() else bedrockCases()
}
