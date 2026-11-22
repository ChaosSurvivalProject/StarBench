package com.xqly.starbench.runtime

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.GLUtils
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.cos
import kotlin.math.sin

/**
 * OpenGL ES 2.0 体素渲染器——Android 9 (API 28) 原生支持。
 * 画面逐帧由 VoxelWorld 的真实状态构建，非视频/截图/预录帧。
 * 相机固定运镜脚本（绕世界中心盘旋 + 缓慢升降），保证不同设备画面口径一致。
 */
class VoxelRenderer(hook: RenderHook, private val context: Context) : GLSurfaceView.Renderer {

    interface RenderHook {
        /** 每帧回调：传入 dt 秒与当前场景工作量计数，由编排层记录真实帧耗时。 */
        fun onFrame(dtSec: Float, workCounter: Long, chunkRebuilds: Int)
    }

    @Volatile
    private var hook: RenderHook = hook

    fun setHook(h: RenderHook) { hook = h }

    @Volatile
    var running = false

    /** 每个 case 的世界尺寸与实体数，由编排层在场景切换时设置。 */
    @Volatile
    var worldX = 40
    @Volatile
    var worldZ = 40
    @Volatile
    var activeEntities = 12
    @Volatile
    var chunkWorkPerFrame = 1

    private val world = VoxelWorld(40, 40, 22, 20261122L)
    private var program = 0
    private var aPos = 0
    private var aColor = 0
    private var aUV = 0
    private var uMvp = 0
    private var uTint = 0
    private var uTex = 0
    private var vbo = 0
    private var texId = 0
    private var vertexCount = 0
    private var viewW = 1
    private var viewH = 1

