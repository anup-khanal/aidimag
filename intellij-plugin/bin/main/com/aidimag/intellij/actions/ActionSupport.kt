package com.aidimag.intellij.actions

import com.aidimag.intellij.core.AidimagNotifications
import com.aidimag.intellij.settings.AidimagSettingsState
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.ui.Messages
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

fun projectOrWarn(e: AnActionEvent): Project? {
  val project = e.project
  if (project == null) {
    Messages.showErrorDialog("Open a project first.", "aidimag")
  }
  return project
}

fun runOnBackground(project: Project, name: String, body: () -> Unit) {
  ApplicationManager.getApplication().executeOnPooledThread {
    try {
      body()
    } catch (t: Throwable) {
      AidimagNotifications.error(project, "$name failed: ${t.message}")
    }
  }
}

fun openToolWindow(project: Project) {
  ToolWindowManager.getInstance(project).getToolWindow("aidimag")?.show()
}

/** Starts (if needed) the dim ui server on a pooled thread, then shows the tool window. */
fun openDashboardInBackground(project: Project) {
  runOnBackground(project, "Open Dashboard") {
    val dashboard = com.aidimag.intellij.dashboard.AidimagDashboardService.getInstance(project)
    val port = dashboard.ensureUiServerAndLoad()
    ApplicationManager.getApplication().invokeLater {
      openToolWindow(project)
      AidimagNotifications.info(project, "aidimag dashboard ready on port $port")
    }
  }
}

fun runInTerminal(project: Project, tabName: String, args: List<String>) {
  val root = project.basePath ?: return
  val dim = AidimagSettingsState.getInstance().state.dimPath.ifBlank { "dim" }
  val command = (listOf(dim) + args).joinToString(" ") { shellQuote(it) }
  val manager = TerminalToolWindowManager.getInstance(project)
  val shell = manager.createShellWidget(root, tabName, true, true) ?: return
  runCatching {
    shell.javaClass.getMethod("executeCommand", String::class.java).invoke(shell, command)
  }.recoverCatching {
    shell.javaClass.getMethod("sendCommandToExecute", String::class.java).invoke(shell, command)
  }
}

private fun shellQuote(text: String): String {
  val escaped = text.replace("'", "'\"'\"'")
  return "'$escaped'"
}

