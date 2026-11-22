package com.xqly.starbench.runtime

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * 真实体素世界引擎（clean-room 算法 + 开源生物模型）。
 * 64×64 区块 · 确定性群系噪声 · 天空光 · pack spawning + mob cap · 逐面剔除网格。
 * 所有工作量来自真实遍历；不使用 sleep、随机数假装负载或预录帧。
 * 机制参考《我的世界地形生物与视距渲染机制》《世界与生物关键参数表》。
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

object Biome {
    const val PLAINS = 0
    const val FOREST = 1
    const val DESERT = 2
    const val TAIGA = 3
}

private data class FaceDef(
    val nx: Int, val ny: Int, val nz: Int,
    val corners: Array<FloatArray>,
    val isTop: Boolean,
)

/** 生物实体：类型 + 位置 + 速度 + 朝向 + 步态。 */
class Mob(
    var type: String,
    var x: Float, var y: Float, var z: Float,
    var vx: Float = 0f, var vz: Float = 0f,
    var yaw: Float = 0f, var legPhase: Float = 0f,
    var phase: Float = 0f, var showcase: Boolean = false,
)

class VoxelWorld(val chunks: Int, val height: Int, val seed: Long, val mobCap: Int) {
    val sizeX = chunks * 64
    val sizeZ = chunks * 64

    private var blocks = ByteArray(sizeX * height * sizeZ)
    private var light = ByteArray(sizeX * height * sizeZ)
    private var biome = ByteArray(sizeX * sizeZ)
    private var surface = IntArray(sizeX * sizeZ)

    var workCounter: Long = 0L
        private set

    val mobs = ArrayList<Mob>()
    private var simTime = 0f
    private var sectionCursor = 0
    private val sectionCount = (sizeX / 16) * (sizeZ / 16) * ((height + 15) / 16)

    private fun idx(x: Int, y: Int, z: Int) = (y * sizeZ + z) * sizeX + x

    fun get(x: Int, y: Int, z: Int): Int {
        if (x < 0 || x >= sizeX || z < 0 || z >= sizeZ || y < 0 || y >= height) return Block.AIR
        return blocks[idx(x, y, z)].toInt() and 0xff
    }
    private fun setRaw(x: Int, y: Int, z: Int, b: Int) { blocks[idx(x, y, z)] = b.toByte() }

    private fun hash(x: Int, z: Int, s: Int): Float {
        var h = (x * 374761393 + z * 668265263 + s * 1442695041 + seed.toInt()).toInt()
        h = (h xor (h ushr 13)) * 1274126177
        return ((h xor (h ushr 16)) and 0x7fffffff) / 2147483647f
    }
    private fun smooth(t: Float) = t * t * (3f - 2f * t)
    private fun noise(x: Float, z: Float, s: Int): Float {
        val xi = floor(x).toInt(); val zi = floor(z).toInt()
        val xf = x - xi; val zf = z - zi
        val a = hash(xi, zi, s); val b = hash(xi + 1, zi, s)
        val c = hash(xi, zi + 1, s); val d = hash(xi + 1, zi + 1, s)
        val u = smooth(xf); val v = smooth(zf)
        return (a * (1f - u) + b * u) * (1f - v) + (c * (1f - u) + d * u) * v
    }
    private fun fbm(x: Float, z: Float, s: Int, oct: Int): Float {
        var v = 0f; var amp = 1f; var freq = 1f; var norm = 0f
        repeat(oct) { o -> v += noise(x * freq, z * freq, s + o * 1013) * amp; norm += amp; amp *= 0.5f; freq *= 2f }
        return v / norm
    }
    private fun biomeAt(x: Int, z: Int): Int {
        val t = fbm(x / 150f, z / 150f, 7001, 3)
        val v = fbm(x / 120f, z / 120f, 9103, 3)
        if (t > 0.60f && v < 0.40f) return Biome.DESERT
        if (v > 0.57f) return Biome.FOREST
        if (t < 0.36f) return Biome.TAIGA
        return Biome.PLAINS
    }

