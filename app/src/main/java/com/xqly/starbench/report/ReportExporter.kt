package com.xqly.starbench.report

import com.xqly.starbench.advice.Advice
import com.xqly.starbench.advice.Bottleneck
import com.xqly.starbench.advice.NetworkSummary
import com.xqly.starbench.common.Edition
import com.xqly.starbench.common.RunMetrics
import com.xqly.starbench.compliance.ComplianceText
import com.xqly.starbench.scoring.ScoreCard
import com.xqly.starbench.visual.pack.AssetPackMode

data class SystemInfo(
    val model: String,
    val osVersion: String,
    val gpuVendor: String,
    val gpuRenderer: String,
    val engineVersion: String,
    val rulePackVersions: Map<String, String>,
    val visualSpecVersions: Map<String, String>,
    val assetPackMode: AssetPackMode,
    val assetPackHashes: Map<String, String>,
    val authorizationCredentialId: String?,
    val seed: Long,
    val thermalForecastSupported: Boolean,
)

data class ReportBundle(
    val system: SystemInfo,
    val cards: Map<Edition, ScoreCard>,
    val advice: Map<Edition, List<Advice>>,
    val bottleneck: Map<Edition, Bottleneck>,
    val network: NetworkSummary?,
    val runs: List<RunMetrics>,
)

/** 四种导出格式。采集失败一律写 unavailable，禁止填 0 或估算。 */
object ReportExporter {

    fun markdown(b: ReportBundle): String = buildString {
        appendLine("# 星穹旅驿 · 等效负载跑分报告")
        appendLine()
        appendLine("> ${ComplianceText.statement(b.system.assetPackMode, b.system.authorizationCredentialId)}")
        appendLine()
        appendLine("## 本次画面口径")
        appendLine("- AssetPack 模式：${b.system.assetPackMode}")
        appendLine("- VisualParitySpec：${b.system.visualSpecVersions}")
        appendLine("- 资源包哈希：${b.system.assetPackHashes}")
        appendLine("- 种子：${b.system.seed}")
        appendLine()
        for (e in Edition.entries) {
            val card = b.cards[e] ?: continue
            appendLine("## ${e.displayName}")
            appendLine()
            appendLine("| 指标 | 数值 |")
            appendLine("|---|---|")
            appendLine("| 峰值 FPS | ${fmt(card.peak.fps)} |")
            appendLine("| 平均（持续）FPS（调和平均） | ${fmt(card.sustained.harmonicFps)} |")
            appendLine("| 1% Low FPS | ${fmt(card.low1Percent.fps1Percent)} |")
            appendLine("| 0.1% Low FPS | ${fmt(card.low1Percent.fps0_1Percent)} |")
            appendLine("| p99 帧时间 | ${card.low1Percent.p99FrameNs / 1_000_000} ms |")
            appendLine("| Jank 率 | ${fmt(card.low1Percent.jankRate * 100)}% |")
            appendLine("| 温控跌幅 | ${fmt(card.thermalDropPercent)}% |")
            appendLine("| avg MSPT | ${fmt(card.sustained.avgMspt)} ms |")
            appendLine("| 瓶颈判定 | ${b.bottleneck[e] ?: "INSUFFICIENT_DATA"} |")
            appendLine()
            val frames = b.runs.filter { it.edition == e }.flatMap { it.frameTimesNs }
            if (frames.isNotEmpty()) {
                appendLine("### 帧时间曲线（采样 ASCII）")
                appendLine("```")
                appendLine(asciiChart(frames))
                appendLine("```")
                appendLine()
            }
            appendLine("### 改进意见")
            b.advice[e].orEmpty().forEach { a ->
                appendLine("- [${a.rank}] ${a.text}")
                appendLine("  - 依据：${a.evidence}")
                appendLine("  - 影响方向：${a.direction}（适用引擎：${a.edition.displayName}）")
            }
            appendLine()
        }
        appendLine("> 本报告无合并总分：Java 与 Bedrock 分别计分。采集失败项标记 unavailable，不填 0。")
    }

