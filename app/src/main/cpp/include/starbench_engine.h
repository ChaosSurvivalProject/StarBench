#pragma once

#include <cstdint>

namespace starbench {

// 两套引擎只共享接口与数据结构，不共享任何逻辑实现。
class IEditionEngine {
public:
    virtual ~IEditionEngine() = default;

    // 返回真实 tick 耗时（纳秒级由上层换算）。禁止返回随机数或伪造值。
    virtual double tick(uint64_t seed, int64_t tick_index, int simulate_distance) = 0;

    virtual int64_t rebuildChunks(uint64_t seed, int center_x, int center_z, int radius) = 0;
    virtual int64_t propagateLight(uint64_t seed, int count) = 0;
    virtual int64_t updateRedstone(uint64_t seed, float density) = 0;
    virtual int64_t stepEntities(uint64_t seed, int count) = 0;
    virtual int64_t syncNetwork(int virtual_players, int ticks) = 0;

    // 当帧世界状态的哈希；渲染层据此确认画面来自同一份状态。
    virtual int64_t worldSnapshotHash() const = 0;
};

}  // namespace starbench
