plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.xqly.starbench"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.xqly.starbench"
        minSdk = 21          // 兼容 Android 5.0+，目标设备 Android 9 (API 28)
        targetSdk = 28       // 「基于安卓 9」：把目标平台明确设为 Android 9
        versionCode = 4
        versionName = "0.4.0-android9-mobs64"
    }

    signingConfigs {
        // 注意：这是开源的【公开演示签名密钥】，仅用于让本 APK 可安装/可复现构建。
        // 正式发布必须替换为你自己保管的私有 keystore，切勿沿用此密钥。
        create("release") {
            storeFile = file("starbench-release.jks")
            storePassword = "StarBench2026"
            keyAlias = "starbench"
            keyPassword = "StarBench2026"
        }
    }

    buildTypes {
        debug { isMinifyEnabled = false }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        // 本 APK 为侧载分发且明确基于 Android 9，不上传 Google Play，
        // 故关闭「targetSdk 必须≥33」的商店策略检查；targetSdk 28 是产品口径，保持不动。
        disable += "ExpiredTargetSdkVersion"
        abortOnError = false
    }
}

// 运行时版刻意只用 Android 框架 API + Kotlin 标准库，不引入 AndroidX / 协程 / NDK，
// 以最小依赖在受限环境也能稳定产出可安装 APK。真实负载与渲染全部在 Kotlin + OpenGL ES 2.0 完成。
