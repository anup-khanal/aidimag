package com.aidimag.intellij.dashboard

import com.aidimag.intellij.core.DimRunner
import com.aidimag.intellij.settings.AidimagSettingsState
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import java.awt.BorderLayout
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

@Service(Service.Level.PROJECT)
class AidimagDashboardService(private val project: Project) : Disposable {
  private val rootPanel = JPanel(BorderLayout())
  private var browser: JBCefBrowser? = null
  private var uiProcess: Process? = null
  private var pendingUrl: String? = null

  fun component(): JComponent {
    if (browser == null && JBCefApp.isSupported()) {
      browser = JBCefBrowser("about:blank")
      rootPanel.add(browser!!.component, BorderLayout.CENTER)
      pendingUrl?.let { browser!!.loadURL(it) }
      Disposer.register(this, browser!!)
    } else if (browser == null) {
      rootPanel.add(JLabel("JCEF is not available in this IDE runtime."), BorderLayout.CENTER)
    }
    return rootPanel
  }

  /** True if the dim ui server is already listening on [port]. */
  fun isServerAlive(port: Int = AidimagSettingsState.getInstance().state.uiPort): Boolean = isUiAlive(port)

  /** Starts the dim ui server if not running; does NOT load any URL (used by the memory explorer). */
  fun ensureServer() {
    val port = AidimagSettingsState.getInstance().state.uiPort
    if (!isUiAlive(port)) {
      startUi(port)
      var alive = false
      for (i in 0 until 20) {
        Thread.sleep(250)
        if (isUiAlive(port)) { alive = true; break }
      }
      check(alive) { "Dashboard server did not start. Make sure dim CLI is installed." }
    }
  }

  fun ensureUiServerAndLoad(): Int {
    val port = AidimagSettingsState.getInstance().state.uiPort
    if (!isUiAlive(port)) {
      startUi(port)
      var alive = false
      for (i in 0 until 20) {
        Thread.sleep(250)
        if (isUiAlive(port)) {
          alive = true
          break
        }
      }
      check(alive) { "Dashboard server did not start. Make sure dim CLI is installed." }
    }
    val url = "http://localhost:$port"
    pendingUrl = url
    browser?.loadURL(url)
    return port
  }

  private fun startUi(port: Int) {
    // DimRunner.commandLine inherits the user's shell PATH (CONSOLE parent
    // env) — required on macOS where the IDE launched from Finder cannot
    // see npm-global binaries like `dim`.
    val cmd = DimRunner.commandLine(project, listOf("ui", "--no-open", "--port", port.toString()))
    uiProcess = cmd.toProcessBuilder()
      .redirectOutput(ProcessBuilder.Redirect.DISCARD)
      .redirectError(ProcessBuilder.Redirect.DISCARD)
      .start()
  }

  private fun isUiAlive(port: Int): Boolean {
    return try {
      val conn = URL("http://127.0.0.1:$port/api/state").openConnection() as HttpURLConnection
      conn.connectTimeout = 1500
      conn.readTimeout = 1500
      conn.requestMethod = "GET"
      conn.inputStream.use { stream ->
        BufferedReader(InputStreamReader(stream)).use { reader ->
          reader.readLine() != null
        }
      }
    } catch (_: Exception) {
      false
    }
  }

  override fun dispose() {
    uiProcess?.destroy()
  }

  companion object {
    fun getInstance(project: Project): AidimagDashboardService = project.service()
  }
}

