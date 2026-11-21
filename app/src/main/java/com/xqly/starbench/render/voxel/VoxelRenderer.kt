package com.xqly.starbench.render.voxel

import com.xqly.starbench.common.Seed
import com.xqly.starbench.engine.WorldState
import com.xqly.starbench.visual.pack.AssetPack
import com.xqly.starbench.visual.spec.VisualParitySpec

/**
 * 帧边界的不可变世界快照。渲染层只接受它——
 * 接口里【没有】playVideo / showImage / preloadFrames / setWallpaper 之类的入口，
 * 从类型上排除视频回放、截图轮播、预录帧、静态壁纸。
 */
data class WorldSnapshot(
    val seed: Seed,
    val tickIndex: Long,
    val frameNonce: Long,   // 递增，CI 校验相邻帧状态哈希变化
    val state: WorldState,
    val hash: Long,
)

data class FrameMeta(val frameTimeNs: Long, val renderDistance: Int, val simulateDistance: Int, val scenarioId: String)
data class RenderStats(val drawCalls: Int, val visibleChunks: Int, val triangles: Int)

/**
 * 体素渲染器契约。渲染是 WorldState 的投影，不是独立驱动：
 * 区块重建、光照更新、红石与实体状态变化必须来自同一份快照并在画面可见。
 */
interface VoxelRenderer {
    val spec: VisualParitySpec

    fun render(snapshot: WorldSnapshot, frameMeta: FrameMeta): RenderStats

    /** HUD 可一键收起，但采集层独立读取引擎状态，收起不影响数据采集。 */
    fun setHudVisible(visible: Boolean)

    /** 切换资源层只替换资源，不得改变世界状态与工作量计数。 */
    fun switchAssetPack(pack: AssetPack)
}
