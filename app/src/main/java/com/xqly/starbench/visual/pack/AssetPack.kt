package com.xqly.starbench.visual.pack

import com.xqly.starbench.visual.spec.VisualParitySpec

/** 资产路径：A=clean-room 独立重绘（默认可发布）；B=官方授权资源包（需书面授权）。 */
enum class AssetPackMode { A_CLEAN_ROOM, B_AUTHORIZED }

data class AssetPackDescriptor(
    val id: String,
    val mode: AssetPackMode,
    val specVersion: String,
    val resourceHash: String,
    val author: String,
    val creationLogRef: String,   // 路径 A 必填，指向自产创作记录
)

/** 打开资源包得到的句柄。只提供「按 key 取字节」，不暴露任何世界状态写入能力。 */
interface AssetHandle : AutoCloseable {
    fun resolve(key: String): ByteArray?
}

/**
 * 可切换资源层。
 * 硬约束：切换 A↔B 只替换资源，不得改变世界状态与工作量计数。
 */
interface AssetPack {
    val descriptor: AssetPackDescriptor
    val spec: VisualParitySpec
    fun open(): AssetHandle
}
