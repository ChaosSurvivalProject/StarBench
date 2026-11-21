package com.xqly.starbench.advice

import com.xqly.starbench.common.Edition
import com.xqly.starbench.scoring.ScoreCard

enum class Bottleneck {
    GPU_BOUND, CPU_TICK_BOUND, THERMAL_BOUND, STABILITY_BOUND, NETWORK_BOUND, INSUFFICIENT_DATA
}

/** 每条建议必带依据指标、影响方向与适用引擎；禁止空泛话术与具体提升百分比承诺。 */
data class Advice(
    val text: String,
    val evidence: String,
    val direction: String,
    val edition: Edition,
    val rank: Int,
)

data class NetworkSummary(val rttMs: Double, val jitterMs: Double, val lossRate: Float)

/** 规则化改进意见（需求第九节）。阈值为设计建议，标注待验证，可按实测回归调整。 */
object AdviceEngine {

    fun generate(card: ScoreCard, network: NetworkSummary?): List<Advice> {
        val out = mutableListOf<Advice>()
        val e = card.edition

        // 温控：跌幅大 → 散热/环境/取壳/避免边充边跑/避免连续冷机对比
        if (card.thermalDropPercent >= 15.0) {
            out += Advice(
                text = "本次温控跌幅明显，优先改善散热：在凉爽环境测试、取下厚手机壳、不要边充电边跑，并在两轮之间让设备冷却。",
                evidence = "温控跌幅 ${fmt(card.thermalDropPercent)}%（峰值 ${fmt(card.peak.fps)} → 持续 ${fmt(card.sustained.harmonicFps)} FPS）",
                direction = "降低热降频，提升持续性能", edition = e, rank = out.size + 1,
            )
        }

        // CPU-Tick：MSPT/longest tick 高而帧时间尚可 → 降模拟距离/减实体与红石
        if (card.sustained.avgMspt >= 45.0 && card.low1Percent.jankRate < 0.05) {
            val lever = if (e == Edition.BEDROCK)
                "Bedrock 渲染与模拟解耦，优先下调模拟距离（这是更强杠杆）"
            else
                "Java 视距与模拟距离联动，下调模拟距离并注意视距联动变化"
            out += Advice(
                text = "Tick 耗时偏高而帧时间尚可：$lever，并减少密集实体与红石装置。",
                evidence = "avg MSPT ${fmt(card.sustained.avgMspt)} ms；Jank 率 ${fmt(card.low1Percent.jankRate * 100)}%",
                direction = "降低 CPU/Tick 压力", edition = e, rank = out.size + 1,
            )
        }

        // GPU：均频正常但帧时间高 → 降渲染距离/分辨率/华丽叶片粒子/切后端
        if (card.sustained.harmonicFps < 40.0 && card.low1Percent.jankRate < 0.08 && card.thermalDropPercent < 15.0) {
            out += Advice(
                text = "帧时间偏高但未观察到明显热降频：优先下调渲染距离 / 分辨率，关闭华丽叶片与粒子，或切换图形后端。",
                evidence = "持续 ${fmt(card.sustained.harmonicFps)} FPS，平均帧时间 ${fmt(card.sustained.avgFrameNs / 1e6)} ms",
                direction = "降低 GPU 渲染压力（渲染距离主要影响 GPU 帧率）", edition = e, rank = out.size + 1,
            )
        }

        // 稳定性：1% Low 明显低于平均、Jank 高 → 查尖峰来源
        if (card.low1Percent.fps1Percent > 0 && card.sustained.harmonicFps > 0 &&
            card.low1Percent.fps1Percent < card.sustained.harmonicFps * 0.6
        ) {
            out += Advice(
                text = "1% Low 明显低于平均：排查区块重建尖峰、GC、后台干扰、着色器编译与温度跃变，逐项固定单一变量复测。",
                evidence = "1% Low ${fmt(card.low1Percent.fps1Percent)} FPS vs 平均 ${fmt(card.sustained.harmonicFps)} FPS；p99 ${card.low1Percent.p99FrameNs / 1_000_000} ms",
                direction = "提升帧时间稳定性", edition = e, rank = out.size + 1,
            )
        }

        network?.let { n ->
            if (n.rttMs > 80 || n.jitterMs > 30 || n.lossRate > 0.02f) {
                out += Advice(
                    text = "网络指标未达标：结合多人模拟档位检查链路质量，降低虚拟玩家数与广播频率后复测。",
                    evidence = "RTT ${fmt(n.rttMs)} ms / 抖动 ${fmt(n.jitterMs)} ms / 丢包 ${fmt(n.lossRate * 100)}%",
                    direction = "降低网络压力与抖动", edition = e, rank = out.size + 1,
                )
            }
        }

        // 数据不足时不推测
        if (out.isEmpty()) {
            out += Advice(
                text = "本次各项指标处于正常区间或采集数据不足，暂无法给出明确瓶颈判断；建议在固定单一变量的条件下增加重复次数。",
                evidence = "温控跌幅 ${fmt(card.thermalDropPercent)}%，Jank 率 ${fmt(card.low1Percent.jankRate * 100)}%",
                direction = "补充数据后再判断", edition = e, rank = 1,
            )
        }

        return out.take(6).mapIndexed { i, a -> a.copy(rank = i + 1) }
    }

    fun bottleneck(card: ScoreCard, network: NetworkSummary?): Bottleneck = when {
        card.thermalDropPercent >= 20.0 -> Bottleneck.THERMAL_BOUND
        network != null && (network.rttMs > 80 || network.lossRate > 0.02f) -> Bottleneck.NETWORK_BOUND
        card.low1Percent.fps1Percent > 0 && card.low1Percent.fps1Percent < card.sustained.harmonicFps * 0.5 -> Bottleneck.STABILITY_BOUND
        card.sustained.avgMspt >= 45.0 -> Bottleneck.CPU_TICK_BOUND
        card.sustained.harmonicFps < 40.0 -> Bottleneck.GPU_BOUND
        else -> Bottleneck.INSUFFICIENT_DATA
    }

    private fun fmt(v: Double): String = "%.1f".format(v)
    private fun fmt(v: Float): String = "%.1f".format(v)
}