    private var lastNs = 0L
    private var camAngle = 0f
    private var chunkCursor = 0
    private var chunkRebuildsThisFrame = 0
    @Volatile
    var scenarioLabel = "预热"

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0.53f, 0.76f, 0.92f, 1f)
        GLES20.glEnable(GLES20.GL_DEPTH_TEST)
        program = buildProgram(VERTEX_SHADER, FRAGMENT_SHADER)
        aPos = GLES20.glGetAttribLocation(program, "aPos")
        aColor = GLES20.glGetAttribLocation(program, "aColor")
        aUV = GLES20.glGetAttribLocation(program, "aUV")
        uMvp = GLES20.glGetUniformLocation(program, "uMvp")
        uTint = GLES20.glGetUniformLocation(program, "uTint")
        uTex = GLES20.glGetUniformLocation(program, "uTex")
        val buffers = IntArray(1)
        GLES20.glGenBuffers(1, buffers, 0)
        vbo = buffers[0]
        // Faithful 64x 图集纹理
        val tex = IntArray(1)
        GLES20.glGenTextures(1, tex, 0)
        texId = tex[0]
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texId)
        val atlas: Bitmap = context.assets.open("atlas64.png").use { BitmapFactory.decodeStream(it) }
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, atlas, 0)
        atlas.recycle()
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
        world.regenerate()
        uploadMesh(world.buildMesh())
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        viewW = width.coerceAtLeast(1)
        viewH = height.coerceAtLeast(1)
        GLES20.glViewport(0, 0, viewW, viewH)
    }

    override fun onDrawFrame(gl: GL10?) {
        val now = System.nanoTime()
        val dt = if (lastNs == 0L) 1f / 60f else ((now - lastNs) / 1_000_000_000f).coerceIn(0f, 0.1f)
        lastNs = now

        // 真实逐帧世界运算：区块重建 + 实体 tick，工作量随当前场景变化
        chunkRebuildsThisFrame = 0
        if (running) {
            val cs = 8
            val cols = (world.sizeX + cs - 1) / cs
            repeat(chunkWorkPerFrame.coerceAtLeast(1)) {
                val cx = (chunkCursor % cols) * cs
                val cz = ((chunkCursor / cols) % cols) * cs
                world.chunkRebuildWork(cx, cz, cs)
                chunkCursor++
                chunkRebuildsThisFrame++
            }
            world.tickEntities(dt, activeEntities)
        }

        // 相机固定运镜脚本：所有设备同种子同轨迹
        camAngle += dt * 0.35f
        val radius = world.sizeX * 0.95f
        val eyeX = world.sizeX / 2f + cos(camAngle) * radius
        val eyeZ = world.sizeZ / 2f + sin(camAngle) * radius
        val eyeY = world.height * 1.15f + sin(camAngle * 0.7f) * 4f
        val mvp = multiply(projection(55f, viewW.toFloat() / viewH, 0.1f, 500f),
            lookAt(floatArrayOf(eyeX, eyeY, eyeZ),
                floatArrayOf(world.sizeX / 2f, world.height * 0.35f, world.sizeZ / 2f),
                floatArrayOf(0f, 1f, 0f)))

        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        GLES20.glUseProgram(program)
        GLES20.glUniformMatrix4fv(uMvp, 1, false, mvp, 0)
        GLES20.glUniform3f(uTint, 1f, 1f, 1f)
        // 绑定 Faithful 图集到纹理单元 0
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texId)
        GLES20.glUniform1i(uTex, 0)

        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, vbo)
        GLES20.glEnableVertexAttribArray(aPos)
        GLES20.glVertexAttribPointer(aPos, 3, GLES20.GL_FLOAT, false, 32, 0)
        GLES20.glEnableVertexAttribArray(aColor)
        GLES20.glVertexAttribPointer(aColor, 3, GLES20.GL_FLOAT, false, 32, 12)
        GLES20.glEnableVertexAttribArray(aUV)
        GLES20.glVertexAttribPointer(aUV, 2, GLES20.GL_FLOAT, false, 32, 24)

        // 每隔若干帧从真实世界状态重建一次网格——区块/光照变化在画面上可见
        if (running && chunkCursor % 24 == 0) uploadMesh(world.buildMesh())
        if (vertexCount > 0) GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, vertexCount)

        hook.onFrame(dt, world.workCounter, chunkRebuildsThisFrame)
    }

    private fun uploadMesh(mesh: VoxelMesh) {
        vertexCount = mesh.vertexCount
        if (mesh.vertices.isEmpty()) return
        val bb = ByteBuffer.allocateDirect(mesh.vertices.size * 4).order(ByteOrder.nativeOrder())
        bb.asFloatBuffer().put(mesh.vertices)
        bb.position(0)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, vbo)
        GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, bb.capacity(), bb, GLES20.GL_DYNAMIC_DRAW)
    }

    /** 供编排层读取当前累计工作量计数（真实执行累加）。 */
    fun currentWorkCounter(): Long = world.workCounter

    /** 场景切换：改变视距对应世界规模，触发真实重新生成。 */
    fun applyScenario(sizeX: Int, sizeZ: Int, entities: Int, chunkWork: Int, label: String) {
        worldX = sizeX
        worldZ = sizeZ
        activeEntities = entities
        chunkWorkPerFrame = chunkWork
        scenarioLabel = label
        world.regenerate(sizeX, sizeZ, 22)
        uploadMesh(world.buildMesh())
    }

    companion object {
        private const val VERTEX_SHADER = """
            attribute vec3 aPos;
            attribute vec3 aColor;
            attribute vec2 aUV;
            uniform mat4 uMvp;
            varying vec3 vColor;
            varying vec2 vUV;
            void main() {
                gl_Position = uMvp * vec4(aPos, 1.0);
                vColor = aColor;
                vUV = aUV;
            }
        """
        private const val FRAGMENT_SHADER = """
            precision mediump float;
            varying vec3 vColor;
            varying vec2 vUV;
            uniform vec3 uTint;
            uniform sampler2D uTex;
            void main() {
                vec4 tex = texture2D(uTex, vUV);
                // Faithful 叶片 alpha 镂空（fast-leaves），水的 alpha=180 保留
                if (tex.a < 0.5) discard;
                vec3 col = tex.rgb * vColor * uTint;
                gl_FragColor = vec4(col, 1.0);
            }
        """

        private fun compile(type: Int, src: String): Int {
            val s = GLES20.glCreateShader(type)
            GLES20.glShaderSource(s, src)
            GLES20.glCompileShader(s)
            return s
        }

        private fun buildProgram(vs: String, fs: String): Int {
            val p = GLES20.glCreateProgram()
            GLES20.glAttachShader(p, compile(GLES20.GL_VERTEX_SHADER, vs))
            GLES20.glAttachShader(p, compile(GLES20.GL_FRAGMENT_SHADER, fs))
            GLES20.glLinkProgram(p)
            return p
        }

        private fun projection(fovDeg: Float, aspect: Float, near: Float, far: Float): FloatArray {
            val f = 1f / kotlin.math.tan(Math.toRadians(fovDeg.toDouble()).toFloat() / 2f)
            val nf = 1f / (near - far)
            return floatArrayOf(
                f / aspect, 0f, 0f, 0f,
                0f, f, 0f, 0f,
                0f, 0f, (far + near) * nf, -1f,
                0f, 0f, 2f * far * near * nf, 0f,
            )
        }

        private fun lookAt(eye: FloatArray, center: FloatArray, up: FloatArray): FloatArray {
            var zx = eye[0] - center[0]; var zy = eye[1] - center[1]; var zz = eye[2] - center[2]
            var l = kotlin.math.sqrt(zx * zx + zy * zy + zz * zz)
            zx /= l; zy /= l; zz /= l
            var xx = up[1] * zz - up[2] * zy
            var xy = up[2] * zx - up[0] * zz
            var xz = up[0] * zy - up[1] * zx
            l = kotlin.math.sqrt(xx * xx + xy * xy + xz * xz)
            if (l == 0f) { xx = 1f; xy = 0f; xz = 0f } else { xx /= l; xy /= l; xz /= l }
            val yx = zy * xz - zz * xy
            val yy = zz * xx - zx * xz
            val yz = zx * xy - zy * xx
            return floatArrayOf(
                xx, yx, zx, 0f,
                xy, yy, zy, 0f,
                xz, yz, zz, 0f,
                -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
                -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
                -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1f,
            )
        }

        private fun multiply(a: FloatArray, b: FloatArray): FloatArray {
            val out = FloatArray(16)
            for (c in 0..3) for (r in 0..3) {
                var s = 0f
                for (k in 0..3) s += a[k * 4 + r] * b[c * 4 + k]
                out[c * 4 + r] = s
            }
            return out
        }
    }
}
