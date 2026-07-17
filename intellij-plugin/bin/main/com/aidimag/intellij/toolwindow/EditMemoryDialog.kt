package com.aidimag.intellij.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.*

class EditMemoryDialog(project: Project, private val memory: MemoryNode) : DialogWrapper(project, true) {

  private val claimArea = JTextArea(6, 44).apply {
    lineWrap = true
    wrapStyleWord = true
    border = JBUI.Borders.empty(4)
    text = memory.claim
  }

  private val kindCombo = JComboBox(arrayOf(
    "DECISION", "CONVENTION", "GOTCHA", "FAILED_APPROACH",
    "INVARIANT", "ARCHITECTURE", "TODO_CONTEXT", "GUARDRAIL", "SKILL",
  )).apply {
    selectedItem = memory.kind
  }

  private val guardrailCombo = JComboBox(arrayOf("ask-first", "always", "never")).apply {
    isVisible = memory.kind == "GUARDRAIL"
    selectedItem = memory.guardrailLevel ?: "ask-first"
  }
  private val guardrailLabel = JBLabel("Enforcement:").apply { 
    isVisible = memory.kind == "GUARDRAIL"
  }

  private val evidenceList = memory.evidence.mapIndexed { idx, ev ->
    EvidenceItemWithId(ev.type, ev.payload, idx)
  }.toMutableList()
  private val evidenceListModel = DefaultListModel<String>().apply {
    memory.evidence.forEach { addElement("${it.type}: ${it.payload}") }
  }
  private val evidenceJList = JList(evidenceListModel)

  private val evidenceTypeCombo = JComboBox(arrayOf(
    "STATIC_CHECK", "COMMIT_REF", "TEST_RESULT", "HUMAN_ATTESTED", "TICKET_REF"
  ))
  private val evidencePayloadField = JTextField(30)

  private val evidenceToRemove = mutableListOf<Int>()

  val claim: String  get() = claimArea.text.trim()
  val kind: String   get() = kindCombo.selectedItem as String
  val guardrailLevel: String? get() = if (kind == "GUARDRAIL") guardrailCombo.selectedItem as String else null
  val newEvidence: List<EvidenceItem> get() = evidenceList.filter { ev ->
    ev.id == -1 // New evidence has id -1
  }.map { EvidenceItem(it.type, it.payload) }
  val removedEvidenceIndices: List<Int> get() = evidenceToRemove

data class EvidenceItemWithId(val type: String, val payload: String, val id: Int)

  init {
    title = "Edit Memory: ${memory.claim.take(40)}..."
    setOKButtonText("Save Changes")
    kindCombo.addActionListener {
      val isGuardrail = kindCombo.selectedItem == "GUARDRAIL"
      guardrailCombo.isVisible = isGuardrail
      guardrailLabel.isVisible = isGuardrail
    }
    init()
  }

  override fun createCenterPanel(): JComponent {
    val claimScroll = JBScrollPane(claimArea).apply {
      preferredSize = Dimension(500, 100)
    }

    val addEvidenceBtn = JButton("Add Evidence").apply {
      addActionListener {
        val type = evidenceTypeCombo.selectedItem as String
        val payload = evidencePayloadField.text.trim()
        if (payload.isNotEmpty()) {
          evidenceList.add(EvidenceItemWithId(type, payload, -1)) // -1 means new
          evidenceListModel.addElement("$type: $payload")
          evidencePayloadField.text = ""
        }
      }
    }

    val removeEvidenceBtn = JButton("Remove").apply {
      addActionListener {
        val idx = evidenceJList.selectedIndex
        if (idx >= 0) {
          val item = evidenceList[idx]
          if (item.id >= 0) {
            // Removing existing evidence - track index for removal
            evidenceToRemove.add(item.id)
          }
          evidenceListModel.remove(idx)
          evidenceList.removeAt(idx)
        }
      }
    }

    val evidencePanel = JPanel(BorderLayout()).apply {
      add(JBLabel("Evidence:"), BorderLayout.NORTH)
      add(JBScrollPane(evidenceJList).apply {
        preferredSize = Dimension(500, 100)
      }, BorderLayout.CENTER)
      val addPanel = JPanel().apply {
        add(evidenceTypeCombo)
        add(evidencePayloadField)
        add(addEvidenceBtn)
        add(removeEvidenceBtn)
      }
      add(addPanel, BorderLayout.SOUTH)
    }

    return FormBuilder.createFormBuilder()
      .addLabeledComponent(JBLabel("Kind:"), kindCombo, 1, false)
      .addLabeledComponent(guardrailLabel, guardrailCombo, 1, false)
      .addLabeledComponent(JBLabel("Claim:"), claimScroll, 1, true)
      .addComponent(evidencePanel, 8)
      .addComponentFillVertically(JPanel(), 0)
      .panel
      .also { it.border = JBUI.Borders.empty(8) }
  }

  override fun doOKAction() {
    if (claim.length < 10) {
      Messages.showErrorDialog(contentPane, "Claim must be at least 10 characters.", "Edit Memory")
      return
    }
    super.doOKAction()
  }
}
