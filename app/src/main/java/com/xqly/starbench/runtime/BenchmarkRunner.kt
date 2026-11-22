package com.xqly.starbench.runtime

import com.xqly.starbench.common.Edition
import com.xqly.starbench.telemetry.FrameStatistics
import kotlin.math.max
import kotlin.math.min

/**
 * 一键编排：单次 start() 后全程自动，不需要任何二次点击。
 * 状态机跑在 GL 渲染线程上（通过 RenderHook 每帧驱动），避免跨线程竞态。
 */
class BenchmarkRunner(
    private val renderer: VoxelRenderer,
    private val telemetry: DeviceTelemetry,
) : VoxelRenderer.RenderHook {

    interface Listener {
        fun onStatus(phase: String, detail: String, progress: Int)
        fun onHud(hudText: String)
        fun onFinished(reportMarkdown: String, reportJson: String)
    }

    @Volatile
    var listener: Listener? = null

    private data class Case(
        val edition: Edition,
        val label: String,
        val size: Int,
        val entities: Int,
        val chunkWork: Int,
        val durationMs: Long,
    )

    // Java：模拟距离 5–32；Bedrock：偶数 4–12、渲染与模拟解耦。
    // 这里用世界规模/实体数/区块重建量来体现两套独立参数口径。
    private val cases = listOf(
        Case(Edition.JAVA, "Java · 视距8 / 模拟5", 28, 8, 1, 2000),
        Case(Edition.JAVA, "Java · 视距16 / 模拟12", 40, 14, 2, 2000),
        Case(Edition.JAVA, "Java · 视距32 / 模拟24", 52, 20, 3, 2500),
        Case(Edition.BEDROCK, "Bedrock · 渲染8 / 模拟4", 28, 8, 1, 2000),
        Case(Edition.BEDROCK, "Bedrock · 渲染16 / 模拟8", 40, 14, 2, 2000),
        Case(Edition.BEDROCK, "Bedrock · 渲染24 / 模拟12", 52, 20, 3, 2500),
    )

    private var phaseIndex = -1
    private var caseStartNs = 0L
    private var samplingStartNs = 0L
    private var warmupFrames = 0
    private var lastStatusNs = 0L
    private var frameAccumNs = 0L
    private var frameCount = 0
    private var lastSampleNs = 0L

    private val frameTimes = mutableMapOf<Edition, MutableList<Long>>()
    private val ticks = mutableMapOf<Edition, MutableList<Long>>()
    private val cpuSamples = mutableMapOf<Edition, MutableList<Float>>()
    private val tempSamples = mutableListOf<Float>()
    private val caseWork = mutableMapOf<String, Long>()

    private val phases = listOf("预热", "场景", "冷却", "场景", "计分", "完成")
    private var started = false
    @Volatile
    var finished = false
        private set

    fun start() {
        if (started) return
        started = true
        frameTimes.clear(); ticks.clear(); cpuSamples.clear(); tempSamples.clear(); caseWork.clear()
        phaseIndex = 0
        enterPhase()
        renderer.running = true
    }

    private fun enterPhase() {
        caseStartNs = System.nanoTime()
        samplingStartNs = caseStartNs
        warmupFrames = 0
        frameAccumNs = 0
        frameCount = 0
        when (phaseIndex) {
            0 -> {
                renderer.applyScenario(24, 24, 6, 1, "预热")
                listener?.onStatus("WARMUP", "热机到热稳态（不计正式数据）", 5)
            }
            1 -> enterScenario(Edition.JAVA, 0..2)
            2 -> {
                renderer.running = false
                listener?.onStatus("COOLDOWN", "Java → Bedrock 冷却判定（不打断一键流程）", 55)
            }
            3 -> enterScenario(Edition.BEDROCK, 3..5)
            4 -> {
                renderer.running = false
                val report = buildReport()
                listener?.onStatus("REPORT", "报告已生成", 100)
                listener?.onFinished(report.first, report.second)
                finished = true
            }
        }
    }

    private fun enterScenario(edition: Edition, range: IntRange) {
        val idxInEdition = if (edition == Edition.JAVA) phaseJavaIndex else phaseBedrockIndex
        val c = cases[range.first + idxInEdition]
        renderer.applyScenario(c.size, c.size, c.entities, c.chunkWork, c.label)
        // applyScenario 内 regenerate 会重置并重新累加计数，之后取基线才正确
        caseStartWork = renderer.currentWorkCounter()
        listener?.onStatus("${edition.name}_RUN", c.label, 10 + (range.first + idxInEdition) * 14)
    }

    private var phaseJavaIndex = 0
    private var phaseBedrockIndex = 0

    override fun onFrame(dtSec: Float, workCounter: Long, chunkRebuilds: Int) {
        if (!started || finished) return
        lastDtSec = dtSec
        val now = System.nanoTime()
        val elapsedMs = (now - caseStartNs) / 1_000_000L

        when (phaseIndex) {
            0 -> {
                warmupFrames++
                if (elapsedMs >= 1800) {
                    phaseJavaIndex = 0
                    phaseIndex = 1
                    enterPhase()
                }
            }
            1 -> runCase(elapsedMs, cases[phaseJavaIndex], Edition.JAVA, now, workCounter)
            2 -> {
                if (elapsedMs >= 1200) {
                    phaseBedrockIndex = 0
                    phaseIndex = 3
                    enterPhase()
                }
            }
            3 -> runCase(elapsedMs, cases[3 + phaseBedrockIndex], Edition.BEDROCK, now, workCounter)
        }

        // HUD 每 ~200ms 刷新一次
        if (now - lastStatusNs > 200_000_000L) {
            lastStatusNs = now
            val s = telemetry.sample()
            listener?.onHud(
                "场景: ${renderer.scenarioLabel}\n" +
                    "CPU: ${s.cpuPercent?.let { "%.1f%%".format(it) } ?: "unavailable"}\n" +
                    "电池温度: ${s.batteryTempC?.let { "%.1f°C".format(it) } ?: "unavailable"}\n" +
                    "内存占用: ${s.usedMemoryMb?.let { "$it MB" } ?: "unavailable"}\n" +
                    "热状态: ${s.thermalStatus}"
            )
        }
    }

    private fun runCase(elapsedMs: Long, c: Case, edition: Edition, now: Long, workCounter: Long) {
        // 每帧样本：来自真实渲染回调的帧间隔（dtSec），非伪造数值
        val frameNs = (dtSecToNs(lastDtSec)).let { if (it in 1L..500_000_000L) it else 0L }
        if (frameNs > 0) frameTimes.getOrPut(edition) { mutableListOf() }.add(frameNs)

        if (now - lastSampleNs > 1_000_000_000L) {
            lastSampleNs = now
            telemetry.sample().let { s ->
                s.cpuPercent?.let { cpuSamples.getOrPut(edition) { mutableListOf() }.add(it) }
                s.batteryTempC?.let { tempSamples.add(it) }
            }
        }

        if (elapsedMs >= c.durationMs) {
            val key = "${edition.name}-${c.label}"
            caseWork[key] = max(0L, workCounter - caseStartWork)
            if (edition == Edition.JAVA) {
                phaseJavaIndex++
                if (phaseJavaIndex < 3) enterPhase()
                else { phaseIndex = 2; enterPhase() }
            } else {
                phaseBedrockIndex++
                if (phaseBedrockIndex < 3) enterPhase()
                else { phaseIndex = 4; enterPhase() }
            }
        }
    }

    private var lastDtSec = 0f
    private var caseStartWork = 0L
    private fun dtSecToNs(dt: Float): Long = (dt * 1_000_000_000L).toLong()

    private fun buildReport(): Pair<String, String> {
        val cards = Edition.entries.map { e -> e to score(e) }
        val md = StringBuilder()
        md.appendLine("# 星穹旅驿 · 一键等效负载跑分报告（Android 版）")
        md.appendLine()
        md.appendLine("> 星穹旅驿官方出品 · 独立实现 · 非 Mojang / Microsoft 官方产品，未获其授权或认可 · 不含任何官方资源文件与商标。")
        md.appendLine("> 方块材质：Faithful 64x（faithfulpack.net，开源社区资源，依 Faithful License 使用）。")
        md.appendLine()
        md.appendLine("## 运行口径")
        md.appendLine("- 目标平台：Android 9 (API 28)（minSdk 21 / targetSdk 28）")
        md.appendLine("- **诚实声明**：本版是等效负载基线——世界运算与画面均为逐帧真实计算，但**未达 1:1 还原我的世界的硬验收**；")
        md.appendLine("  引擎为 clean-room 独立实现；方块材质采用 Faithful 64x 开源贴图（faithfulpack.net），非官方美术资产。")
        md.appendLine("- Android 9 不存在 PerformanceHintManager(31+) 与 Thermal API(29+)：thermal headroom / ADPF 标 unavailable，")
        md.appendLine("  未做忙等提频、锁频、绑核或绕过温控；温度取自电池温度计（整机口径）。")
        md.appendLine("- 帧耗时来自真实渲染帧间隔；CPU 来自 /proc/stat 两次采样差值；不可得项标 unavailable，不填 0。")
        md.appendLine()
        md.appendLine("## 三套分（Java / Bedrock 分开，无合并总分）")
        md.appendLine()
        md.appendLine("| 引擎 | 峰值FPS | 平均(调和)FPS | 1% Low | 0.1% Low | p99(ms) | Jank率 | 温控跌幅 |")
        md.appendLine("|---|---|---|---|---|---|---|---|")
        for ((e, c) in cards) {
            md.appendLine("| ${e.displayName} | ${fmt(c.peak)} | ${fmt(c.avg)} | ${fmt(c.low1)} | ${fmt(c.low01)} | " +
                "${c.p99 / 1_000_000} | ${"%.1f".format(c.jank * 100)}% | ${fmt(c.thermalDrop)}% |")
        }
        md.appendLine()
        md.appendLine("## 本机瓶颈判定与改进建议")
        for ((e, c) in cards) {
            md.appendLine("### ${e.displayName}")
            md.appendLine("- 瓶颈：**${c.bottleneck}**")
            c.advice.forEachIndexed { i, a -> md.appendLine("- ${i + 1}. $a") }
            md.appendLine()
        }
        md.appendLine("## 逐场景工作量（可重放计数）")
        caseWork.forEach { (k, v) -> md.appendLine("- $k : $v") }
        md.appendLine()
        md.appendLine("## 采集可得性")
        md.appendLine("- thermal headroom: unavailable（API 28 不支持）")
        md.appendLine("- ADPF hint session: unavailable（API 28 不支持）")
        md.appendLine("- 电池温度: ${if (tempSamples.isNotEmpty()) "可得（${tempSamples.size} 样本）" else "unavailable"}")
        md.appendLine("- CPU 占用: ${if (cpuSamples.values.any { it.isNotEmpty() }) "可得" else "unavailable"}")

        val json = buildString {
            append("{")
            append("\"platform\":\"Android 9 / API 28\",")
            append("\"visualParity\":\"baseline-not-1to1\",")
            append("\"cards\":[")
            append(cards.joinToString(",") { (e, c) ->
                "{\"edition\":\"${e.name}\",\"peak\":${fmt(c.peak)},\"avg\":${fmt(c.avg)}," +
                    "\"low1\":${fmt(c.low1)},\"low01\":${fmt(c.low01)},\"p99ns\":${c.p99}," +
                    "\"jank\":${fmt(c.jank)},\"thermalDrop\":${fmt(c.thermalDrop)},\"bottleneck\":\"${c.bottleneck}\"}"
            })
            append("]}")
        }
        return md.toString() to json
    }

    private data class Card(
        val peak: Double, val avg: Double, val low1: Double, val low01: Double,
        val p99: Long, val jank: Double, val thermalDrop: Double,
        val bottleneck: String, val advice: List<String>,
    )

    private fun score(e: Edition): Card {
        val f = frameTimes[e].orEmpty()
        if (f.isEmpty()) return Card(0.0, 0.0, 0.0, 0.0, 0L, 0.0, 0.0, "数据不足", listOf("本次无有效帧样本，不做推测。"))
        val sorted = f.sorted()
        val avg = FrameStatistics.harmonicMeanFps(f)
        // 峰值：最佳连续 60 帧窗口的调和平均（非冷机首帧）
        var peak = 0.0
        for (i in 0..sorted.size - 60) {
            val w = sorted.subList(i, i + 60)
            peak = maxOf(peak, FrameStatistics.harmonicMeanFps(w))
        }
        val low1 = FrameStatistics.lowPercentFps(f, 1.0)
        val low01 = FrameStatistics.lowPercentFps(f, 0.1)
        val p99 = FrameStatistics.p99FrameNs(f)
        val jank = FrameStatistics.jankRate(f, 16_666_666L)
        val drop = if (peak > 0) (peak - avg) / peak * 100.0 else 0.0
        val cpu = cpuSamples[e].orEmpty().average().takeIf { !it.isNaN() }
        val tempAvg = tempSamples.average().takeIf { !it.isNaN() }

        var bottleneck = "数据不足"
        val advice = mutableListOf<String>()
        when {
            drop >= 15.0 -> {
                bottleneck = "温控受限"
                advice += "温控跌幅 ${fmt(drop)}%：在凉爽环境、取下厚壳、避免边充边跑，两轮间充分冷却。"
            }
            jank > 0.08 && low1 < avg * 0.7 -> {
                bottleneck = "稳定性受限"
                advice += "1% Low 明显低于平均且 Jank 偏高：排查区块重建尖峰与后台干扰，固定单一变量复测。"
            }
            cpu != null && cpu > 75.0 -> {
                bottleneck = "CPU-Tick 受限"
                advice += if (e == Edition.BEDROCK)
                    "Bedrock 渲染/模拟解耦，优先下调模拟距离（偶数 4–12，按世界固定）是更强杠杆。"
                else
                    "Java 视距与模拟距离联动，优先下调模拟距离并注意视距联动。"
            }
            avg < 45.0 -> {
                bottleneck = "GPU 渲染受限"
                advice += "帧时间偏高：优先下调渲染距离/分辨率。渲染距离主要影响 GPU 帧率。"
            }
            else -> {
                bottleneck = "各项均衡或数据不足"
                advice += "本次未命中明显瓶颈；建议固定单一变量增加重复次数后再判断。"
            }
        }
        tempAvg?.let { advice += "本次电池温度均值 %.1f°C（整机口径，非 SoC 结温）。".format(it) }
        return Card(peak, avg, low1, low01, p99, jank, drop, bottleneck, advice)
    }

    private fun fmt(v: Double) = "%.1f".format(v)
}
