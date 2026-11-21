package com.xqly.starbench.common

/**
 * Kotlin ↔ C++/NDK 的 JNI 契约。
 * 原生侧实现见 app/src/main/cpp/；所有负载都必须由原生侧真实计算，Kotlin 层不伪造数值。
 */
object NativeBridge {
    init {
        System.loadLibrary("starbench-native")
    }

    external fun javaTick(seed: Long, tickIndex: Long, simulateDistance: Int): Double
    external fun bedrockTick(seed: Long, tickIndex: Long, simulateDistance: Int): Double
    external fun rebuildChunks(seed: Long, centerX: Int, centerZ: Int, radius: Int): Long
    external fun propagateLight(seed: Long, count: Int): Long
    external fun updateRedstone(seed: Long, density: Float): Long
    external fun stepEntities(seed: Long, count: Int): Long
    external fun syncNetwork(virtualPlayers: Int, ticks: Int): Long
    external fun worldSnapshotHash(): Long
}
