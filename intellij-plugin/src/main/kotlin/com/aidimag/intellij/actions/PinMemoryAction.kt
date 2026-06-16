package com.aidimag.intellij.actions

import com.aidimag.intellij.core.AidimagNotifications
import com.aidimag.intellij.core.AidimagStateService
import com.aidimag.intellij.core.DimRunner
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory

/**
 * "aidimag: Pin/Unpin Memory" — chooser over recent memories; pinned memories
 * never decay with age (but a failing evidence check still marks them STALE).
 * Mirrors the VSCode extension's aidimag.pinMemory quick-pick.
 */
class PinMemoryAction : AnAction() {

  data class MemoryItem(
    val id: String,
    val kind: String,
    val status: String,
    val claim: String,
    val pinned: Boolean,
  ) {
    override fun toString(): String {
      val short = if (claim.length > 80) claim.take(80) + "…" else claim
      return "${if (pinned) "📌 " else ""}$short  ·  $kind · $status"
    }
  }

  override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    runOnBackground(project, "Pin Memory") {
      val out = DimRunner.run(project, listOf("log", "-n", "200")).stdout
      val items = parseMemories(out)
      ApplicationManager.getApplication().invokeLater {
        if (project.isDisposed) return@invokeLater
        if (items.isEmpty()) {
          AidimagNotifications.info(project, "No memories yet — store one with `dim remember` first.")
          return@invokeLater
        }
        JBPopupFactory.getInstance()
          .createPopupChooserBuilder(items)
          .setTitle("Pin/Unpin Memory — pinned memories never decay with age")
          .setItemChosenCallback { item -> togglePin(project, item) }
          .createPopup()
          .showCenteredInCurrentWindow(project)
      }
    }
  }

  private fun togglePin(project: Project, item: MemoryItem) {
    runOnBackground(project, "Pin Memory") {
      val verb = if (item.pinned) "unpin" else "pin"
      val result = DimRunner.run(project, listOf(verb, item.id))
      if (result.exitCode != 0) error(result.stdout.trim().ifBlank { "$verb failed" })
      AidimagNotifications.info(
        project,
        if (item.pinned) "Memory unpinned — normal confidence decay resumes."
        else "Memory pinned 📌 — exempt from time decay (evidence failure can still mark it stale).",
      )
      AidimagStateService.getInstance(project).refreshMemoryStatus()
    }
  }

  companion object {
    // `dim log` prints pairs of lines:
    //   ✓ 📌 [DECISION] We rejected CRDTs …
    //       id=bab471a9 status=VERIFIED conf=0.90 pinned scope=…
    private val CLAIM_LINE = Regex("""^[✓✗~?]\s+(?:📌\s+)?\[([A-Z_]+)]\s+(.+)$""")
    private val META_LINE = Regex("""^\s+id=([0-9a-f]{8})\s+status=(\w+)\s+conf=[\d.]+(\s+pinned)?""")

    fun parseMemories(stdout: String): List<MemoryItem> {
      val items = mutableListOf<MemoryItem>()
      val lines = stdout.lines()
      var i = 0
      while (i < lines.size - 1) {
        val claim = CLAIM_LINE.find(lines[i])
        val meta = claim?.let { META_LINE.find(lines[i + 1]) }
        if (claim != null && meta != null) {
          val status = meta.groupValues[2]
          if (status != "REFUTED") {
            items.add(
              MemoryItem(
                id = meta.groupValues[1],
                kind = claim.groupValues[1],
                status = status,
                claim = claim.groupValues[2],
                pinned = meta.groupValues[3].isNotBlank(),
              )
            )
          }
          i += 2
        } else {
          i++
        }
      }
      return items
    }
  }
}

