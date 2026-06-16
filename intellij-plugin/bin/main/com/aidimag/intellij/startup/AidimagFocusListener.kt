package com.aidimag.intellij.startup

import com.aidimag.intellij.core.AidimagStateService
import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.wm.IdeFrame

/** Re-checks status when the IDE window regains focus — git operations are
 *  likely to have happened (mirrors onDidChangeWindowState in VSCode). */
class AidimagFocusListener : ApplicationActivationListener {
  override fun applicationActivated(ideFrame: IdeFrame) {
    val project = ideFrame.project ?: return
    if (project.isDisposed) return
    AidimagStateService.getInstance(project).refreshAllAsync()
  }
}

