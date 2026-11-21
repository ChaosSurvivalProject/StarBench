package com.xqly.starbench.orchestrator

/**
 * 一键状态机（需求第七节）。单次点击触发，之后全程自动：
 * IDLE → NOTICE → PRE_FLIGHT → WARMUP → JAVA_RUN → COOLDOWN_CHECK → BEDROCK_RUN
 *      → NETWORK_STRESS → REPEAT(≥3) → SCORE → ADVICE → REPORT
 *
 * NOTICE 是常驻展示、不阻断；COOLDOWN_CHECK 未冷却也只记录并继续，绝不弹窗要玩家操作。
 */
enum class Phase {
    IDLE, NOTICE, PRE_FLIGHT, WARMUP, JAVA_RUN, COOLDOWN_CHECK, BEDROCK_RUN,
    NETWORK_STRESS, REPEAT, SCORE, ADVICE, REPORT, DONE,
}

data class PhaseEvent(val phase: Phase, val note: String = "", val elapsedMs: Long = 0L)

class BenchmarkStateMachine {
    var current: Phase = Phase.IDLE
        private set

    private val listeners = mutableListOf<(PhaseEvent) -> Unit>()

    fun onPhase(listener: (PhaseEvent) -> Unit) { listeners += listener }

    /** 唯一的玩家操作入口。之后不再需要任何点击/选择/确认。 */
    fun start() {
        require(current == Phase.IDLE) { "跑分已在进行中" }
        transition(Phase.NOTICE)
        transition(Phase.PRE_FLIGHT)
    }

    fun advance(to: Phase, note: String = "", elapsedMs: Long = 0L) {
        val allowed = when (current) {
            Phase.NOTICE -> to == Phase.PRE_FLIGHT
            Phase.PRE_FLIGHT -> to == Phase.WARMUP
            Phase.WARMUP -> to == Phase.JAVA_RUN
            Phase.JAVA_RUN -> to == Phase.COOLDOWN_CHECK
            Phase.COOLDOWN_CHECK -> to == Phase.BEDROCK_RUN
            Phase.BEDROCK_RUN -> to == Phase.NETWORK_STRESS
            Phase.NETWORK_STRESS -> to == Phase.REPEAT
            Phase.REPEAT -> to == Phase.SCORE
            Phase.SCORE -> to == Phase.ADVICE
            Phase.ADVICE -> to == Phase.REPORT
            Phase.REPORT -> to == Phase.DONE
            else -> false
        }
        require(allowed) { "非法状态迁移: $current -> $to" }
        transition(to, note, elapsedMs)
    }

    private fun transition(to: Phase, note: String = "", elapsedMs: Long = 0L) {
        current = to
        val e = PhaseEvent(to, note, elapsedMs)
        listeners.forEach { it(e) }
    }
}
