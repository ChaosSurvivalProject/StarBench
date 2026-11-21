package com.xqly.starbench.compliance

import com.xqly.starbench.visual.pack.AssetPackMode

/** 书面授权凭证。原始文件仅存在于构建环境，绝不入库；这里只存编号与范围。 */
data class AuthorizationCredential(
    val id: String,
    val scope: String,
    val documentRef: String,   // 构建环境归档路径，由 CI 校验存在性
)

sealed class PublishDecision {
    object Allow : PublishDecision()
    data class Deny(val reason: String) : PublishDecision()
}

/**
 * 授权前置门禁（CI 发布侧，不是玩家侧操作）。
 * 路径 B 在没有有效凭证时无法被判定为可发布——从构造层杜绝未授权出包。
 */
class AuthorizationGate(private val credential: AuthorizationCredential?) {

    fun evaluate(mode: AssetPackMode): PublishDecision = when (mode) {
        AssetPackMode.A_CLEAN_ROOM -> PublishDecision.Allow
        AssetPackMode.B_AUTHORIZED -> {
            val c = credential
            when {
                c == null -> PublishDecision.Deny("路径 B 需要 Mojang/Microsoft 书面授权凭证，当前缺失")
                c.id.isBlank() -> PublishDecision.Deny("授权凭证编号为空")
                c.documentRef.isBlank() -> PublishDecision.Deny("授权凭证原始文件未归档，CI 无法校验")
                else -> PublishDecision.Allow
            }
        }
    }

    fun requirePublishable(mode: AssetPackMode) {
        when (val d = evaluate(mode)) {
            PublishDecision.Allow -> Unit
            is PublishDecision.Deny -> throw IllegalStateException("禁止出包：${d.reason}")
        }
    }

    /** 报告页脚/关于页文案的凭证编号；仅路径 B 且门禁通过时非空。 */
    fun credentialIdFor(mode: AssetPackMode): String? =
        if (mode == AssetPackMode.B_AUTHORIZED && evaluate(mode) is PublishDecision.Allow) credential?.id
        else null
}
