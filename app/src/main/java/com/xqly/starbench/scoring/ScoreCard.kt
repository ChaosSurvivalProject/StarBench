package com.xqly.starbench.scoring

import com.xqly.starbench.common.Edition
import com.xqly.starbench.common.RunMetrics
import com.xqly.starbench.common.ThermalSample
import com.xqly.starbench.telemetry.FrameStatistics

/**
 * 三套分独立字段，分开展示、分开计分。
 * 注意：本类型【没有】combinedScore —— 禁止把 Java 与 Bedrock 加权成一个总分。
 */
data class ScoreCard(
    val edition: Edition,
    val peak: PeakScore,
    val sustained: SustainedScore,
    val low1Percent: LowPercentScore,
    val thermalDropPercent: Double,
)

data class PeakScore(
    val fps: Double,
    val bestWindowMspt: Double,
    val chunkThroughputPerSec: Double,
    val temperatureC: Double?,
    val avgFreqKHz: Long?,
)

data class SustainedScore(
    val harmonicFps: Double,
    val avgFrameNs: Double,
    val avgMspt: Double,
    val temperatureC: Double?,
    val avgFreqKHz: Long?,
)

data class LowPercentScore(
    val fps1Percent: Double,
    val fps0_1Percent: Double,
    val p99FrameNs: Long,
    val jankRate: Double,
)

object Scorer {

    /** 按引擎分别计分。多个 repeat 取收敛后的稳态窗口集合。 */
    fun score(runs: List<RunMetrics>, edition: Edition): ScoreCard {
        require(runs.all { it.edition == edition }) { "禁止混合引擎计分" }
        val frames = runs.flatMap { it.frameTimesNs }
        val ticks = runs.flatMap { it.tickTimesNs }
        val thermals = runs.flatMap { it.thermal }
        val freqs = runs.flatMap { it.frequencies }

        val sustainedFps = FrameStatistics.harmonicMeanFps(frames)
        val sustained = SustainedScore(
            harmonicFps = sustainedFps,
            avgFrameNs = frames.map { it.toDouble() }.average(),
            avgMspt = ticks.map { it / 1_000_000.0 }.average(),
            temperatureC = thermals.mapNotNull { it.celsius }.map { it.toDouble() }.average(),
            avgFreqKHz = freqs.mapNotNull { it.cpuKHz }.average().takeIf { !it.isNaN() }?.toLong(),
        )

        // 峰值：最佳连续窗口（60s），排除触发温控降频的窗口；禁止用冷机第一帧。
        val peakWindow = bestUndroppedWindow(frames, thermals)
        val peakFps = FrameStatistics.harmonicMeanFps(peakWindow)
        val peak = PeakScore(
            fps = peakFps,
            bestWindowMspt = ticks.takeIf { it.isNotEmpty() }?.let { it.minOf { t -> t / 1_000_000.0 } } ?: 0.0,
            chunkThroughputPerSec = run {
                val totalChunks = runs.sumOf { it.workload.chunkRebuilds }.toDouble()
                val totalSeconds = runs.sumOf { r -> r.frameTimesNs.sum() } / 1_000_000_000.0
                (totalChunks / totalSeconds).takeIf { it.isFinite() } ?: 0.0
            },
            temperatureC = thermals.mapNotNull { it.celsius }.minOrNull()?.toDouble(),
            avgFreqKHz = freqs.mapNotNull { it.cpuKHz }.maxOrNull(),
        )

        val low = LowPercentScore(
            fps1Percent = FrameStatistics.lowPercentFps(frames, 1.0),
            fps0_1Percent = FrameStatistics.lowPercentFps(frames, 0.1),
            p99FrameNs = FrameStatistics.p99FrameNs(frames),
            jankRate = FrameStatistics.jankRate(frames, targetNs = 16_666_666L), // 待验证：目标帧预算按场景帧率上限
        )

        val drop = if (peakFps > 0) (peakFps - sustainedFps) / peakFps * 100.0 else 0.0
        return ScoreCard(edition, peak, sustained, low, drop)
    }

    /** 设计建议：以累计帧时间滑出 60s 窗口，跳过含热降频状态的区间。 */
    private fun fmt(v: Double): String = "%.2f".format(v)

    private fun bestUndroppedWindow(
        frames: List<Long>,
        thermals: List<ThermalSample>,
    ): List<Long> {
        if (frames.isEmpty()) return emptyList()
        val throttleFromMs = thermals
            .firstOrNull { it.status.contains("throttl", ignoreCase = true) }
            ?.elapsedMs
        var elapsed = 0L
        var best = emptyList<Long>()
        var bestAvg = Double.POSITIVE_INFINITY
        val window = ArrayDeque<Long>()
        var windowNs = 0L
        for (f in frames) {
            window.addLast(f); windowNs += f; elapsed += f / 1_000_000L
            while (windowNs > 60_000_000_000L && window.isNotEmpty()) windowNs -= window.removeFirst()
            if (throttleFromMs == null || elapsed < throttleFromMs) {
                // peak = 最小平均帧时间（最高 FPS）的窗口
                val avg = windowNs.toDouble() / window.size.coerceAtLeast(1)
                if (window.size > 30 && avg < bestAvg) {
                    bestAvg = avg; best = window.toList()
                }
            }
        }
        return best.ifEmpty { frames }
    }
}