    fun regenerate() {
        blocks = ByteArray(sizeX * height * sizeZ)
        light = ByteArray(sizeX * height * sizeZ)
        biome = ByteArray(sizeX * sizeZ)
        surface = IntArray(sizeX * sizeZ)
        workCounter = 0L
        val waterLevel = 5
        for (x in 0 until sizeX) for (z in 0 until sizeZ) {
            val bi = biomeAt(x, z)
            biome[z * sizeX + x] = bi.toByte()
            val cont = fbm(x / 210f, z / 210f, 101, 4)
            val eros = fbm(x / 64f + 17f, z / 64f - 11f, 77, 3)
            val weird = fbm(x / 28f - 5f, z / 28f + 9f, 133, 2)
            var top = (6 + cont * 16 + eros * 7 + weird * 3).toInt()
            top = top.coerceIn(2, height - 3)
            surface[z * sizeX + x] = top
            val topBlock = if (bi == Biome.DESERT) Block.SAND else Block.GRASS
            for (y in 0..top) {
                val b = when {
                    y == top -> topBlock
                    y >= top - 3 -> if (bi == Biome.DESERT) Block.SAND else Block.DIRT
                    else -> Block.STONE
                }
                setRaw(x, y, z, b); workCounter++
            }
            for (y in top + 1..waterLevel) { setRaw(x, y, z, Block.WATER); workCounter++ }
        }
        // 中央空地 + 稀疏树（森林密、草原中、针叶林低、沙漠无）
        val cx0 = sizeX / 2; val cz0 = sizeZ / 2
        val clearR = minOf(14, (sizeX * 0.12f).toInt())
        val stepFor = intArrayOf(18, 13, 0, 15)
        for (x in 2 until sizeX - 2) for (z in 2 until sizeZ - 2) {
            if (hypot((x - cx0).toFloat(), (z - cz0).toFloat()) < clearR) continue
            val bi = biome[z * sizeX + x].toInt()
            val step = stepFor[bi]
            if (step == 0 || x % step != (step shr 1) || z % step != (step shr 1)) continue
            if (hash(x, z, 999) < 0.45f) continue
            val top = surface[z * sizeX + x]
            if (top <= waterLevel + 1) continue
            val trunk = 3 + (hash(x, z, 31) * 3).toInt()
            for (y in top + 1..top + trunk) setRaw(x, y, z, Block.WOOD)
            val cy = top + trunk
            for (dx in -2..2) for (dz in -2..2) for (dy in -1..1) {
                if (abs(dx) + abs(dz) > 3 || (dx == 0 && dz == 0)) continue
                val lx = x + dx; val lz = z + dz; val ly = cy + dy
                if (lx in 0 until sizeX && lz in 0 until sizeZ && ly in 0 until height && get(lx, ly, lz) == Block.AIR)
                    setRaw(lx, ly, lz, Block.LEAVES)
            }
        }
        propagateLight()
        spawnMobs()
    }

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

    private val mobGroups = mapOf("cow" to 4, "pig" to 4, "sheep" to 4, "chicken" to 4, "wolf" to 8)
    private fun speciesFor(bi: Int): Array<String> = when (bi) {
        Biome.PLAINS -> arrayOf("cow", "pig", "sheep", "chicken")
        Biome.FOREST -> arrayOf("cow", "sheep", "wolf", "chicken")
        Biome.TAIGA -> arrayOf("wolf", "sheep", "cow")
        else -> emptyArray()
    }

