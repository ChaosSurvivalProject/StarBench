package com.xqly.starbench.network

/**
 * 网络压测：本地 N 个虚拟玩家真实差集广播 + 连接自有远端端点实测上下行/RTT/抖动/丢包。
 * 不对接任何官方服务；不可得项一律 null（报告标 unavailable），禁止估算。
 */
data class NetworkSample(
    val rttMs: Double?,
    val jitterMs: Double?,
    val lossRate: Float?,
    val upKbps: Long?,
    val downKbps: Long?,
    val virtualPlayers: Int,
)

interface NetworkProbe {
    fun measure(endpoint: String, virtualPlayers: Int): NetworkSample

    /** 本地差集广播：只发送状态变化差集，真实产生同步负载。 */
    fun broadcastDeltas(tickIndex: Long, deltas: List<ByteArray>): Int
}
