package com.aidimag.intellij.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import javax.swing.*

class AddMemoryDialog(project: Project) : DialogWrapper(project, true) {

  private val claimArea = JTextArea(6, 44).apply {
    lineWrap = true
    wrapStyleWord = true
    border = JBUI.Borders.empty(4)
  }

  private val kindCombo = JComboBox(arrayOf(
    "DECISION", "CONVENTION", "GOTCHA", "FAILED_APPROACH",
    "INVARIANT", "ARCHITECTURE", "TODO_CONTEXT", "GUARDRAIL", "SKILL",
  ))

  private val guardrailCombo = JComboBox(arrayOf("never", "ask-first", "always")).apply {
    isVisible = false
  }
  private val guardrailLabel = JBLabel("Enforcement:").apply { isVisible = false }

  private val pinnedCheck = JCheckBox("📌 Pin this memory (exempt from time decay)")

  val claim: String  get() = claimArea.text.trim()
  val kind: String   get() = kindCombo.selectedItem as String
  val pinned: Boolean get() = pinnedCheck.isSelected
  /** non-null only when kind == GUARDRAIL */
  val guardrailLevel: String? get() = if (kind == "GUARDRAIL") guardrailCombo.selectedItem as String else null

  init {
    title = "Add Memory"
    setOKButtonText("Save")
    kindCombo.addActionListener {
      val isGuardrail = kindCombo.selectedItem == "GUARDRAIL"
      guardrailCombo.isVisible = isGuardrail
      guardrailLabel.isVisible = isGuardrail
    }
    init()
  }

  override fun createCenterPanel(): JComponent {
    val scroll = JBScrollPane(claimArea).apply {
      preferredSize = Dimension(420, 120)
    }
    return FormBuilder.createFormBuilder()
      .addLabeledComponent(JBLabel("Kind:"), kindCombo, 1, false)
      .addLabeledComponent(guardrailLabel, guardrailCombo, 1, false)
      .addLabeledComponent(JBLabel("Claim:"), scroll, 1, true)
      .addComponent(pinnedCheck, 8)
      .addComponentFillVertically(JPanel(), 0)
      .panel
      .also { it.border = JBUI.Borders.empty(8) }
  }

  override fun doOKAction() {
    if (claim.isBlank()) {
      Messages.showErrorDialog(contentPane, "Claim cannot be empty.", "Add Memory")
      return
    }
    super.doOKAction()
  }
}

