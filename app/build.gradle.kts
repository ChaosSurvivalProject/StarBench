plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.xqly.starbench"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.xqly.starbench"
        minSdk = 26          // PerformanceHintManager(31)/Thermal(29) 在代码中按 SDK_INT 守卫
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-skeleton"

        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++17"
                // 渲染后端由 CMake 选项控制：VULKAN 优先，OpenGL ES 降级
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    buildTypes {
        debug { isMinifyEnabled = false }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    // 开发期比对参照素材放在 tools/parity-reference/，不进任何发布 sourceSet。
    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.moshi:moshi-kotlin:1.15.1") // JSON / system.json 导出
    testImplementation("junit:junit:4.13.2")
}