    fun json(b: ReportBundle): String = buildString {
        append("{")
        append("\"brand\":\"${esc(ComplianceText.BRAND)}\",")
        append("\"compliance\":\"${esc(ComplianceText.statement(b.system.assetPackMode, b.system.authorizationCredentialId))}\",")
        append("\"cards\":[")
        append(b.cards.entries.joinToString(",") { (e, c) ->
            "{\"edition\":\"${e.name}\",\"peak\":${fmt(c.peak.fps)},\"sustained\":${fmt(c.sustained.harmonicFps)}," +
            "\"low1\":${fmt(c.low1Percent.fps1Percent)},\"low01\":${fmt(c.low1Percent.fps0_1Percent)}," +
            "\"p99ns\":${c.low1Percent.p99FrameNs},\"jank\":${fmt(c.low1Percent.jankRate)}," +
            "\"thermalDrop\":${fmt(c.thermalDropPercent)}}"
        })
        append("],\"frames\":[")
        append(b.runs.joinToString(",") { r ->
            "{\"edition\":\"${r.edition.name}\",\"scenario\":\"${esc(r.scenarioId)}\",\"repeat\":${r.repeatIndex}," +
            "\"seed\":${r.seed.value},\"spec\":\"${esc(r.visualSpecVersion)}\",\"packMode\":\"${esc(r.assetPackMode)}\"," +
            "\"packHash\":\"${esc(r.assetPackHash)}\",\"frameTimesNs\":[${r.frameTimesNs.joinToString(",")}]," +
            "\"tickTimesNs\":[${r.tickTimesNs.joinToString(",")}]}"
        })
        append("]}")
    }

    /** 每行一个逐帧样本，可直接进 Excel/Pandas。 */
    fun csv(b: ReportBundle): String = buildString {
        appendLine("edition,scenario,repeat,frame_index,frame_time_ns,tick_time_ms,spec_version,pack_mode,pack_hash")
        b.runs.forEach { r ->
            val n = maxOf(r.frameTimesNs.size, r.tickTimesNs.size)
            for (i in 0 until n) {
                val ft = r.frameTimesNs.getOrNull(i)
                val tt = r.tickTimesNs.getOrNull(i)?.let { it / 1_000_000.0 }
                appendLine(listOf(
                    r.edition.name, r.scenarioId, r.repeatIndex, i,
                    ft ?: "unavailable", tt ?: "unavailable",
                    r.visualSpecVersion, r.assetPackMode, r.assetPackHash,
                ).joinToString(","))
            }
        }
    }

    fun systemJson(b: ReportBundle): String {
        val s = b.system
        return buildString {
            append("{")
            append("\"model\":\"${esc(s.model)}\",\"os\":\"${esc(s.osVersion)}\",")
            append("\"gpuVendor\":\"${esc(s.gpuVendor)}\",\"gpuRenderer\":\"${esc(s.gpuRenderer)}\",")
            append("\"engineVersion\":\"${esc(s.engineVersion)}\",\"rulePacks\":${obj(s.rulePackVersions)},")
            append("\"visualSpecs\":${obj(s.visualSpecVersions)},")
            append("\"assetPackMode\":\"${s.assetPackMode}\",\"assetPackHashes\":${obj(s.assetPackHashes)},")
            append("\"authorizationCredentialId\":${s.authorizationCredentialId?.let { "\"${esc(it)}\"" } ?: "null"},")
            append("\"seed\":${s.seed},\"thermalForecastSupported\":${s.thermalForecastSupported}")
            append("}")
        }
    }

    private fun asciiChart(values: List<Long>, bins: Int = 40): String {
        if (values.isEmpty()) return "(无帧样本)"
        val sampled = if (values.size <= bins) values else values.filterIndexed { i, _ -> i % (values.size / bins) == 0 }
        val max = sampled.maxOrNull() ?: 1L
        val min = sampled.minOrNull() ?: 0L
        val range = (max - min).coerceAtLeast(1)
        return sampled.joinToString("\n") { v ->
            val h = ((v - min) * 20 / range + 1).toInt().coerceIn(1, 20)
            "#".repeat(h) + " ${v / 1_000_000}ms"
        }
    }

    private fun fmt(v: Double): String = "%.2f".format(v)
    private fun esc(s: String): String = s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
    private fun obj(m: Map<String, String>): String =
        m.entries.joinToString(",", "{", "}") { "\"${esc(it.key)}\":\"${esc(it.value)}\"" }
}