    private fun spawnMobs() {
        mobs.clear()
        var id = 0
        val cap = maxOf(6, mobCap)
        val packCap = cap - 5
        for (cx in 0 until chunks) for (cz in 0 until chunks) {
            if (mobs.size >= packCap) break
            val bx = cx * 64 + 32; val bz = cz * 64 + 32
            val bi = biome[bz * sizeX + bx].toInt()
            val species = speciesFor(bi)
            if (species.isEmpty()) continue
            val packs = if (hash(cx, cz, 4242) < 0.5f) 2 else 1
            for (p in 0 until packs) {
                if (mobs.size >= packCap) break
                val mx = cx * 64 + 4 + hash(cx, cz + p, 11) * 56
                val mz = cz * 64 + 4 + hash(cx + p, cz, 12) * 56
                val pick = species[(hash(cx + p, cz - p, 13) * species.size).toInt() % species.size]
                val n = mobGroups[pick] ?: 4
                repeat(n) { k ->
                    if (mobs.size >= packCap) return@repeat
                    val ox = (hash(id, k, 21) + hash(id + 7, k, 22) - 1f) * 5f
                    val oz = (hash(id, k + 3, 23) + hash(id + 7, k + 4, 24) - 1f) * 5f
                    val x = (mx + ox).coerceIn(1f, sizeX - 2f)
                    val z = (mz + oz).coerceIn(1f, sizeZ - 2f)
                    val top = surface[(z.toInt()) * sizeX + x.toInt()]
                    if (top <= 5) return@repeat
                    mobs.add(Mob(pick, x, (top + 1).toFloat(), z,
                        phase = hash(id, k, 53) * 6.283f, yaw = hash(id, k, 31) * 6.283f))
                    workCounter += 6
                    id++
                }
            }
        }
        // 中央空地展示 5 种动物
        val cx0 = sizeX / 2; val cz0 = sizeZ / 2
        val showcase = arrayOf("cow", "pig", "sheep", "chicken", "wolf")
        for (k in showcase.indices) {
            if (mobs.size >= cap) break
            val ang = (k.toFloat() / showcase.size) * 6.283f + 0.4f
            val rr = 4f + (k % 2) * 3f
            val x = (cx0 + cos(ang) * rr).coerceIn(1f, sizeX - 2f)
            val z = (cz0 + sin(ang) * rr).coerceIn(1f, sizeZ - 2f)
            val top = surface[(z.toInt()) * sizeX + x.toInt()]
            mobs.add(Mob(showcase[k], x, (top + 1).toFloat(), z, yaw = ang, phase = k * 1.7f, showcase = true))
            workCounter += 6
        }
        tickEntities(0f, mobs.size)
    }

    fun tickEntities(dt: Float, activeCount: Int) {
        simTime += dt
        val n = minOf(activeCount, mobs.size)
        for (i in 0 until n) {
            val e = mobs[i]
            val fx = sin(simTime * 0.7f + e.phase) * 0.9f + cos(simTime * 0.23f + i) * 0.5f
            val fz = cos(simTime * 0.6f + e.phase * 1.3f) * 0.9f + sin(simTime * 0.19f + i) * 0.5f
            e.vx = fx * 2.2f; e.vz = fz * 2.2f
            if (e.showcase) {
                val dx = e.x - sizeX / 2; val dz = e.z - sizeZ / 2
                val d = hypot(dx, dz)
                if (d > 9f) { e.vx -= dx / d * 3f; e.vz -= dz / d * 3f }
            }
            e.x += e.vx * dt; e.z += e.vz * dt
            if (e.x < 1f || e.x > sizeX - 2f) { e.vx *= -1f; e.x = e.x.coerceIn(1f, sizeX - 2f) }
            if (e.z < 1f || e.z > sizeZ - 2f) { e.vz *= -1f; e.z = e.z.coerceIn(1f, sizeZ - 2f) }
            val speed = hypot(e.vx, e.vz)
            if (speed > 0.05f) e.yaw = kotlin.math.atan2(e.vx, e.vz)
            e.legPhase += speed * dt * 3.2f
            val ix = e.x.toInt().coerceIn(0, sizeX - 1)
            val iz = e.z.toInt().coerceIn(0, sizeZ - 1)
            e.y = (surface[iz * sizeX + ix] + 1).toFloat()
            workCounter += 8
        }
    }

