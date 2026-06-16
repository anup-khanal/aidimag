package com.aidimag.intellij.actions

import com.aidimag.intellij.core.AidimagStateService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Manually run `dim knowledge sync` — summarize inbox docs into review proposals. */
class SyncKnowledgeAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    runOnBackground(project, "Sync Knowledge Inbox") {
      AidimagStateService.getInstance(project).syncKnowledge(manual = true)
    }
  }
}

