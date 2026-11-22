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
import java.nio.ShortBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.cos
import kotlin.math.sin

/**
 * OpenGL ES 2.0 体素渲染器——Android 9 (API 28) 原生支持。
 * 地形（Faithful 64x 图集）+ 动物（22i GPL-3.0 生物模型图集）两套程序逐帧真实绘制。
 */
class VoxelRenderer(hook: RenderHook, private val context: Context) : GLSurfaceView.Renderer {

    interface RenderHook {
        fun onFrame(dtSec: Float, workCounter: Long, chunkRebuilds: Int)
    }

    @Volatile private var hook: RenderHook = hook
    fun setHook(h: RenderHook) { hook = h }
    @Volatile var running = false

    @Volatile var worldChunks = 2
    @Volatile var activeEntities = 12
    @Volatile var chunkWorkPerFrame = 1
    @Volatile var height = 48
    @Volatile var scenarioLabel = "预热"

    private var world = VoxelWorld(2, 48, 20261122L, 24)
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

    // 动物渲染资源
    private var mobProgram = 0
    private var mobTexId = 0
    private var maPos = 0; private var maUV = 0; private var maShade = 0
    private var muMvp = 0; private var muModel = 0; private var muTex = 0
    private class MobGpu(val vboPos: Int, val vboUv: Int, val vboShade: Int, val ibo: Int, val indexCount: Int)
    private val mobGpu = HashMap<String, MobGpu>()

