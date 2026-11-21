cmake_minimum_required(VERSION 3.22.1)
project(starbench-native)

add_library(starbench-native SHARED
        native_bridge.cpp
        engine/java/java_engine.cpp
        engine/bedrock/bedrock_engine.cpp
        render/voxel/voxel_renderer.cpp)

target_include_directories(starbench-native PRIVATE include)

find_library(log-lib log)
target_link_libraries(starbench-native ${log-lib})

# 渲染后端：Vulkan 优先，OpenGL ES 降级。实现期在此追加后端源文件与链接库。
# 选型理由见 docs/ARCHITECTURE.md。
