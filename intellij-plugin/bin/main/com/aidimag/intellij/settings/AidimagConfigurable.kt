package com.aidimag.intellij.settings

import com.intellij.openapi.options.SearchableConfigurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JSpinner
import javax.swing.SpinnerNumberModel

class AidimagConfigurable : SearchableConfigurable {
  private val dimPathField = JBTextField()
  private val uiPortSpinner = JSpinner(SpinnerNumberModel(4517, 1, 65535, 1))
  private val autoSyncSpinner = JSpinner(SpinnerNumberModel(10, 0, 1440, 1))
  private val knowledgeWatchCheckBox = JBCheckBox("Watch knowledge inbox and auto-summarize dropped docs")
  private var panel: JPanel? = null

  override fun getId(): String = "aidimag.settings"

  override fun getDisplayName(): String = "aidimag"

  override fun createComponent(): JComponent {
    panel = FormBuilder.createFormBuilder()
      .addLabeledComponent("dim CLI path:", dimPathField)
      .addLabeledComponent("Dashboard port:", uiPortSpinner)
      .addLabeledComponent("Auto-sync interval (minutes):", autoSyncSpinner)
      .addComponent(knowledgeWatchCheckBox)
      .addComponentFillVertically(JPanel(), 0)
      .panel
    reset()
    return panel as JPanel
  }

  override fun isModified(): Boolean {
    val state = AidimagSettingsState.getInstance().state
    return dimPathField.text != state.dimPath ||
      (uiPortSpinner.value as Int) != state.uiPort ||
      (autoSyncSpinner.value as Int) != state.autoSyncMinutes ||
      knowledgeWatchCheckBox.isSelected != state.knowledgeWatch
  }

  override fun apply() {
    val settings = AidimagSettingsState.getInstance()
    settings.state.dimPath = dimPathField.text.trim().ifEmpty { "dim" }
    settings.state.uiPort = uiPortSpinner.value as Int
    settings.state.autoSyncMinutes = autoSyncSpinner.value as Int
    settings.state.knowledgeWatch = knowledgeWatchCheckBox.isSelected
    // reschedule the background sync with the new interval (mirrors
    // onDidChangeConfiguration in the VSCode extension)
    for (project in com.intellij.openapi.project.ProjectManager.getInstance().openProjects) {
      com.aidimag.intellij.core.AidimagStateService.getInstance(project).scheduleAutoSync()
    }
  }

  override fun reset() {
    val state = AidimagSettingsState.getInstance().state
    dimPathField.text = state.dimPath
    uiPortSpinner.value = state.uiPort
    autoSyncSpinner.value = state.autoSyncMinutes
    knowledgeWatchCheckBox.isSelected = state.knowledgeWatch
  }

  override fun disposeUIResources() {
    panel = null
  }
}

