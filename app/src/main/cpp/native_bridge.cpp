#include <jni.h>

#include "starbench_engine.h"

namespace starbench {
IEditionEngine* createJavaEngine();
IEditionEngine* createBedrockEngine();
}

extern "C" {

JNIEXPORT jdouble JNICALL
Java_com_xqly_starbench_common_NativeBridge_javaTick(
        JNIEnv*, jclass, jlong seed, jlong tick_index, jint simulate_distance) {
    return starbench::createJavaEngine()->tick(
        static_cast<uint64_t>(seed), static_cast<int64_t>(tick_index), simulate_distance);
}

JNIEXPORT jdouble JNICALL
Java_com_xqly_starbench_common_NativeBridge_bedrockTick(
        JNIEnv*, jclass, jlong seed, jlong tick_index, jint simulate_distance) {
    return starbench::createBedrockEngine()->tick(
        static_cast<uint64_t>(seed), static_cast<int64_t>(tick_index), simulate_distance);
}

JNIEXPORT jlong JNICALL
Java_com_xqly_starbench_common_NativeBridge_rebuildChunks(
        JNIEnv*, jclass, jlong seed, jint cx, jint cz, jint radius) {
    return static_cast<jlong>(starbench::createJavaEngine()->rebuildChunks(
        static_cast<uint64_t>(seed), cx, cz, radius));
}

JNIEXPORT jlong JNICALL
Java_com_xqly_starbench_common_NativeBridge_propagateLight(
        JNIEnv*, jclass, jlong seed, jint count) {
    return static_cast<jlong>(starbench::createJavaEngine()->propagateLight(
        static_cast<uint64_t>(seed), count));
}

JNIEXPORT jlong JNICALL
Java_com_xqly_starbench_common_NativeBridge_updateRedstone(
        JNIEnv*, jclass, jlong seed, jfloat density) {
    return static_cast<jlong>(starbench::createJavaEngine()->updateRedstone(
        static_cast<uint64_t>(seed), static_cast<float>(density)));
}

JNIEXPORT jlong JNICALL
Java_com_xqly_starbench_common_NativeBridge_stepEntities(
        JNIEnv*, jclass, jlong seed, jint count) {
    return static_cast<jlong>(starbench::createJavaEngine()->stepEntities(
        static_cast<uint64_t>(seed), count));
}

JNIEXPORT jlong JNICALL
Java_com_xqly_starbench_common_NativeBridge_syncNetwork(
        JNIEnv*, jclass, jint players, jint ticks) {
    return static_cast<jlong>(starbench::createJavaEngine()->syncNetwork(players, ticks));
}

JNIEXPORT jlong JNICALL
Java_com_xqly_starbench_common_NativeBridge_worldSnapshotHash(JNIEnv*, jclass) {
    return static_cast<jlong>(starbench::createJavaEngine()->worldSnapshotHash());
}

}  // extern "C"
