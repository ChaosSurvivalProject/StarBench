package com.xqly.starbench.telemetry

import com.xqly.starbench.common.FrequencySample
import com.xqly.starbench.common.RunMetrics
import com.xqly.starbench.common.ThermalSample
import kotlin.math.roundToLong

/** 帧时间统计。全部按真实样本计算；无样本返回 0，且由上层标记 unavailable。 */
object FrameStatistics {
    private const val NS_PER_SEC = 1_000_000_000.0

    /** 1% Low：帧生成时间降序取最慢 p% 样本的平均，换算 FPS。 */
    fun lowPercentFps(frameTimesNs: List<Long>, percentile: Double): Double {
        if (frameTimesNs.isEmpty()) return 0.0
        val sorted = frameTimesNs.sortedDescending()
        val count = maxOf(1, (sorted.size * percentile / 100.0).roundToLong().toInt())
        val avgSlow = sorted.take(count).map { it.toDouble() }.average()
        return NS_PER_SEC / avgSlow
    }

    fun p99FrameNs(frameTimesNs: List<Long>): Long = percentile(frameTimesNs, 0.99)

    /** Jank 率：超过 2×目标帧预算的帧占比。 */
    fun jankRate(frameTimesNs: List<Long>, targetNs: Long): Double {
        if (frameTimesNs.isEmpty()) return 0.0
        val limit = targetNs * 2
        return frameTimesNs.count { it > limit }.toDouble() / frameTimesNs.size
    }

    /** 调和平均 FPS = 1e9 / 平均帧时间（比算术平均更保守，避免高帧样本稀释卡顿）。 */
    fun harmonicMeanFps(frameTimesNs: List<Long>): Double {
        if (frameTimesNs.isEmpty()) return 0.0
        val avgNs = frameTimesNs.map { it.toDouble() }.average()
        return NS_PER_SEC / avgNs
    }

    private fun percentile(values: List<Long>, q: Double): Long {
        if (values.isEmpty()) return 0L
        val sorted = values.sorted()
        val idx = minOf(sorted.size - 1, maxOf(0, ((sorted.size - 1) * q).toInt()))
        return sorted[idx]
    }
}

/**
 * 采集层：帧时间 + 温度/热状态 + 频率。
 * Thermal API(29+) 与 PerformanceHintManager(31+) 按 SDK_INT 守卫；不支持时标 unavailable，
 * 绝不填 0 或估算冒充实测。
 */
interface MetricSink {
    fun onFrame(frameTimeNs: Long)
    fun onThermal(sample: ThermalSample)
    fun onFrequency(sample: FrequencySample)
    fun snapshot(): RunMetrics
}

/** 频率/热状态提示的合法通道：按真实帧耗时上报，不对抗温控。 */
interface HintSession {
    fun reportActualWorkDuration(ns: Long)
    fun updateTargetWorkDuration(ns: Long)
    fun close()
}
