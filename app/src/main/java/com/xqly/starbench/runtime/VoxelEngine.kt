package com.xqly.starbench.runtime

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * 真实体素世界引擎（clean-room，自产算法，不含任何官方资源）。
 *
 * 这里的世界生成、光照传播、实体推进都是逐次真实计算：工作量随视距/模拟距离参数变化，
 * 不使用 sleep、随机数假装负载或预录帧。计数值 workCounter 由实际执行累加。
 *
 * 说明：这是「等效负载」基线实现，不宣称 1:1 还原我的世界（见报告与 README 的诚实声明）。
 */
object Block {
    const val AIR = 0
    const val GRASS = 1
    const val DIRT = 2
    const val STONE = 3
    const val WATER = 4
    const val SAND = 5
    const val WOOD = 6
    const val LEAVES = 7

    fun opaque(b: Int) = b != AIR && b != WATER && b != LEAVES
}

/** 单个立方体面：法线方向 + 4 个角点（单位立方体坐标）。 */
private data class FaceDef(
    val nx: Int, val ny: Int, val nz: Int,
    val corners: Array<FloatArray>,
    val isTop: Boolean,
)

class VoxelWorld(var sizeX: Int, var sizeZ: Int, var height: Int, val seed: Long) {

    private var blocks = ByteArray(sizeX * height * sizeZ)
    private var light = ByteArray(sizeX * height * sizeZ)

    /** 由真实执行累加的工作量计数（区块遍历、光照更新、实体 tick 等）。 */
    var workCounter: Long = 0L
        private set

    /** 实体：[x, z, vx, vz]。 */
    val entities = ArrayList<FloatArray>()

    private fun idx(x: Int, y: Int, z: Int) = (y * sizeZ + z) * sizeX + x

    fun get(x: Int, y: Int, z: Int): Int {
        if (x < 0 || x >= sizeX || z < 0 || z >= sizeZ || y < 0 || y >= height) return Block.AIR
        return blocks[idx(x, y, z)].toInt() and 0xff
    }

    private fun setRaw(x: Int, y: Int, z: Int, b: Int) {
        blocks[idx(x, y, z)] = b.toByte()
    }

    private fun hash(x: Int, z: Int, s: Int): Float {
        var h = (x * 374761393 + z * 668265263 + s * 1442695041 + seed.toInt()).toInt()
        h = (h xor (h ushr 13)) * 1274126177
        return ((h xor (h ushr 16)) and 0x7fffffff) / 2147483647f
    }

    private fun smooth(t: Float) = t * t * (3f - 2f * t)

    private fun noise(x: Float, z: Float, s: Int): Float {
        val xi = floor(x).toInt()
        val zi = floor(z).toInt()
        val xf = x - xi
        val zf = z - zi
        val a = hash(xi, zi, s)
        val b = hash(xi + 1, zi, s)
        val c = hash(xi, zi + 1, s)
        val d = hash(xi + 1, zi + 1, s)
        val u = smooth(xf)
        val v = smooth(zf)
        return (a * (1f - u) + b * u) * (1f - v) + (c * (1f - u) + d * u) * v
    }

    /** 用确定性噪声真实生成地形；size 越大计算量越大。 */
    fun regenerate(sx: Int = sizeX, sz: Int = sizeZ, h: Int = height) {
        sizeX = sx
        sizeZ = sz
        height = h
        blocks = ByteArray(sizeX * height * sizeZ)
        light = ByteArray(sizeX * height * sizeZ)
        workCounter = 0L
        for (x in 0 until sizeX) for (z in 0 until sizeZ) {
            val n = noise(x * 0.09f, z * 0.09f, 0) * 0.65f + noise(x * 0.25f, z * 0.25f, 1) * 0.35f
            val top = (3 + n * (height - 7)).toInt().coerceIn(1, height - 3)
            for (y in 0 until height) {
                val b = when {
                    y > top -> Block.AIR
                    y == top -> if (top <= 6) Block.SAND else Block.GRASS
                    y >= top - 3 -> if (top <= 6) Block.SAND else Block.DIRT
                    else -> Block.STONE
                }
                setRaw(x, y, z, b)
                workCounter++
            }
            // 确定性树木
            if (top > 8 && x > 2 && x < sizeX - 3 && z > 2 && z < sizeZ - 3 && hash(x, z, 7) > 0.988f) {
                for (yy in top + 1..minOf(top + 4, height - 1)) setRaw(x, yy, z, Block.WOOD)
                for (dx in -2..2) for (dz in -2..2) for (dy in -1..1) {
                    if (abs(dx) + abs(dz) + abs(dy) <= 3) setRaw(x + dx, top + 3 + dy, z + dz, Block.LEAVES)
                }
            }
        }
        propagateLight()
        entities.clear()
        repeat(20) { i ->
            entities.add(
                floatArrayOf(
                    2f + hash(i, 11, 0) * (sizeX - 4), 0f,
                    2f + hash(i, 12, 0) * (sizeZ - 4),
                    hash(i, 13, 0) * 0.6f - 0.3f, hash(i, 14, 0) * 0.6f - 0.3f,
                )
            )
        }
    }

    /** 天空光按列向下衰减——真实遍历每个方块，更新在画面上可见。 */
    private fun propagateLight() {
        for (x in 0 until sizeX) for (z in 0 until sizeZ) {
            var lv = 15
            for (y in height - 1 downTo 0) {
                if (Block.opaque(get(x, y, z))) lv = maxOf(0, lv - 3)
                light[idx(x, y, z)] = lv.toByte()
                workCounter++
            }
        }
    }

