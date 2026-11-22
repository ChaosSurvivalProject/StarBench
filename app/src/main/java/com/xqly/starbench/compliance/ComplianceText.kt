package com.xqly.starbench.compliance

import com.xqly.starbench.visual.pack.AssetPackMode

/** 文案唯一来源，UI 与报告从此处取，避免表述漂移。详见 docs/COMPLIANCE.md。 */
object ComplianceText {

    const val BRAND = "星穹旅驿官方出品"

    /** Faithful 64x 开源材质署名（Faithful License 要求在显著位置署名并链接官网）。 */
    const val FAITHFUL_CREDIT: String =
        "方块材质：Faithful 64x（faithfulpack.net）· 开源社区资源，非 Mojang / Microsoft 官方美术。"

    /** 启动页常驻卡片 + 首启一次性说明。不阻断流程、不弹二次确认。 */
    const val TEMPERATURE_NOTICE: String =
        "温度会明显影响本次成绩。手机越热，系统越会降低 CPU/GPU 频率，分数和帧率就会下降。" +
        "为更接近设备真实峰值，建议：在凉爽环境、取下厚手机壳、不要边充电边跑、关闭后台应用，" +
        "并让手机先静置冷却几分钟。我们会在报告中同时给出「峰值性能」「平均性能」和「温控影响幅度」，" +
        "你可以直接看到这台设备在持续高负载下掉了多少。跑分过程全自动，点一下就好。"

    /** 按资产模式动态显示，路径 B 文案不得超出授权协议范围。 */
    fun statement(mode: AssetPackMode, credentialId: String? = null): String = when (mode) {
        AssetPackMode.A_CLEAN_ROOM ->
            "$BRAND · 独立实现，画面按我的世界视觉规范 1:1 对齐 · " +
            "非 Mojang / Microsoft 官方产品，未获其授权或认可 · 不含任何官方资源文件与商标。"
        AssetPackMode.B_AUTHORIZED ->
            "$BRAND · 画面资源在 Mojang / Microsoft 授权范围内使用（凭证编号：${credentialId ?: "未提供"}）· " +
            "本产品非官方客户端。"
    }
}
