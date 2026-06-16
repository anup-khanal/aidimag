package com.aidimag.intellij.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.Messages

class TicketBranchAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    val id = Messages.showInputDialog(
      project,
      "Ticket id to branch from (creates feature/<ID>-<title-slug>)",
      "aidimag: Create Ticket Branch",
      null,
    ) ?: return
    runInTerminal(project, "aidimag branch", listOf("branch", id))
  }
}

