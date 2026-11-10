plugins {
    id("com.android.application") version "9.3.3"
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20"
}

extensions.configure<com.android.build.api.dsl.ApplicationExtension> {
    namespace = "org.fullstacked"
    compileSdk = 37

    ndkVersion = "29.0.14206865"

    defaultConfig {
        applicationId = "org.fullstacked"
        minSdk = 29
        targetSdk = 37
        versionCode = 1809
        versionName = "1.0.0"

        vectorDrawables {
            useSupportLibrary = true
        }
        ndk {
            abiFilters += listOf("armeabi-v7a","arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_20
        targetCompatibility = JavaVersion.VERSION_20
    }
    buildFeatures {
        compose = true
        resValues = true
    }
    sourceSets {
        getByName("main") {
            assets {
                directories.add("../../../../out/zip")
            }
            jniLibs {
                directories.add("src/main/cpp/core")
            }
        }
    }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
}

// shell/out, the app's page, as the app ships it: npm run build:shell:release
// (build-shell.ts at the repository's root). SHELL_PLUGINS and SHELL_FILES in
// the environment change its plugins and extra files.
tasks.register<Exec>("buildShell") {
    workingDir = file("../../../..")
    val windows = System.getProperty("os.name").lowercase().contains("windows")
    commandLine(if (windows) "npm.cmd" else "npm", "run", "build:shell:release")
    if (!windows) {
        // Android Studio started from the dock doesn't get the terminal's PATH
        val home = System.getProperty("user.home")
        environment(
            "PATH",
            listOf(
                "$home/.local/bin",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/local/go/bin",
                System.getenv("PATH") ?: ""
            ).joinToString(File.pathSeparator)
        )
    }
}

tasks.register<Zip>("zipAppOut") {
    dependsOn("buildShell")
    from("../../../../shell/out")
    archiveFileName.set("out.zip")
    destinationDirectory.set(file("src/main/res/raw"))
}

tasks.named("preBuild") {
    dependsOn("zipAppOut")
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_20)
    }
}

//noinspection UseTomlInstead
dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.webkit)
    debugImplementation(libs.androidx.ui.tooling)
}