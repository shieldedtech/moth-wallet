import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "io.shielded.moth"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.shielded.moth"
        minSdk = 30
        targetSdk = 34
        versionCode = 1
        versionName = "0.0.1"
        ndk { abiFilters += "arm64-v8a" }
        // -PmothAppSuffix=.fresh installs a second copy with its own storage and Keystore,
        // e.g. to time a new wallet without touching an existing one.
        val suffix = (project.findProperty("mothAppSuffix") as String?).orEmpty()
        applicationIdSuffix = suffix
        manifestPlaceholders["appLabel"] = if (suffix.isEmpty()) "Moth" else "Moth (${suffix.trimStart('.')})"
        // UI tests: scripts/ui-test.sh runs them with -PmothAppSuffix=.uitest.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    // QR codes for Receive (the iOS app uses CoreImage's generator).
    implementation("com.google.zxing:core:3.5.3")
    implementation("rustls:rustls-platform-verifier:0.1.1")

    androidTestImplementation(platform("androidx.compose:compose-bom:2024.10.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    // The fingerprint prompt is system UI, out of Compose's reach.
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