    private var lastNs = 0L
    private var camAngle = 0f
    private var chunkCursor = 0
    private var chunkRebuildsThisFrame = 0

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0.62f, 0.76f, 0.90f, 1f)
        GLES20.glEnable(GLES20.GL_DEPTH_TEST)

        program = buildProgram(VERTEX_SHADER, FRAGMENT_SHADER)
        aPos = GLES20.glGetAttribLocation(program, "aPos")
        aColor = GLES20.glGetAttribLocation(program, "aColor")
        aUV = GLES20.glGetAttribLocation(program, "aUV")
        uMvp = GLES20.glGetUniformLocation(program, "uMvp")
        uTint = GLES20.glGetUniformLocation(program, "uTint")
        uTex = GLES20.glGetUniformLocation(program, "uTex")
        val buffers = IntArray(1); GLES20.glGenBuffers(1, buffers, 0); vbo = buffers[0]

        val tex = IntArray(1); GLES20.glGenTextures(1, tex, 0); texId = tex[0]
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texId)
        loadTexture("atlas64.png")
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)

        // 动物程序 + 图集
        mobProgram = buildProgram(MOB_VERTEX_SHADER, MOB_FRAGMENT_SHADER)
        maPos = GLES20.glGetAttribLocation(mobProgram, "aPos")
        maUV = GLES20.glGetAttribLocation(mobProgram, "aUV")
        maShade = GLES20.glGetAttribLocation(mobProgram, "aShade")
        muMvp = GLES20.glGetUniformLocation(mobProgram, "uMvp")
        muModel = GLES20.glGetUniformLocation(mobProgram, "uModel")
        muTex = GLES20.glGetUniformLocation(mobProgram, "uTex")
        val mtex = IntArray(1); GLES20.glGenTextures(1, mtex, 0); mobTexId = mtex[0]
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, mobTexId)
        loadTexture("mobatlas.png")
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)

        MobModels.load(context)
        for (name in MobModels.models.keys) {
            val mesh = MobModels.buildMesh(name) ?: continue
            val bs = IntArray(4); GLES20.glGenBuffers(4, bs, 0)
            GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, bs[0])
            GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, mesh.pos.size * 4, floatBuffer(mesh.pos), GLES20.GL_STATIC_DRAW)
            GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, bs[1])
            GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, mesh.uv.size * 4, floatBuffer(mesh.uv), GLES20.GL_STATIC_DRAW)
            GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, bs[2])
            GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, mesh.shade.size * 4, floatBuffer(mesh.shade), GLES20.GL_STATIC_DRAW)
            GLES20.glBindBuffer(GLES20.GL_ELEMENT_ARRAY_BUFFER, bs[3])
            GLES20.glBufferData(GLES20.GL_ELEMENT_ARRAY_BUFFER, mesh.idx.size * 2, shortBuffer(mesh.idx), GLES20.GL_STATIC_DRAW)
            mobGpu[name] = MobGpu(bs[0], bs[1], bs[2], bs[3], mesh.idx.size)
        }

        world.regenerate()
        uploadMesh(world.buildMesh())
    }

    private fun loadTexture(name: String) {
        val bmp: Bitmap = context.assets.open(name).use { BitmapFactory.decodeStream(it) }
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bmp, 0)
        bmp.recycle()
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

        chunkRebuildsThisFrame = 0
        if (running) {
            repeat(chunkWorkPerFrame.coerceAtLeast(1)) {
                world.rebuildSections(1)
                chunkRebuildsThisFrame++
            }
            world.tickEntities(dt, activeEntities)
        }

        camAngle += dt * 0.35f
        val radius = world.sizeX * 0.62f
        val groundY = world.averageGroundY()
        val eyeX = world.sizeX / 2f + cos(camAngle) * radius
        val eyeZ = world.sizeZ / 2f + sin(camAngle) * radius
        val eyeY = groundY + 6f + sin(camAngle * 0.7f) * 2.5f
        val mvp = multiply(
            projection(50f, viewW.toFloat() / viewH, 0.1f, world.sizeX * 4f + 400f),
            lookAt(floatArrayOf(eyeX, eyeY, eyeZ),
                floatArrayOf(world.sizeX / 2f, groundY + 1.5f, world.sizeZ / 2f),
                floatArrayOf(0f, 1f, 0f)))

        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)

        // ---- 地形 ----
        GLES20.glUseProgram(program)
        GLES20.glUniformMatrix4fv(uMvp, 1, false, mvp, 0)
        GLES20.glUniform3f(uTint, 1f, 1f, 1f)
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
        if (running && chunkCursor % 24 == 0) uploadMesh(world.buildMesh())
        if (vertexCount > 0) GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, vertexCount)

        // ---- 动物 ----
        if (mobGpu.isNotEmpty()) {
            GLES20.glUseProgram(mobProgram)
            GLES20.glUniformMatrix4fv(muMvp, 1, false, mvp, 0)
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, mobTexId)
            GLES20.glUniform1i(muTex, 0)
            val ds = 2.0f // 显示放大，体素动物更清晰（压力不变）
            val n = activeEntities.coerceAtMost(world.mobs.size)
            for (i in 0 until n) {
                val e = world.mobs[i]
                val g = mobGpu[e.type] ?: continue
                GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, g.vboPos)
                GLES20.glEnableVertexAttribArray(maPos)
                GLES20.glVertexAttribPointer(maPos, 3, GLES20.GL_FLOAT, false, 0, 0)
                GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, g.vboUv)
                GLES20.glEnableVertexAttribArray(maUV)
                GLES20.glVertexAttribPointer(maUV, 2, GLES20.GL_FLOAT, false, 0, 0)
                GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, g.vboShade)
                GLES20.glEnableVertexAttribArray(maShade)
                GLES20.glVertexAttribPointer(maShade, 1, GLES20.GL_FLOAT, false, 0, 0)
                GLES20.glBindBuffer(GLES20.GL_ELEMENT_ARRAY_BUFFER, g.ibo)
                val bob = kotlin.math.abs(sin(e.legPhase)) * 0.06f
                GLES20.glUniformMatrix4fv(muModel, 1, false, modelMatrix(e.x, e.y + bob, e.z, e.yaw, ds), 0)
                GLES20.glDrawElements(GLES20.GL_TRIANGLES, g.indexCount, GLES20.GL_UNSIGNED_SHORT, 0)
            }
        }

        hook.onFrame(dt, world.workCounter, chunkRebuildsThisFrame)
    }

    private fun uploadMesh(mesh: VoxelMesh) {
        vertexCount = mesh.vertexCount
        if (mesh.vertices.isEmpty()) return
        val bb = ByteBuffer.allocateDirect(mesh.vertices.size * 4).order(ByteOrder.nativeOrder())
        bb.asFloatBuffer().put(mesh.vertices); bb.position(0)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, vbo)
        GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, bb.capacity(), bb, GLES20.GL_DYNAMIC_DRAW)
    }

    fun currentWorkCounter(): Long = world.workCounter

    /** 场景切换：区块边长 + 世界高度 + mobCap，触发真实重新生成。 */
    fun applyScenario(chunks: Int, h: Int, mobCap: Int, chunkWork: Int, label: String) {
        worldChunks = chunks
        height = h
        activeEntities = mobCap
        chunkWorkPerFrame = chunkWork
        scenarioLabel = label
        // 重建世界实例（尺寸在构造时固定）
        world = VoxelWorld(chunks, h, 20261122L + chunkCursor, mobCap)
        world.regenerate()
        uploadMesh(world.buildMesh())
    }

    companion object {
        private const val VERTEX_SHADER = """
            attribute vec3 aPos; attribute vec3 aColor; attribute vec2 aUV;
            uniform mat4 uMvp;
            varying vec3 vColor; varying vec2 vUV;
            void main() { gl_Position = uMvp * vec4(aPos, 1.0); vColor = aColor; vUV = aUV; }
        """
        private const val FRAGMENT_SHADER = """
            precision mediump float;
            varying vec3 vColor; varying vec2 vUV;
            uniform vec3 uTint; uniform sampler2D uTex;
            void main() {
                vec4 tex = texture2D(uTex, vUV);
                if (tex.a < 0.5) discard;
                gl_FragColor = vec4(tex.rgb * vColor * uTint, 1.0);
            }
        """
        private const val MOB_VERTEX_SHADER = """
            attribute vec3 aPos; attribute vec2 aUV; attribute float aShade;
            uniform mat4 uMvp; uniform mat4 uModel;
            varying vec2 vUV; varying float vShade;
            void main() {
                vUV = aUV; vShade = aShade;
                gl_Position = uMvp * uModel * vec4(aPos, 1.0);
            }
        """
        private const val MOB_FRAGMENT_SHADER = """
            precision mediump float;
            varying vec2 vUV; varying float vShade;
            uniform sampler2D uTex;
            void main() {
                vec4 tex = texture2D(uTex, vUV);
                if (tex.a < 0.5) discard;
                gl_FragColor = vec4(tex.rgb * vShade, 1.0);
            }
        """

        private fun floatBuffer(a: FloatArray): FloatBuffer {
            val bb = ByteBuffer.allocateDirect(a.size * 4).order(ByteOrder.nativeOrder())
            bb.asFloatBuffer().put(a); bb.position(0); return bb.asFloatBuffer()
        }
        private fun shortBuffer(a: ShortArray): ShortBuffer {
            val bb = ByteBuffer.allocateDirect(a.size * 2).order(ByteOrder.nativeOrder())
            bb.asShortBuffer().put(a); bb.position(0); return bb.asShortBuffer()
        }

        private fun compile(type: Int, src: String): Int {
            val s = GLES20.glCreateShader(type)
            GLES20.glShaderSource(s, src); GLES20.glCompileShader(s); return s
        }
        private fun buildProgram(vs: String, fs: String): Int {
            val p = GLES20.glCreateProgram()
            GLES20.glAttachShader(p, compile(GLES20.GL_VERTEX_SHADER, vs))
            GLES20.glAttachShader(p, compile(GLES20.GL_FRAGMENT_SHADER, fs))
            GLES20.glLinkProgram(p); return p
        }
        private fun modelMatrix(x: Float, y: Float, z: Float, yaw: Float, s: Float): FloatArray {
            val c = cos(yaw) * s; val sn = sin(yaw) * s
            return floatArrayOf(
                c, 0f, -sn, 0f,
                0f, s, 0f, 0f,
                sn, 0f, c, 0f,
                x, y, z, 1f,
            )
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
            var l = kotlin.math.sqrt(zx * zx + zy * zy + zz * zz).coerceAtLeast(1e-6f)
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
