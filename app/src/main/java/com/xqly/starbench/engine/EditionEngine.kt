package com.xqly.starbench.engine

import com.xqly.starbench.common.Edition
import com.xqly.starbench.common.Seed
import com.xqly.starbench.common.WorkloadCounters

/**
 * 双引擎统一契约。
 *
 * 关键：这是唯一被编排层持有的引擎类型。Java 与 Bedrock 各自独立实现全部六个方法，
 * 编译期不存在「一个引擎靠 if(edition) 开关切两个版本」的路径。
 * 两套实现之间只共享接口与数据结构，不共享任何逻辑实现。
 */
interface EditionEngine {
    val edition: Edition
    val rulePackVersion: String

    fun tick(ctx: TickContext): TickResult
    fun chunkSchedule(ctx: ChunkContext): ChunkResult
    fun lighting(ctx: LightingContext): LightingResult
    fun redstone(ctx: RedstoneContext): RedstoneResult
    fun entityAI(ctx: EntityContext): EntityResult
    fun networkSync(ctx: NetworkContext): SyncResult

    /** 供渲染层读取的当帧权威世界状态——渲染是它的投影，不是另一套驱动。 */
    fun worldState(): WorldState

    /** 本版本合法的模拟距离范围（Java 5–32；Bedrock 偶数 4–12）。 */
    fun legalSimulateDistanceRange(): IntRange
    fun defaultSimulateDistance(): Int
    fun simulateDistanceMutable(): Boolean
}

data class TickContext(val seed: Seed, val tickIndex: Long, val tps: Int, val simulateDistance: Int, val renderDistance: Int)
data class TickResult(val mspt: Double, val work: WorkloadCounters)

data class ChunkContext(val seed: Seed, val centerX: Int, val centerZ: Int, val renderDistance: Int, val simulateDistance: Int)
data class ChunkResult(val rebuilt: Int, val ticked: Int, val visible: Int, val rebuildMs: Double)

data class LightingContext(val seed: Seed, val tickIndex: Long, val propagateCount: Int)
data class LightingResult(val updates: Long, val ms: Double)

data class RedstoneContext(val seed: Seed, val tickIndex: Long, val density: Float)
data class RedstoneResult(val updates: Long, val ms: Double)

data class EntityContext(val seed: Seed, val tickIndex: Long, val count: Int, val simulateDistance: Int)
data class EntityResult(val entityTicks: Long, val ms: Double, val longestTickMs: Double)

data class NetworkContext(val seed: Seed, val virtualPlayers: Int, val ticks: Int)
data class SyncResult(val packets: Long, val rttMs: Double, val jitterMs: Double, val lossRate: Float)

/** 渲染层读取的世界状态切片；帧边界取不可变快照后交给 VoxelRenderer。 */
data class ChunkState(val x: Int, val z: Int, val meshHash: Long, val lightLevel: Int)
data class EntityState(val id: Long, val type: String, val x: Double, val y: Double, val z: Double, val pose: String)
data class WorldEvent(val tick: Long, val type: String, val payload: String)

data class WorldState(
    val seed: Seed,
    val tickIndex: Long,
    val chunks: List<ChunkState>,
    val entities: List<EntityState>,
    val events: List<WorldEvent>,
    val work: WorkloadCounters,
)
