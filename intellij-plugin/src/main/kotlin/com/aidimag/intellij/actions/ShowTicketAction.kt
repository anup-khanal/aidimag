package com.aidimag.intellij.actions

import com.aidimag.intellij.core.AidimagNotifications
import com.aidimag.intellij.core.DimRunner
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages

class ShowTicketAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    runOnBackground(project, "Show Ticket") {
      val detected = detectTicketFromBranch(project)
      ApplicationManager.getApplication().invokeAndWait {
        val id = Messages.showInputDialog(
          project,
          "Ticket id (e.g. XXX-2100 or #123)",
          "aidimag: Show Ticket",
          null,
          detected,
          null,
        ) ?: return@invokeAndWait

        runOnBackground(project, "Show Ticket") {
          val result = DimRunner.run(project, listOf("ticket", "show", id))
          if (result.exitCode == 0) {
            val stdout = result.stdout
            val url = Regex("https?://\\S+").find(stdout)?.value
            ApplicationManager.getApplication().invokeLater {
              // surface the deep link as a clickable action (like VSCode's "Open in browser")
              if (url != null) {
                AidimagNotifications.infoWithAction(
                  project,
                  stdout.lineSequence().firstOrNull().orEmpty().ifBlank { "aidimag ticket" },
                  "Open in browser",
                ) { BrowserUtil.browse(url) }
              }
              Messages.showInfoMessage(project, stdout.ifBlank { "No ticket output" }, "aidimag ticket")
            }
          } else {
            val msg = result.stdout.ifBlank { "ticket show failed" }
            if (Regex("no ticketing app connected", RegexOption.IGNORE_CASE).containsMatchIn(msg)) {
              AidimagNotifications.errorWithAction(
                project,
                "aidimag: no ticketing app connected.",
                "Connect now",
              ) { runInTerminal(project, "aidimag tickets", listOf("ticket", "connect")) }
            } else {
              AidimagNotifications.error(project, "aidimag ticket: $msg")
            }
          }
        }
      }
    }
  }

  private fun detectTicketFromBranch(project: com.intellij.openapi.project.Project): String? {

    val gitBranch = try {
      val cmd = ProcessBuilder("git", "rev-parse", "--abbrev-ref", "HEAD")
        .directory(java.io.File(project.basePath ?: return null))
        .redirectErrorStream(true)
        .start()
      cmd.waitFor()
      cmd.inputStream.bufferedReader().use { it.readText().trim() }
    } catch (_: Exception) {
      return null
    }

    var pattern = "[A-Z][A-Z0-9]+-\\d+"
    try {
      val status = DimRunner.run(project, listOf("ticket", "status"))
      val regex = Regex("pattern:\\s*(\\S+)")
      pattern = regex.find(status.stdout)?.groupValues?.get(1) ?: pattern
    } catch (_: Exception) {
      // keep default
    }

    return try {
      Regex(pattern).find(gitBranch)?.value
    } catch (_: Exception) {
      null
    }
  }
}
