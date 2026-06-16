package com.aidimag.intellij.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class OpenDashboardAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    openDashboardInBackground(project)
  }
}

