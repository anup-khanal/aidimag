package com.aidimag.intellij.statusbar

import com.aidimag.intellij.actions.openDashboardInBackground
import com.aidimag.intellij.core.AidimagStateService
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import com.intellij.openapi.util.IconLoader
import java.awt.Component
import java.awt.event.MouseEvent
import javax.swing.Icon

/** 🧠 memory-counts widget — click opens the dashboard. */
class MemoryStatusWidgetFactory : StatusBarWidgetFactory {
  override fun getId(): String = MemoryStatusWidget.ID
  override fun getDisplayName(): String = "aidimag Memory"
  override fun isAvailable(project: Project): Boolean = true
  override fun createWidget(project: Project): StatusBarWidget = MemoryStatusWidget(project)
  override fun disposeWidget(widget: StatusBarWidget) = Disposer.dispose(widget)
  override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}

class MemoryStatusWidget(private val project: Project) :
  StatusBarWidget, StatusBarWidget.IconPresentation {

  override fun ID(): String = ID
  override fun getPresentation(): StatusBarWidget.WidgetPresentation = this
  override fun install(statusBar: StatusBar) {}
  override fun dispose() {}

  override fun getIcon(): Icon = IconLoader.getIcon("/icons/aidimag_toolwindow.svg", javaClass)

  override fun getTooltipText(): String {
    val s = AidimagStateService.getInstance(project)
    val baseTooltip = s.memoryTooltip
    return if (s.hasStale) "$baseTooltip ⚠ (stale memories detected)" else baseTooltip
  }

  override fun getClickConsumer(): Consumer<MouseEvent> = Consumer {
    openDashboardInBackground(project)
  }

  companion object {
    const val ID = "AidimagMemoryStatus"
  }
}

