#include "starbench_engine.h"

#include <android/log.h>

namespace starbench {

/**
 * Java 版原生内核。
 * 单主线程 20 TPS；(2s+1)^2 实体 tick 方阵 + 外一格红石/流体/作物；
 * TCP + VarInt 同构帧。细粒度参数为「待验证」，由规则包热替换。
 *
 * 以下方法为骨架入口：实现期替换为真实世界运算。
 * 严禁返回随机数、sleep、空循环或伪造数值——那会直接违反需求十三。
 */
class JavaEditionEngine final : public IEditionEngine {
public:
    double tick(uint64_t, int64_t, int) override {
        notImplemented("JavaEditionEngine::tick");
        return 0.0;
    }
    int64_t rebuildChunks(uint64_t, int, int, int) override {
        notImplemented("JavaEditionEngine::rebuildChunks");
        return 0;
    }
    int64_t propagateLight(uint64_t, int) override {
        notImplemented("JavaEditionEngine::propagateLight");
        return 0;
    }
    int64_t updateRedstone(uint64_t, float) override {
        notImplemented("JavaEditionEngine::updateRedstone");
        return 0;
    }
    int64_t stepEntities(uint64_t, int) override {
        notImplemented("JavaEditionEngine::stepEntities");
        return 0;
    }
    int64_t syncNetwork(int, int) override {
        notImplemented("JavaEditionEngine::syncNetwork");
        return 0;
    }
    int64_t worldSnapshotHash() const override { return 0; }

private:
    static void notImplemented(const char* what) {
        __android_log_print(ANDROID_LOG_ERROR, "StarBench",
                            "%s 尚未实现：骨架入口，返回值不可作为实测数据", what);
    }
};

IEditionEngine* createJavaEngine() {
    static JavaEditionEngine instance;
    return &instance;
}

}  // namespace starbench
