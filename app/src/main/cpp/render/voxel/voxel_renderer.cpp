#include <android/log.h>

/**
 * 体素渲染器骨架（Vulkan 优先，OpenGL ES 降级）。
 *
 * 硬约束：渲染唯一输入是当帧世界状态快照。
 * 本文件【不提供】任何视频播放 / 图片轮播 / 预录帧 / 静态壁纸入口——
 * 从实现上排除「画面演一套、运算跑一套」。
 *
 * 1:1 对齐由 assets/packA 的 clean-room 资源 + VisualParitySpec 逐维度校验；
 * 路径 B 资源包仅在授权凭证存在时切换，切换不改变工作量计数。
 */
namespace starbench::render {

void renderFrameStub(int64_t /*snapshot_hash*/, int /*render_distance*/) {
    __android_log_print(ANDROID_LOG_INFO, "StarBench",
                        "VoxelRenderer::renderFrame 骨架入口：实现期按当帧快照逐帧生成画面");
}

}  // namespace starbench::render
