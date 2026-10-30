pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
// rustls-platform-verifier (the prover's TLS) ships its Kotlin half as a local Maven repository
// inside the crate; cargo metadata says where the crate is.
val verifierMaven: String = run {
    val metadata = providers.exec {
        commandLine("cargo", "metadata", "--format-version", "1", "--manifest-path", "native/Cargo.toml")
    }.standardOutput.asText.get()
    val manifest = Regex(""""manifest_path":"([^"]*/rustls-platform-verifier-android-[^"/]*/Cargo.toml)"""").find(metadata)
        ?: error("rustls-platform-verifier-android not found in cargo metadata for native/")
    File(manifest.groupValues[1]).parentFile.resolve("maven").path
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven {
            url = uri(verifierMaven)
            metadataSources.artifact()
        }
    }
}
rootProject.name = "Moth"
include(":app")