    /** 实体 AI：确定性移动 + 边界反弹，随模拟距离可调整实体数量。 */
    fun tickEntities(dt: Float, activeCount: Int) {
        val n = minOf(activeCount, entities.size)
        for (i in 0 until n) {
            val e = entities[i]
            e[0] += e[3] * dt
            e[2] += e[4] * dt
            if (e[0] < 1f || e[0] >= sizeX - 1f) e[3] = -e[3]
            if (e[2] < 1f || e[2] >= sizeZ - 1f) e[4] = -e[4]
            e[0] = e[0].coerceIn(1f, (sizeX - 2).toFloat())
            e[2] = e[2].coerceIn(1f, (sizeZ - 2).toFloat())
            workCounter++
        }
    }

    /** 区块重建的真实计算：遍历区块内所有非空气方块并累加哈希。 */
    fun chunkRebuildWork(cx: Int, cz: Int, cs: Int) {
        for (x in cx until minOf(cx + cs, sizeX)) for (z in cz until minOf(cz + cs, sizeZ)) {
            for (y in 0 until height) {
                val b = get(x, y, z)
                if (b != Block.AIR) workCounter += (b * x + b * z + y).toLong()
            }
        }
    }

    /** 从当前真实世界状态构建可见网格：逐面剔除 + 光照着色。 */
    fun buildMesh(): VoxelMesh {
        val cap = minOf(sizeX * sizeZ * height * 36, 4_000_000)
        val out = FloatArray(cap)
        var p = 0
        fun addVertex(x: Float, y: Float, z: Float, r: Float, g: Float, b: Float) {
            if (p + 6 <= out.size) {
                out[p++] = x; out[p++] = y; out[p++] = z
                out[p++] = r; out[p++] = g; out[p++] = b
            }
        }
        val faces = FACES
        for (x in 0 until sizeX) for (y in 0 until height) for (z in 0 until sizeZ) {
            val b = get(x, y, z)
            if (b == Block.AIR || b == Block.LEAVES) continue
            val lv = (light[idx(x, y, z)].toInt() and 0xff) / 15f
            val shade = 0.35f + 0.65f * lv
            for (f in faces) {
                if (Block.opaque(get(x + f.nx, y + f.ny, z + f.nz))) continue
                val col = palette(b, f.isTop)
                val cr = col[0] * shade
                val cg = col[1] * shade
                val cb = col[2] * shade
                val c = f.corners
                addVertex(x + c[0][0], y + c[0][1], z + c[0][2], cr, cg, cb)
                addVertex(x + c[1][0], y + c[1][1], z + c[1][2], cr, cg, cb)
                addVertex(x + c[2][0], y + c[2][1], z + c[2][2], cr, cg, cb)
                addVertex(x + c[0][0], y + c[0][1], z + c[0][2], cr, cg, cb)
                addVertex(x + c[2][0], y + c[2][1], z + c[2][2], cr, cg, cb)
                addVertex(x + c[3][0], y + c[3][1], z + c[3][2], cr, cg, cb)
            }
        }
        return VoxelMesh(out.copyOf(p), p / 6)
    }

    private fun palette(b: Int, top: Boolean): FloatArray = when (b) {
        Block.GRASS -> if (top) floatArrayOf(0.36f, 0.66f, 0.32f) else floatArrayOf(0.45f, 0.34f, 0.22f)
        Block.DIRT -> floatArrayOf(0.45f, 0.34f, 0.22f)
        Block.STONE -> floatArrayOf(0.52f, 0.52f, 0.55f)
        Block.SAND -> floatArrayOf(0.86f, 0.80f, 0.55f)
        Block.WATER -> floatArrayOf(0.25f, 0.45f, 0.85f)
        Block.WOOD -> floatArrayOf(0.40f, 0.28f, 0.15f)
        Block.LEAVES -> floatArrayOf(0.24f, 0.52f, 0.26f)
        else -> floatArrayOf(0.5f, 0.5f, 0.5f)
    }

    private companion object {
        val FACES: Array<FaceDef> = arrayOf(
            FaceDef(0, 1, 0, arrayOf(
                floatArrayOf(0f, 1f, 0f), floatArrayOf(0f, 1f, 1f),
                floatArrayOf(1f, 1f, 1f), floatArrayOf(1f, 1f, 0f)), true),
            FaceDef(0, -1, 0, arrayOf(
                floatArrayOf(0f, 0f, 1f), floatArrayOf(0f, 0f, 0f),
                floatArrayOf(1f, 0f, 0f), floatArrayOf(1f, 0f, 1f)), false),
            FaceDef(1, 0, 0, arrayOf(
                floatArrayOf(1f, 0f, 1f), floatArrayOf(1f, 0f, 0f),
                floatArrayOf(1f, 1f, 0f), floatArrayOf(1f, 1f, 1f)), false),
            FaceDef(-1, 0, 0, arrayOf(
                floatArrayOf(0f, 0f, 0f), floatArrayOf(0f, 0f, 1f),
                floatArrayOf(0f, 1f, 1f), floatArrayOf(0f, 1f, 0f)), false),
            FaceDef(0, 0, 1, arrayOf(
                floatArrayOf(1f, 0f, 1f), floatArrayOf(0f, 0f, 1f),
                floatArrayOf(0f, 1f, 1f), floatArrayOf(1f, 1f, 1f)), false),
            FaceDef(0, 0, -1, arrayOf(
                floatArrayOf(0f, 0f, 0f), floatArrayOf(1f, 0f, 0f),
                floatArrayOf(1f, 1f, 0f), floatArrayOf(0f, 1f, 0f)), false),
        )
    }
}

/** 每个顶点 6 个 float：x,y,z,r,g,b。 */
class VoxelMesh(val vertices: FloatArray, val vertexCount: Int)
