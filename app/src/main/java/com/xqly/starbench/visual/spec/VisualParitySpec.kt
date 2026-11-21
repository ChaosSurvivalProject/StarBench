package com.xqly.starbench.visual.spec

import com.xqly.starbench.common.Edition

/** 1:1 视觉对齐的 8 个维度（需求 5.1）。逐项版本化，按引擎分别维护。 */
enum class ParityDimension {
    BLOCKS_TEXTURES,     // 方块与贴图、透明、动画、破坏裂纹
    WORLD_GEOMETRY,      // 区块网格、面剔除、AO、天空/云/雾
    LIGHTING,            // 天空光+方块光、传播可见、昼夜曲线
    BIOMES,              // 群系配色、过渡带、植被
    ENTITIES,            // 外形、动画、粒子、挂载
    FLUIDS_REDSTONE,     // 流体与红石可见性，与运算层同步
    UI_HUD,              // 字体、准星、热键栏、调试信息
    VERSION_DIFFERENCES, // Java / Bedrock 细节差异分别对齐
}

enum class ParityStatus { VERIFIED, PENDING_VERIFICATION }

data class DimensionBaseline(
    val description: String,
    val status: ParityStatus,
    val evidence: String = "",   // 开发期比对记录；参照素材不进发布包
)

/** 来源与授权溯源。公开资料不足的参数一律 pendingVerification=true。 */
data class Provenance(
    val source: String,
    val pendingVerification: Boolean,
    val authorizationCredentialId: String? = null,
)

/**
 * 版本化 1:1 对齐清单。edition 字段强制 Java / Bedrock 各一份，禁止一份基线通吃。
 * 资源包哈希变化或 spec 版本变化触发 CI 视觉回归门禁。
 */
data class VisualParitySpec(
    val version: String,
    val edition: Edition,
    val dimensions: Map<ParityDimension, DimensionBaseline>,
    val resourcePackHash: String,
    val provenance: Provenance,
) {
    val specId: String get() = "${edition.name}-$version"

    companion object {
        /** 全部维度都必须有基线，否则视为不完整 spec，CI 门禁拒绝出包。 */
        fun isComplete(spec: VisualParitySpec): Boolean =
            ParityDimension.entries.all { it in spec.dimensions }

        /** 路径 A 不得带授权凭证；路径 B 必须带。 */
        fun authorizationConsistent(spec: VisualParitySpec, isAuthorizedPack: Boolean): Boolean =
            if (isAuthorizedPack) spec.provenance.authorizationCredentialId != null
            else spec.provenance.authorizationCredentialId == null
    }
}
