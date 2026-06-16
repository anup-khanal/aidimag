package com.aidimag.intellij.startup

import com.aidimag.intellij.core.AidimagStateService
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import java.io.File

/**
 * Watches the knowledge inbox folder and triggers a debounced `dim knowledge sync`
 * when a document is dropped — mirrors the on-drop watcher in `dim ui` and the
 * VSCode extension (KNOWLEDGEBASE_DESIGN.md "automatic on drop while a host is up").
 *
 * Subscribed per-project from AidimagStartupActivity with the project's
 * AidimagStateService as the parent disposable, so it tears down with the project.
 */
class AidimagKnowledgeWatcher(
  private val project: Project,
  /** Absolute inbox path with a trailing separator, e.g. /repo/knowledge/ */
  private val inboxPrefix: String,
) : BulkFileListener {

  override fun after(events: List<VFileEvent>) {
    if (project.isDisposed) return
    val touched = events.any { event ->
      val path = event.path
      path.startsWith(inboxPrefix) && !File(path).name.startsWith(".")
    }
    if (touched) {
      AidimagStateService.getInstance(project).scheduleKnowledgeSync()
    }
  }
}

