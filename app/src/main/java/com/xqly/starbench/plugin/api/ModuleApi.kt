package com.xqly.starbench.plugin.api

import com.xqly.starbench.common.Edition
import com.xqly.starbench.telemetry.MetricSink
import com.xqly.starbench.visual.pack.AssetPackDescriptor

/** 稳定 IDL：模块作用域。 */
enum class EngineScope { JAVA, BEDROCK, BOTH }

data class WorkloadDescriptor(
    val id: String,
    val engineScope: EngineScope,
    val scenarioId: String,
    val requiredCapabilities: List<String>,
)

data class ModuleTickContext(val edition: Edition, val tickIndex: Long, val seed: Long)
data class ModuleFrameContext(val edition: Edition, val frameNonce: Long, val frameTimeNs: Long)

/**
 * 模组接口契约（需求第十节）。
 * 强约束：签名校验 + 版本协商 + 独立 ClassLoader/进程沙箱 + 资源配额
 *        + 禁止访问网络与玩家数据 + 模块崩溃不阻断主跑分（仅标该模块结果无效）。
 * 自定义 AssetPack 必须过与路径 B 相同的授权凭证门禁。
 */
interface LoadModule {
    val id: String
    val version: String
    val engineScope: EngineScope
    val requiredCapabilities: List<String>

    fun onLoad()
    fun onPrepare(seed: Long, scenario: String)
    fun onTick(ctx: ModuleTickContext)
    fun onFrame(ctx: ModuleFrameContext)
    fun onCollect(metrics: MetricSink)
    fun onTeardown()

    fun registerWorkload(descriptor: WorkloadDescriptor)
    fun contribute(sink: MetricSink)

    /** 注册自定义视觉资源包；必须过同一套授权凭证校验，否则标「视觉对齐未通过」。 */
    fun registerAssetPack(descriptor: AssetPackDescriptor)
}

/** 模块宿主的加载结果：失败只标无效，不阻断主流程。 */
sealed class LoadResult {
    data class Ok(val module: LoadModule) : LoadResult()
    data class Rejected(val reason: String) : LoadResult() // 签名失败 / 版本不协商 / 资源包未授权
}

interface ModuleHost {
    fun load(id: String): LoadResult
    fun loadedModules(): List<LoadModule>
}
