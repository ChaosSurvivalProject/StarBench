package com.xqly.starbench.orchestrator

/**
 * Pre-flight：自动检查并记录。发现异常只记录并标注到报告，不中断、不弹窗要求处理。
 */
data class PreFlightReport(
    val deviceModel: String,
    val osVersion: String,
    val batteryPercent: Int,
    val charging: Boolean,
    val thermalNow: Float?,           // null => unavailable
    val thermalForecast: Float?,      // forecastSeconds=10；NaN/不支持 => null
    val roomTemperature: Float?,      // 无传感器则 null，提示玩家自评但不强制输入
    val backgroundLoad: String,
    val caseOn: Boolean?,
    val brightness: Int,
    val graphicsBackend: String,      // Vulkan / OpenGL ES
    val availableMemoryMb: Long,
    val networkConnected: Boolean,
    val visualSpecVersion: String,
    val assetPackHash: String,
    val notes: List<String>,
) {
    /** 异常只记录，供报告标注，不阻断一键流程。 */
    fun anomalies(): List<String> = buildList {
        if (charging) add("正在充电")
        if (batteryPercent in 0..15) add("电量偏低")
        if (caseOn == true) add("佩戴手机壳")
        if (!networkConnected) add("网络未连接（网络压测项将标 unavailable）")
        if (thermalNow == null) add("Thermal API 不支持（温度项 unavailable）")
    }
}
