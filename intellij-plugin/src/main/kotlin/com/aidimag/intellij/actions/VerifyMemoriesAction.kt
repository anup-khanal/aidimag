package com.aidimag.intellij.actions

import com.aidimag.intellij.core.AidimagNotifications
import com.aidimag.intellij.core.AidimagStateService
import com.aidimag.intellij.core.DimRunner
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class VerifyMemoriesAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    runOnBackground(project, "Verify Memories") {
      val result = DimRunner.run(project, listOf("verify", "-q"))
      when (result.exitCode) {
        0 -> AidimagNotifications.info(project, "aidimag: memories verified ✓")
        2 -> AidimagNotifications.warnWithAction(
          project,
          "aidimag: some memories went STALE — the codebase changed under them.",
          "Open Dashboard",
        ) { openDashboardInBackground(project) }
        else -> AidimagNotifications.error(project, result.stdout.ifBlank { "verify failed" })
      }
      AidimagStateService.getInstance(project).refreshMemoryStatus()
    }
  }
}
