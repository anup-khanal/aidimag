plugins {
  id("java")
  id("org.jetbrains.kotlin.jvm") version "2.0.21"
  id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "com.aidimag"
version = "1.0.0"

repositories {
  mavenCentral()
  intellijPlatform {
    defaultRepositories()
  }
}

intellijPlatform {
  pluginConfiguration {
    ideaVersion {
      sinceBuild = "243"
      untilBuild = "261.*"
    }
    changeNotes = "Initial IntelliJ plugin for aidimag dashboard and CLI actions."
  }
}

dependencies {
  intellijPlatform {
    intellijIdeaCommunity("2024.3")
    instrumentationTools()
    bundledPlugin("org.jetbrains.plugins.terminal")
  }
}

tasks {
  wrapper {
    gradleVersion = "8.11.1"
  }

  patchPluginXml {
    pluginDescription = "aidimag plugin for IntelliJ IDEA. It embeds the dashboard and exposes common dim CLI actions."
  }

  withType<JavaCompile> {
    sourceCompatibility = "21"
    targetCompatibility = "21"
  }

  withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
  }
}

