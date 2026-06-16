package com.aidimag.intellij.statusbar

import com.aidimag.intellij.actions.openDashboardInBackground
import com.aidimag.intellij.actions.runInTerminal
import com.aidimag.intellij.core.AidimagStateService
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import java.awt.Component
import java.awt.event.MouseEvent

/** ☁ team-sync widget — click action depends on the current cloud state. */
class SyncStatusWidgetFactory : StatusBarWidgetFactory {
  override fun getId(): String = SyncStatusWidget.ID
  override fun getDisplayName(): String = "aidimag Team Sync"
  override fun isAvailable(project: Project): Boolean = true
  override fun createWidget(project: Project): StatusBarWidget = SyncStatusWidget(project)
  override fun disposeWidget(widget: StatusBarWidget) = Disposer.dispose(widget)
  override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}

class SyncStatusWidget(private val project: Project) :
  StatusBarWidget, StatusBarWidget.TextPresentation {

  override fun ID(): String = ID
  override fun getPresentation(): StatusBarWidget.WidgetPresentation = this
  override fun install(statusBar: StatusBar) {}
  override fun dispose() {}

  override fun getText(): String {
    val s = AidimagStateService.getInstance(project)
    return if (s.syncVisible) s.syncText else ""
  }

  override fun getTooltipText(): String = AidimagStateService.getInstance(project).syncTooltip

  override fun getClickConsumer(): Consumer<MouseEvent> = Consumer {
    val service = AidimagStateService.getInstance(project)
    when (service.syncClickAction) {
      AidimagStateService.SyncClick.DASHBOARD -> openDashboardInBackground(project)
      AidimagStateService.SyncClick.LOGIN -> runInTerminal(project, "aidimag login", listOf("login"))
      AidimagStateService.SyncClick.SYNC ->
        ApplicationManager.getApplication().executeOnPooledThread { service.syncNow(silent = false) }
    }
  }

  override fun getAlignment(): Float = Component.CENTER_ALIGNMENT

  companion object {
    const val ID = "AidimagSyncStatus"
  }
}

