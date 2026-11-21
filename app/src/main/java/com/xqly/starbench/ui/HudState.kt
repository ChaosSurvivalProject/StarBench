package com.xqly.starbench.ui

import com.xqly.starbench.common.Edition

/** 实时 HUD（默认开启，可一键收起；收起不影响采集）。风格按对应版本对齐。 */
data class HudState(
    val cpuPressure: String,      // unavailable 时直接显示 unavailable
    val gpuPressure: String,
    val temperature: String,
    val thermalStatus: String,
    val fps: Double,
    val frameMs: Double,
    val tickMs: Double,
    val renderDistance: Int,
    val simulateDistance: Int,
    val scenarioName: String,
    val edition: Edition,
    val visible: Boolean = true,
)
