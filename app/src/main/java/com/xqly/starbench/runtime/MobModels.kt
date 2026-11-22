package com.xqly.starbench.runtime

import android.content.Context
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * 动物体素模型（来源 22i/minecraft-voxel-blender-models，GPL-3.0）。
 * 从 assets/mobs.bin 读取真实 .b3d 导出的顶点/UV/三角索引，按体素方块尺度归一化。
 */
class MobPart(
    val tile: Int,
    val pos: FloatArray,
    val uv: FloatArray,
    val idx: ShortArray,
)

class MobModel(
    val scale: Float,
    val parts: List<MobPart>,
)

object MobModels {
    val models = HashMap<String, MobModel>()

    fun load(context: Context) {
        models.clear()
        val bytes = context.assets.open("mobs.bin").use { it.readBytes() }
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val magic = bb.int // SBM1 (read as int)
        require(magic == 0x314d4253) { "bad mobs.bin magic" }
        val count = bb.int
        repeat(count) {
            val nameLen = bb.int
            val nameBytes = ByteArray(nameLen)
            bb.get(nameBytes)
            val name = String(nameBytes, Charsets.UTF_8)
            val scale = bb.float
            val partsN = bb.int
            val parts = ArrayList<MobPart>()
            repeat(partsN) {
                val tile = bb.int
                val nv = bb.int
                val pos = FloatArray(nv * 3) { bb.float }
                val uv = FloatArray(nv * 2) { bb.float }
                val ni = bb.int
                val idx = ShortArray(ni) { bb.short }
                parts.add(MobPart(tile, pos, uv, idx))
            }
            models[name] = MobModel(scale, parts)
        }
    }

    /** 图集常量：动物 64×32 瓦片，4 列 × 2 行；tile 顺序 cow,pig,sheep,sheepFur,chicken,wolf */
    const val ATLAS_COLS = 4
    const val ATLAS_ROWS = 2

    /** 构建某动物的展开网格：pos(x,y,z)/shade/u/v/idx，UV 映射到动物图集。 */
    fun buildMesh(name: String): MobMesh? {
        val m = models[name] ?: return null
        var totalV = 0
        var totalI = 0
        for (part in m.parts) {
            totalV += part.pos.size / 3
            totalI += part.idx.size
        }
        val pos = FloatArray(totalV * 3)
        val shade = FloatArray(totalV)
        val uv = FloatArray(totalV * 2)
        val idx = ShortArray(totalI)
        var vp = 0
        var ip = 0
        var base = 0
        for (part in m.parts) {
            val col = part.tile % ATLAS_COLS
            val row = part.tile / ATLAS_COLS
            val nv = part.pos.size / 3
            for (i in 0 until nv) {
                val px = part.pos[i * 3] * m.scale
                val py = part.pos[i * 3 + 1] * m.scale
                val pz = part.pos[i * 3 + 2] * m.scale
                pos[vp * 3] = px; pos[vp * 3 + 1] = py; pos[vp * 3 + 2] = pz
                val ny = part.pos[i * 3 + 1] / 5f
                shade[vp] = 0.62f + 0.38f * (0.5f + ny / 2f).coerceIn(0f, 1f)
                uv[vp * 2] = (col + part.uv[i * 2]).toFloat() / ATLAS_COLS
                uv[vp * 2 + 1] = 1f - (row + part.uv[i * 2 + 1]).toFloat() / ATLAS_ROWS
                vp++
            }
            for (k in part.idx.indices) idx[ip++] = (part.idx[k].toInt() + base).toShort()
            base += nv
        }
        return MobMesh(pos, shade, uv, idx)
    }
}

class MobMesh(
    val pos: FloatArray,
    val shade: FloatArray,
    val uv: FloatArray,
    val idx: ShortArray,
)
