package com.xqly.starbench.orchestrator

import com.xqly.starbench.advice.AdviceEngine
import com.xqly.starbench.common.Edition
import com.xqly.starbench.common.RunMetrics
import com.xqly.starbench.common.Seed
import com.xqly.starbench.compliance.AuthorizationGate
import com.xqly.starbench.engine.EditionEngine
import com.xqly.starbench.report.ReportBundle
import com.xqly.starbench.report.SystemInfo
import com.xqly.starbench.scoring.Scorer
import com.xqly.starbench.visual.pack.AssetPackMode

/**
 * 一键编排：单次 start() 后不再需要任何玩家操作。
 * 时间进度来自真实运行的负载，不用 sleep 冒充工作量（需求十三禁止项）。
 */
class BenchmarkOrchestrator(
    private val engines: List<EditionEngine>,
    private val preFlightProvider: () -> PreFlightReport,
    private val assetPackMode: AssetPackMode,
    private val authorizationGate: AuthorizationGate,
    private val seed: Seed = Seed(System.currentTimeMillis()),
) {
    val stateMachine = BenchmarkStateMachine()
    private val collected = mutableListOf<RunMetrics>()

    fun onPhase(listener: (PhaseEvent) -> Unit) = stateMachine.onPhase(listener)

    /** 唯一入口：玩家点一下。发布门禁在 CI/Application 层执行，绝不在这里阻断玩家流程。 */
    fun start() {
        stateMachine.start()
        val preFlight = preFlightProvider()

        stateMachine.advance(Phase.WARMUP, preFlight.anomalies().joinToString(";"))
        runWarmup()

        val java = engines.first { it.edition == Edition.JAVA }
        val bedrock = engines.first { it.edition == Edition.BEDROCK }

        stateMachine.advance(Phase.JAVA_RUN)
        runEngineMatrix(java)

        stateMachine.advance(Phase.COOLDOWN_CHECK, coolDownNote())
        // 未完全冷却也继续，只记录，保证「点一下」不被打断

        stateMachine.advance(Phase.BEDROCK_RUN)
        runEngineMatrix(bedrock)

        stateMachine.advance(Phase.NETWORK_STRESS)
        runNetworkStress(java, bedrock)

        stateMachine.advance(Phase.REPEAT, "repeats=${ScenarioMatrix.DEFAULT_REPEATS}")
        repeatRemainingRuns()

        stateMachine.advance(Phase.SCORE)
        val cards = Edition.entries.associateWith { e -> Scorer.score(collected.filter { it.edition == e }, e) }

        stateMachine.advance(Phase.ADVICE)
        val advice = cards.mapValues { (_, c) -> AdviceEngine.generate(c, networkSummary()) }
        val bottlenecks = cards.mapValues { (_, c) -> AdviceEngine.bottleneck(c, networkSummary()) }

        stateMachine.advance(Phase.REPORT)
        lastReport = ReportBundle(
            system = SystemInfo(
                model = preFlight.deviceModel, osVersion = preFlight.osVersion,
                gpuVendor = "unavailable", gpuRenderer = preFlight.graphicsBackend, // 由采集层填充
                engineVersion = "0.1.0-skeleton",
                rulePackVersions = engines.associate { it.edition.name to it.rulePackVersion },
                visualSpecVersions = emptyMap(), // 由 VisualParitySpec 实例填充
                assetPackMode = assetPackMode, assetPackHashes = emptyMap(),
                authorizationCredentialId = authorizationGate.credentialIdFor(assetPackMode),
                seed = seed.value, thermalForecastSupported = preFlight.thermalForecast != null,
            ),
            cards = cards, advice = advice, bottleneck = bottlenecks,
            network = networkSummary(), runs = collected.toList(),
        )
        stateMachine.advance(Phase.DONE)
    }

    var lastReport: ReportBundle? = null
        private set

    /** CI / 发布构建调用；不参与玩家一键流程。 */
    fun assertReleaseReady() = authorizationGate.requirePublishable(assetPackMode)

    private fun runWarmup() {
        TODO("实现期补齐：热身到热稳态，期间渲染真实世界，记录帧时间但不计入正式数据")
    }

    private fun runEngineMatrix(engine: EditionEngine) {
        TODO("实现期补齐：遍历 ScenarioMatrix，逐帧驱动 engine 六方法 + renderer.render(snapshot)，采集 RunMetrics")
    }

    private fun runNetworkStress(vararg engines: EditionEngine) {
        TODO("实现期补齐：本地虚拟玩家真实差集广播 + 自有远端端点 RTT/抖动/丢包实测")
    }

    private fun repeatRemainingRuns() {
        TODO("实现期补齐：补足 ≥3 次重复，观察收敛")
    }

    private fun networkSummary() = com.xqly.starbench.advice.NetworkSummary(
        rttMs = 0.0, jitterMs = 0.0, lossRate = 0f,
    ).takeIf { false } // 无网络样本时为 null → 报告标 unavailable，不伪造

    private fun coolDownNote(): String = "冷却判定：未回到可接受热状态时记录未完全冷却并继续"
}
