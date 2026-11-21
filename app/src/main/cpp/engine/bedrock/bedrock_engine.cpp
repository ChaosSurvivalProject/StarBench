#include "starbench_engine.h"

#include <android/log.h>

namespace starbench {

/**
 * Bedrock 版原生内核（与 Java 版独立实现，不共享逻辑）。
 * C++ 风格多线程调度；偶数 4–12 模拟距离按世界保存；无常驻出生区块；
 * P-Tick / C-Tick 双相双缓冲，红石粉每刻更新；渲染/模拟距离解耦；
 * UDP + RakNet 风格可靠层同构编码（不接官方服务）。
 *
 * 光照批处理粒度、寻路上坡权重等为「待验证」，由规则包热替换。
 */
class BedrockEditionEngine final : public IEditionEngine {
public:
    double tick(uint64_t, int64_t, int) override {
        notImplemented("BedrockEditionEngine::tick");
        return 0.0;
    }
    int64_t rebuildChunks(uint64_t, int, int, int) override {
        notImplemented("BedrockEditionEngine::rebuildChunks");
        return 0;
    }
    int64_t propagateLight(uint64_t, int) override {
        notImplemented("BedrockEditionEngine::propagateLight");
        return 0;
    }
    int64_t updateRedstone(uint64_t, float) override {
        notImplemented("BedrockEditionEngine::updateRedstone");
        return 0;
    }
    int64_t stepEntities(uint64_t, int) override {
        notImplemented("BedrockEditionEngine::stepEntities");
        return 0;
    }
    int64_t syncNetwork(int, int) override {
        notImplemented("BedrockEditionEngine::syncNetwork");
        return 0;
    }
    int64_t worldSnapshotHash() const override { return 0; }

private:
    static void notImplemented(const char* what) {
        __android_log_print(ANDROID_LOG_ERROR, "StarBench",
                            "%s 尚未实现：骨架入口，返回值不可作为实测数据", what);
    }
};

IEditionEngine* createBedrockEngine() {
    static BedrockEditionEngine instance;
    return &instance;
}

}  // namespace starbench
