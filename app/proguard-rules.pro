# JNI 契约类与原生桥接方法不可混淆
-keep class com.xqly.starbench.common.NativeBridge { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}
