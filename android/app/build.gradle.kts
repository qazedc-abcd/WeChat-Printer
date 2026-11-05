plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "xyz.wechatprinter.wechat_printer_print_only"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "xyz.wechatprinter.wechat_printer_print_only"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    val previewKeyPath = System.getenv("PRINT_ONLY_KEYSTORE_PATH")
    if (!previewKeyPath.isNullOrBlank()) {
        val password = System.getenv("PRINT_ONLY_KEYSTORE_PASSWORD")
        require(!password.isNullOrBlank()) { "Configured preview signing key requires its password" }
        signingConfigs.create("persistentPreview") {
            storeFile = file(previewKeyPath)
            storePassword = password
            keyAlias = "printonly-preview"
            keyPassword = password
        }
    }

    buildTypes {
        release {
            // Published previews share a persistent key; local builds can use debug.
            signingConfig = signingConfigs.getByName(
                if (previewKeyPath.isNullOrBlank()) "debug" else "persistentPreview"
            )
        }
    }
}

flutter {
    source = "../.."
}
