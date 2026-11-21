package com.xqly.starbench.ui

import android.app.Activity
import android.graphics.Color
import android.opengl.GLSurfaceView
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.text.method.ScrollingMovementMethod
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.xqly.starbench.compliance.ComplianceText
import com.xqly.starbench.runtime.BenchmarkRunner
import com.xqly.starbench.runtime.DeviceTelemetry
import com.xqly.starbench.runtime.VoxelRenderer
import com.xqly.starbench.visual.pack.AssetPackMode
import java.io.File

/** 启动页 + 跑分页 + 报告页，单一 Activity，纯框架控件，零 AndroidX 依赖。 */
class MainActivity : Activity(), BenchmarkRunner.Listener {

    private lateinit var runner: BenchmarkRunner
    private lateinit var hud: TextView
    private lateinit var status: TextView
    private lateinit var startBtn: Button
    private lateinit var reportView: TextView
    private lateinit var renderer: VoxelRenderer

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val pad = 24

        root.addView(TextView(this).apply {
            text = "StarBench · 星穹旅驿一键等效负载跑分"
            textSize = 19f
            setTextColor(Color.rgb(0x1A, 0x1A, 0x2E))
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, 8)
        })

        // 温度告知：常驻非阻塞卡片，玩家点按钮之前就能看到
        root.addView(TextView(this).apply {
            text = "温度提示\n" + ComplianceText.TEMPERATURE_NOTICE
            textSize = 13f
            setTextColor(Color.rgb(0x44, 0x33, 0x00))
            setBackgroundColor(Color.rgb(0xFF, 0xF4, 0xD6))
            setPadding(pad, 16, pad, 16)
        })

        root.addView(TextView(this).apply {
            text = ComplianceText.statement(AssetPackMode.A_CLEAN_ROOM)
            textSize = 11f
            setTextColor(Color.GRAY)
            setPadding(pad, 8, pad, 8)
        })

        startBtn = Button(this).apply {
            text = "开始跑分（一键，全程自动）"
            isAllCaps = false
            setPadding(pad, 8, pad, 8)
        }
        root.addView(startBtn)

        status = TextView(this).apply {
            text = "状态：待机 · 目标平台 Android 9 (当前 API ${Build.VERSION.SDK_INT})"
            textSize = 13f
            setPadding(pad, 8, pad, 4)
        }
        root.addView(status)

        hud = TextView(this).apply {
            text = "实时 HUD 将在跑分中刷新"
            textSize = 12f
            setTextColor(Color.rgb(0x22, 0x44, 0x88))
            setPadding(pad, 4, pad, 4)
        }
        root.addView(hud)

        val glView = GLSurfaceView(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            setEGLContextClientVersion(2)
        }
        root.addView(glView)

        reportView = TextView(this).apply {
            textSize = 11f
            movementMethod = ScrollingMovementMethod()
            setBackgroundColor(Color.rgb(0xF5, 0xF5, 0xF8))
            setPadding(pad, 12, pad, 12)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 320)
        }
        root.addView(ScrollView(this).apply { addView(reportView) })

        setContentView(root)

        // 创建渲染器与编排器，并把渲染帧回调接到编排器（runner 记录真实帧耗时）
        renderer = VoxelRenderer(object : VoxelRenderer.RenderHook {
            override fun onFrame(dtSec: Float, workCounter: Long, chunkRebuilds: Int) {
                if (::runner.isInitialized) runner.onFrame(dtSec, workCounter, chunkRebuilds)
            }
        })
        runner = BenchmarkRunner(renderer, DeviceTelemetry(this))
        runner.listener = this
        glView.setRenderer(renderer)

        startBtn.setOnClickListener {
            if (runner.finished) {
                reportView.text = ""
                runner = BenchmarkRunner(renderer, DeviceTelemetry(this))
                runner.listener = this
            }
            startBtn.isEnabled = false
            runner.start()
        }
    }

    override fun onStatus(phase: String, detail: String, progress: Int) {
        runOnUiThread { status.text = "状态：$phase · $detail · $progress%" }
    }

    override fun onHud(hudText: String) {
        runOnUiThread { hud.text = hudText }
    }

    override fun onFinished(reportMarkdown: String, reportJson: String) {
        runOnUiThread {
            reportView.text = reportMarkdown
            startBtn.isEnabled = true
            startBtn.text = "再跑一次（一键）"
            val path = saveReport(reportMarkdown, reportJson)
            Toast.makeText(this, "跑分完成 · 报告已保存：$path", Toast.LENGTH_LONG).show()
        }
    }

    private fun saveReport(md: String, json: String): String {
        val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS), "StarBench").apply { mkdirs() }
        File(dir, "report.md").writeText(md)
        File(dir, "report.json").writeText(json)
        return dir.absolutePath
    }
}
