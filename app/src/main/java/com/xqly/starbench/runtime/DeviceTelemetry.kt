package com.xqly.starbench.runtime

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import java.io.BufferedReader
import java.io.FileReader

/**
 * Android 9 (API 28) 真实可得的采集项。
 *
 * 诚实边界（写进报告）：
 * - PerformanceHintManager(API 31+) 与 Thermal API getThermalHeadroom(API 29+) 在 API 28 不存在，
 *   因此 thermal headroom / ADPF hint 一律标 unavailable，不伪造。
 * - 电池温度来自 BatteryManager（整机电池口径，非 SoC 结温），如实标注。
 * - CPU 占用来自 /proc/stat 的两次采样差值（真实值）；部分设备不可读则 unavailable。
 */
class DeviceTelemetry(private val context: Context) {

    data class Sample(
        val cpuPercent: Float?,
        val batteryTempC: Float?,
        val usedMemoryMb: Long?,
        val thermalStatus: String,
        val note: String?,
    )

    private var lastCpu: LongArray? = null
    private val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    private val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager

    fun sample(): Sample {
        val cpu = sampleCpu()
        val temp = batteryTemp()
        val mem = usedMemory()
        val thermal = if (Build.VERSION.SDK_INT >= 29) "API>=29 (本次目标为 API28，未使用)" else "unavailable (API 28 无 Thermal API)"
        return Sample(cpu, temp, mem, thermal,
            "温度取自电池温度计，非 SoC 结温；thermal headroom 与 ADPF 在 Android 9 不可用。")
    }

    private fun sampleCpu(): Float? {
        val cur = readCpuStat() ?: return null
        val prev = lastCpu
        lastCpu = cur
        if (prev == null) return null
        val totalDelta = cur[0] - prev[0]
        if (totalDelta <= 0) return null
        val idleDelta = cur[1] - prev[1]
        return ((1f - idleDelta.toFloat() / totalDelta) * 100f).coerceIn(0f, 100f)
    }

    /** /proc/stat 第一行：user nice system idle iowait irq softirq steal guest guest_nice。 */
    private fun readCpuStat(): LongArray? = try {
        BufferedReader(FileReader("/proc/stat")).use { br ->
            val line = br.readLine() ?: return null
            val p = line.trim().split(Regex("\\s+"))
            if (p.size < 6) return null
            var total = 0L
            for (i in 1 until minOf(9, p.size)) total += p[i].toLongOrNull() ?: 0L
            val idle = (p[4].toLongOrNull() ?: 0L) + (p[5].toLongOrNull() ?: 0L)
            longArrayOf(total, idle)
        }
    } catch (e: Exception) {
        null
    }

    private fun batteryTemp(): Float? = try {
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val intent = context.registerReceiver(null, filter)
        val tenths = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
        if (tenths == null || tenths == Int.MIN_VALUE) null else tenths / 10f
    } catch (e: Exception) {
        null
    }

    private fun usedMemory(): Long? {
        val am = activityManager ?: return null
        val info = ActivityManager.MemoryInfo()
        am.getMemoryInfo(info)
        val used = info.totalMem - info.availMem
        if (used < 0) return null
        return used / (1024 * 1024)
    }
}
