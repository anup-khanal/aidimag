package com.aidimag.intellij.startup

import com.aidimag.intellij.core.AidimagStateService
import com.aidimag.intellij.settings.AidimagSettingsState
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.vfs.VirtualFileManager
import java.io.File

/** Mirrors activate() in the VSCode extension: initial status refresh,
 *  auto-sync schedule, a one-shot background sync ~5s after startup, and a
 *  knowledge-inbox watcher that auto-summarizes dropped docs. */
class AidimagStartupActivity : ProjectActivity {
  override suspend fun execute(project: Project) {
    val service = AidimagStateService.getInstance(project)
    service.refreshAllAsync()
    service.scheduleAutoSync()
    service.scheduleInitialSync()
    startKnowledgeWatcher(project, service)
  }

  /** Subscribe a VFS listener on the inbox and catch up on anything already waiting. */
  private fun startKnowledgeWatcher(project: Project, service: AidimagStateService) {
    if (!AidimagSettingsState.getInstance().state.knowledgeWatch) return
    val base = project.basePath ?: return
    val inboxPrefix = File(base, service.knowledgeFolder()).path + File.separator
    val connection = ApplicationManager.getApplication().messageBus.connect(service)
    connection.subscribe(
      VirtualFileManager.VFS_CHANGES,
      AidimagKnowledgeWatcher(project, inboxPrefix),
    )
    // catch up on docs dropped while the IDE was closed
    ApplicationManager.getApplication().executeOnPooledThread {
      if (!project.isDisposed) service.syncKnowledge(manual = false)
    }
  }
}


