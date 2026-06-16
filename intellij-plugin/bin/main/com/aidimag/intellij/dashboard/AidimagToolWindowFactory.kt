package com.aidimag.intellij.dashboard

import com.aidimag.intellij.toolwindow.MemoryExplorerPanel
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class AidimagToolWindowFactory : ToolWindowFactory, DumbAware {
  override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
    val cf = ContentFactory.getInstance()

    // Tab 1 — native Memory Explorer (always available)
    val explorer = MemoryExplorerPanel(project)
    Disposer.register(toolWindow.disposable, explorer)
    toolWindow.contentManager.addContent(
      cf.createContent(explorer, "Memories", false)
    )

    // Tab 2 — embedded web Dashboard (needs JCEF; shown even without it, shows fallback label)
    val dashboard = AidimagDashboardService.getInstance(project)
    toolWindow.contentManager.addContent(
      cf.createContent(dashboard.component(), "Dashboard", false)
    )
  }

  override fun shouldBeAvailable(project: Project): Boolean = true
}

