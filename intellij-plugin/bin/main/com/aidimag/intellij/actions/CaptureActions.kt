package com.aidimag.intellij.actions

import com.aidimag.intellij.core.AidimagNotifications
import com.aidimag.intellij.core.AidimagStateService
import com.aidimag.intellij.core.DimRunner
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages

/**
 * Capture & context actions (parity with the VS Code extension 0.8.0):
 *
 *   BootstrapAction        dim bootstrap [--force]      repo survey → starter proposals
 *   MineAction             dim mine [--llm|--prs|--full] git-history mining tiers
 *   HarvestAction          dim harvest [--all|--install-hook] AI-chat transcript mining
 *   BriefAction            dim brief                    session-start briefing
 *   GapsAction             dim gaps [--clear]           zero-hit search log
 *   VerifyTrustAction      dim verify --trust           inspect/approve synced-in evidence
 *   GenerateContextAction  dim generate-context -f …    CLAUDE.md / .cursorrules / copilot
 *
 * Long-running or interactive commands go to the integrated terminal; quick
 * read-only commands run on a pooled thread and surface via dialogs/notifications.
 */

class BootstrapAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    val choice = Messages.showDialog(
      project,
      "Survey this repo (README, docs, manifests, git churn) and LLM-draft a starter memory set?\n" +
        "Everything lands in the review queue — nothing is stored without your approval.",
      "aidimag: Bootstrap Starter Memory",
      arrayOf("Bootstrap", "Bootstrap (--force re-run)", "Cancel"),
      0, null,
    )
    when (choice) {
      0 -> runInTerminal(project, "aidimag bootstrap", listOf("bootstrap"))
      1 -> runInTerminal(project, "aidimag bootstrap", listOf("bootstrap", "--force"))
    }
  }
}

class MineAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    val choice = Messages.showDialog(
      project,
      "Mine git history into memory proposals (review-gated):\n\n" +
        "• Standard — fast keyword heuristics, incremental\n" +
        "• Deep (--llm) — the LLM reads each commit's message + diff\n" +
        "• PRs (--prs) — merged GitHub PRs + review comments via gh\n" +
        "• Full (--full) — re-mine the entire history with heuristics",
      "aidimag: Mine Git History",
      arrayOf("Standard", "Deep (--llm)", "PRs (--prs)", "Full (--full)", "Cancel"),
      0, null,
    )
    val args = when (choice) {
      0 -> listOf("mine")
      1 -> listOf("mine", "--llm")
      2 -> listOf("mine", "--prs")
      3 -> listOf("mine", "--full")
      else -> return
    }
    runInTerminal(project, "aidimag mine", args)
  }
}

class HarvestAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    val choice = Messages.showDialog(
      project,
      "Harvest durable facts you typed into AI chats (Claude Code transcripts,\n" +
        "local-only, secrets redacted) into the review queue.",
      "aidimag: Harvest AI Chat Transcripts",
      arrayOf("Latest sessions", "All transcripts (--all)", "Install SessionEnd hook", "Cancel"),
      0, null,
    )
    val args = when (choice) {
      0 -> listOf("harvest")
      1 -> listOf("harvest", "--all")
      2 -> listOf("harvest", "--install-hook")
      else -> return
    }
    runInTerminal(project, "aidimag harvest", args)
  }
}

class BriefAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    runOnBackground(project, "Session Briefing") {
      val result = DimRunner.run(project, listOf("brief"))
      ApplicationManager.getApplication().invokeLater {
        if (result.exitCode == 0 && result.stdout.isNotBlank()) {
          Messages.showInfoMessage(project, result.stdout.take(4000), "aidimag: Session Briefing")
        } else {
          AidimagNotifications.error(project, "brief failed: ${result.stdout.ifBlank { "no output" }}")
        }
      }
    }
  }
}

class GapsAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    runOnBackground(project, "Knowledge Gaps") {
      val result = DimRunner.run(project, listOf("gaps"))
      ApplicationManager.getApplication().invokeLater {
        if (result.exitCode != 0) {
          AidimagNotifications.error(project, "gaps failed: ${result.stdout.ifBlank { "no output" }}")
          return@invokeLater
        }
        val choice = Messages.showDialog(
          project,
          result.stdout.take(4000).ifBlank { "No knowledge gaps logged. 🎉" },
          "aidimag: Knowledge Gaps (questions memory couldn't answer)",
          arrayOf("Close", "Clear Gap Log"),
          0, null,
        )
        if (choice == 1) {
          runOnBackground(project, "Clear Gaps") {
            DimRunner.run(project, listOf("gaps", "--clear"))
            AidimagNotifications.info(project, "aidimag: gap log cleared")
          }
        }
      }
    }
  }
}

class VerifyTrustAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    // Interactive: shows each synced-in evidence command for inspection/approval.
    runInTerminal(project, "aidimag verify --trust", listOf("verify", "--trust"))
  }
}

class GenerateContextAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = projectOrWarn(e) ?: return
    val choice = Messages.showDialog(
      project,
      "Render verified memory into static context files for non-MCP AI tools.",
      "aidimag: Generate Context Files",
      arrayOf("All formats", "CLAUDE.md", ".cursorrules", "copilot-instructions.md", "Cancel"),
      0, null,
    )
    val fmt = when (choice) {
      0 -> "all"
      1 -> "claude"
      2 -> "cursorrules"
      3 -> "copilot"
      else -> return
    }
    runOnBackground(project, "Generate Context") {
      val result = DimRunner.run(project, listOf("generate-context", "-f", fmt))
      if (result.exitCode == 0) {
        AidimagNotifications.info(
          project,
          result.stdout.trim().lines().lastOrNull()?.ifBlank { null }
            ?: "aidimag: context files generated ✓",
        )
        AidimagStateService.getInstance(project).refreshMemoryStatus()
      } else {
        AidimagNotifications.error(project, "generate-context failed: ${result.stdout.ifBlank { "no output" }}")
      }
    }
  }
}