    /** 区块段 16³ 重建工作量（ref §六：段为网格重建最小单元）。 */
    fun rebuildSections(n: Int) {
        val per = sizeX / 16
        val perY = (height + 15) / 16
        var work = 0L
        repeat(n.coerceAtLeast(0)) {
            val c = sectionCursor++ % sectionCount
            val sy = c % perY; val rem = c / perY
            val szc = rem % per; val sxc = rem / per
            val x0 = sxc * 16; val z0 = szc * 16; val y0 = sy * 16
            for (y in y0 until minOf(height, y0 + 16))
                for (z in z0 until minOf(sizeZ, z0 + 16))
                    for (x in x0 until minOf(sizeX, x0 + 16)) {
                        val b = get(x, y, z)
                        work++
                        if (b == Block.AIR) continue
                        for (f in FACES) if (!Block.opaque(get(x + f.nx, y + f.ny, z + f.nz))) work++
                    }
        }
        workCounter += work
    }

    private val atlasCols = 4
    private val atlasRows = 3
    private fun tileOf(b: Int, isTop: Boolean, isBottom: Boolean): Int = when (b) {
        Block.GRASS -> if (isTop) 0 else if (isBottom) 2 else 1
        Block.DIRT -> 2
        Block.STONE -> 3
        Block.WOOD -> if (isTop || isBottom) 4 else 5
        Block.LEAVES -> 6
        Block.WATER -> 7
        Block.SAND -> 8
        else -> 3
    }
    private fun uvForTile(tile: Int): Array<FloatArray> {
        val col = tile % atlasCols; val row = tile / atlasCols
        val eps = 0.5f / (atlasCols * 64f)
        val u0 = col.toFloat() / atlasCols + eps
        val u1 = (col + 1).toFloat() / atlasCols - eps
        val v0 = row.toFloat() / atlasRows + eps
        val v1 = (row + 1).toFloat() / atlasRows - eps
        return arrayOf(
            floatArrayOf(u0, v0), floatArrayOf(u1, v0),
            floatArrayOf(u1, v1), floatArrayOf(u0, v1),
        )
    }

    fun buildMesh(): VoxelMesh {
        val cap = minOf(sizeX * sizeZ * height * 36, 12_000_000)
        val out = FloatArray(cap)
        var p = 0
        fun addVertex(x: Float, y: Float, z: Float, shade: Float, u: Float, v: Float) {
            if (p + 8 <= out.size) {
                out[p++] = x; out[p++] = y; out[p++] = z
                out[p++] = shade; out[p++] = shade; out[p++] = shade
                out[p++] = u; out[p++] = v
            }
        }
        for (x in 0 until sizeX) for (y in 0 until height) for (z in 0 until sizeZ) {
            val b = get(x, y, z)
            if (b == Block.AIR) continue
            val lv = (light[idx(x, y, z)].toInt() and 0xff) / 15f
            val baseShade = 0.35f + 0.65f * lv
            for (f in FACES) {
                if (Block.opaque(get(x + f.nx, y + f.ny, z + f.nz))) continue
                val isTop = f.ny > 0; val isBottom = f.ny < 0
                val ambient = when {
                    isTop -> 1.0f; isBottom -> 0.5f
                    f.nx > 0 || f.nz > 0 -> 0.82f
                    else -> 0.68f
                }
                val shade = baseShade * ambient
                val uv = uvForTile(tileOf(b, isTop, isBottom))
                val c = f.corners
                for (oi in intArrayOf(0, 1, 2, 0, 2, 3)) {
                    addVertex(x + c[oi][0], y + c[oi][1], z + c[oi][2], shade, uv[oi][0], uv[oi][1])
                }
            }
        }
        return VoxelMesh(out.copyOf(p), p / 8)
    }

    fun averageGroundY(): Float {
        var sum = 0; var c = 0
        var i = 0
        while (i < surface.size) { sum += surface[i]; c++; i += 37 }
        return if (c > 0) sum.toFloat() / c else height * 0.3f
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

/** 每个顶点 8 个 float：x,y,z, r,g,b(光照灰阶), u,v。 */
class VoxelMesh(val vertices: FloatArray, val vertexCount: Int)
