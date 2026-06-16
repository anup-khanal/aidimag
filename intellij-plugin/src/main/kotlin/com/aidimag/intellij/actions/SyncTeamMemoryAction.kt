package com.aidimag.intellij.actions

import com.aidimag.intellij.core.AidimagStateService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class SyncTeamMemoryAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    runOnBackground(project, "Sync Team Memory") {
      AidimagStateService.getInstance(project).syncNow(silent = false)
    }
  }
}
