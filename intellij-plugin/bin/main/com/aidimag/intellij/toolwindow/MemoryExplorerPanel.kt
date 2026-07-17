package com.aidimag.intellij.toolwindow

import com.aidimag.intellij.actions.runOnBackground
import com.aidimag.intellij.core.AidimagNotifications
import com.aidimag.intellij.core.AidimagStateService
import com.aidimag.intellij.core.DimRunner
import com.aidimag.intellij.dashboard.AidimagDashboardService
import com.aidimag.intellij.settings.AidimagSettingsState
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.*
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ui.CollectionListModel
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.JBColor
import com.intellij.ui.JBSplitter
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.*
import java.awt.event.*
import java.net.HttpURLConnection
import java.net.URL
import javax.swing.*
import javax.swing.border.TitledBorder
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

/**
 * Native "Memories" tool window panel.
 *
 * Layout:
 *   ┌─ toolbar ─────────────────────────────────────────────┐
 *   │ [⟳ Refresh] [+ Add] [✓ Verify All] [⛏ Mine]          │
 *   ├─ filter bar ──────────────────────────────────────────┤
 *   │ Kind: [ALL▼]  Status: [ALL▼]  🔍 [search…]           │
 *   ├─ list (35%) ──────────┬─ detail (65%) ────────────────┤
 *   │ ✓ 📌 [DECISION] …     │  Claim ──────────────────────  │
 *   │ ~ [STALE] …           │  …full claim text…             │
 *   │ ? [UNVERIFIED] …      │  Kind / Status / Confidence    │
 *   │                       │  Evidence list                 │
 *   │                       │  [Pin] [Verify] [Refute]       │
 *   ├───────────────────────┴────────────────────────────────┤
 *   │ status bar: N verified · M stale · K unverified · P 📌 │
 *   └────────────────────────────────────────────────────────┘
 */
class MemoryExplorerPanel(private val project: Project) : JPanel(BorderLayout()), Disposable {

  // ── model ──────────────────────────────────────────────────────────────────
  private var allMemories: List<MemoryNode> = emptyList()
  private var summaryLine: String = ""

  // ── filter state ───────────────────────────────────────────────────────────
  private var kindFilter   = "ALL"
  private var statusFilter = "ALL"
  private var searchQuery  = ""

  // ── list ───────────────────────────────────────────────────────────────────
  private val listModel  = CollectionListModel<MemoryNode>()
  private val memoryList = JBList(listModel)

  // ── detail area components ─────────────────────────────────────────────────
  private val detailCards   = JPanel(CardLayout())
  private val claimArea     = JTextArea(5, 30).apply {
    lineWrap = true; wrapStyleWord = true; isEditable = false
    background = UIUtil.getPanelBackground()
    border = JBUI.Borders.empty(4)
    font  = UIUtil.getLabelFont()
  }
  private val kindLbl       = JLabel()
  private val statusLbl     = JLabel()
  private val confBar       = JProgressBar(0, 100).apply { isStringPainted = true; preferredSize = Dimension(110, 14) }
  private val pinnedLbl     = JLabel()
  private val idLbl         = JLabel().apply { font = Font(Font.MONOSPACED, Font.PLAIN, 11) }
  private val ticketLbl     = JLabel()
  private val scopeLbl      = JLabel()
  private val createdLbl    = JLabel()
  private val evidenceArea  = JTextArea(4, 30).apply {
    isEditable = false; lineWrap = true; wrapStyleWord = true
    background = UIUtil.getPanelBackground(); border = JBUI.Borders.empty(4)
    font = UIUtil.getFont(UIUtil.FontSize.SMALL, UIUtil.getLabelFont())
  }
  private val pinBtn      = JButton("📌 Pin")
  private val verifyBtn   = JButton("✓ Verify")
  private val refuteBtn   = JButton("✗ Refute")

  // ── status bar ─────────────────────────────────────────────────────────────
  private val statusLabel = JBLabel("").apply { border = JBUI.Borders.empty(2, 8) }

  // ── loading ────────────────────────────────────────────────────────────────
  private val centerCards = JPanel(CardLayout())
  private val loadingLbl  = JBLabel("Loading memories…", SwingConstants.CENTER).apply {
    foreground = UIUtil.getLabelDisabledForeground()
  }
  @Volatile private var loading = false

  // ── init ───────────────────────────────────────────────────────────────────
  init {
    build()
    loadDataAsync()
  }

  // ── layout ─────────────────────────────────────────────────────────────────

  private fun build() {
    // toolbar
    val group = DefaultActionGroup().apply {
      add(RefreshAction())
      add(AddAction())
      addSeparator()
      add(VerifyAllAction())
      add(MineAction())
    }
    val toolbar = ActionManager.getInstance()
      .createActionToolbar("AidimagMemories", group, true)
    toolbar.targetComponent = this

    // filter bar
    val kindCombo   = JComboBox(arrayOf("ALL", "DECISION", "CONVENTION", "GOTCHA",
      "FAILED_APPROACH", "INVARIANT", "ARCHITECTURE", "TODO_CONTEXT", "GUARDRAIL", "SKILL"))
    val statusCombo = JComboBox(arrayOf("ALL", "VERIFIED", "UNVERIFIED", "STALE", "REFUTED"))
    val searchField = JTextField(14).apply {
      putClientProperty("JTextField.placeholderText", "Search…")
    }
    kindCombo.addActionListener   { kindFilter   = kindCombo.selectedItem as String;   applyFilters() }
    statusCombo.addActionListener { statusFilter = statusCombo.selectedItem as String; applyFilters() }
    searchField.document.addDocumentListener(object : DocumentListener {
      override fun insertUpdate(e: DocumentEvent)  { searchQuery = searchField.text; applyFilters() }
      override fun removeUpdate(e: DocumentEvent)  { searchQuery = searchField.text; applyFilters() }
      override fun changedUpdate(e: DocumentEvent) { searchQuery = searchField.text; applyFilters() }
    })
    val filterBar = JPanel(FlowLayout(FlowLayout.LEFT, 4, 2)).apply {
      add(JBLabel("Kind:")); add(kindCombo)
      add(JBLabel("Status:")); add(statusCombo)
      add(JBLabel("🔍")); add(searchField)
    }

    // north
    val north = JPanel(BorderLayout()).apply {
      add(toolbar.component, BorderLayout.NORTH)
      add(filterBar, BorderLayout.SOUTH)
    }

    // list
    memoryList.cellRenderer = MemoryNodeRenderer()
    memoryList.selectionMode = ListSelectionModel.SINGLE_SELECTION
    memoryList.addListSelectionListener { e ->
      if (!e.valueIsAdjusting) showDetail(memoryList.selectedValue)
    }
    memoryList.addMouseListener(object : MouseAdapter() {
      override fun mousePressed(e: MouseEvent)  { if (e.isPopupTrigger) showCtxMenu(e) }
      override fun mouseReleased(e: MouseEvent) { if (e.isPopupTrigger) showCtxMenu(e) }
    })

    // detail
    buildDetailPanel()

    // splitter
    val splitter = JBSplitter(false, 0.35f).apply {
      firstComponent  = JBScrollPane(memoryList)
      secondComponent = detailPanel()
    }

    // center cards
    centerCards.add(splitter, "CONTENT")
    centerCards.add(loadingLbl, "LOADING")

    // south
    val south = JPanel(BorderLayout()).apply {
      border = JBUI.Borders.customLine(UIUtil.getSeparatorColor(), 1, 0, 0, 0)
      add(statusLabel, BorderLayout.WEST)
    }

    add(north, BorderLayout.NORTH)
    add(centerCards, BorderLayout.CENTER)
    add(south, BorderLayout.SOUTH)
  }

  private fun buildDetailPanel() {
    // EMPTY card
    val empty = JBLabel("Select a memory to view details", SwingConstants.CENTER).apply {
      foreground = UIUtil.getLabelDisabledForeground()
    }

    // DETAIL card content
    val metaPanel = FormBuilder.createFormBuilder()
      .addLabeledComponent(dimLbl("Kind:"),       kindLbl,     1, false)
      .addLabeledComponent(dimLbl("Status:"),     statusLbl,   1, false)
      .addLabeledComponent(dimLbl("Confidence:"), confBar,     1, false)
      .addLabeledComponent(dimLbl("Pinned:"),     pinnedLbl,   1, false)
      .addLabeledComponent(dimLbl("ID:"),         idLbl,       1, false)
      .addLabeledComponent(dimLbl("Ticket:"),     ticketLbl,   1, false)
      .addLabeledComponent(dimLbl("Scope:"),      scopeLbl,    1, false)
      .addLabeledComponent(dimLbl("Created:"),    createdLbl,  1, false)
      .panel
      .apply { border = JBUI.Borders.empty(4, 4, 0, 4) }

    val btnPanel = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0)).apply {
      add(pinBtn); add(verifyBtn); add(refuteBtn)
    }
    pinBtn.addActionListener    { togglePin() }
    verifyBtn.addActionListener { verifySelected() }
    refuteBtn.addActionListener { refuteSelected() }

    val content = JPanel().apply {
      layout = BoxLayout(this, BoxLayout.Y_AXIS)
      border = JBUI.Borders.empty(8)
      add(titled("Claim",     JBScrollPane(claimArea)))
      add(Box.createVerticalStrut(8))
      add(metaPanel)
      add(Box.createVerticalStrut(8))
      add(titled("Evidence",  JBScrollPane(evidenceArea)))
      add(Box.createVerticalStrut(8))
      add(btnPanel)
    }

    detailCards.add(empty, "EMPTY")
    detailCards.add(JBScrollPane(content), "DETAIL")
    showCard(detailCards, "EMPTY")
  }

  private fun detailPanel(): JPanel = JPanel(BorderLayout()).apply {
    add(detailCards, BorderLayout.CENTER)
  }

  // ── data loading ───────────────────────────────────────────────────────────

  fun loadDataAsync() {
    if (loading) return
    loading = true
    showCard(centerCards, "LOADING")
    ApplicationManager.getApplication().executeOnPooledThread {
      try {
        val (nodes, summary) = loadMemories()
        ApplicationManager.getApplication().invokeLater {
          allMemories = nodes
          summaryLine = summary
          applyFilters()
          showCard(centerCards, "CONTENT")
          loading = false
        }
      } catch (t: Throwable) {
        ApplicationManager.getApplication().invokeLater {
          statusLabel.text = "Error: ${t.message}"
          showCard(centerCards, "CONTENT")
          loading = false
        }
      }
    }
  }

  private fun loadMemories(): Pair<List<MemoryNode>, String> {
    val dash = AidimagDashboardService.getInstance(project)

    // try REST API (rich data including evidence)
    // Each project has its own dashboard on a unique port, no filtering needed
    if (dash.isServerAlive() || runCatching { dash.ensureServer() }.isSuccess) {
      return try {
        // Get the project-specific port
        val port = dash.ensureUiServerAndLoad()
        val json = fetchJson("http://127.0.0.1:$port/api/state")
        val obj  = JsonParser.parseString(json).asJsonObject
        
        Pair(
          obj.getAsJsonArray("memories").map { parseNode(it.asJsonObject) },
          buildSummary(obj.getAsJsonObject("summary")),
        )
      } catch (_: Exception) { loadFromCli() }
    }
    return loadFromCli()
  }

  private fun loadFromCli(): Pair<List<MemoryNode>, String> {
    val log = DimRunner.run(project, listOf("log", "-n", "500")).stdout
    val nodes = parseDimLog(log)
    val summary = runCatching {
      val r = DimRunner.run(project, listOf("status")).stdout
      val m = Regex("VERIFIED=(\\d+)\\s+UNVERIFIED=(\\d+)\\s+STALE=(\\d+)").find(r)
      if (m != null) {
        val (v, u, s) = m.destructured
        val p = Regex("pinned:\\s*(\\d+)").find(r)?.groupValues?.get(1) ?: "0"
        "$v verified · $s stale · $u unverified · $p pinned 📌"
      } else ""
    }.getOrDefault("")
    return Pair(nodes, summary)
  }

  private fun parseNode(o: JsonObject): MemoryNode {
    val scope     = o.getAsJsonObject("scope")
    val paths     = scope?.getAsJsonArray("paths")?.map { it.asString }   ?: emptyList()
    val symbols   = scope?.getAsJsonArray("symbols")?.map { it.asString } ?: emptyList()
    val grounding = o.getAsJsonArray("grounding")?.map {
      val ev = it.asJsonObject
      EvidenceNode(
        type    = ev.get("type")?.asString    ?: "UNKNOWN",
        result  = ev.get("result")?.asString  ?: "UNKNOWN",
        payload = ev.get("payload")?.asString ?: "",
      )
    } ?: emptyList()
    val id = o.get("id").asString
    return MemoryNode(
      id         = id,
      shortId    = id.take(8),
      kind       = o.get("kind").asString,
      status     = o.get("status").asString,
      confidence = o.get("confidence")?.takeIf { !it.isJsonNull }?.asDouble ?: 0.5,
      claim      = o.get("claim").asString,
      pinned     = o.get("pinned")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
      paths      = paths,
      symbols    = symbols,
      evidence   = grounding,
      ticketRef  = o.get("ticket_ref")?.takeIf { !it.isJsonNull }?.asString,
      createdAt  = o.get("created_at")?.takeIf { !it.isJsonNull }?.asString?.take(10),
      guardrailLevel = o.get("guardrail_level")?.takeIf { !it.isJsonNull }?.asString
        ?: o.get("guardrailLevel")?.takeIf { !it.isJsonNull }?.asString,
    )
  }

  private fun buildSummary(s: JsonObject?): String {
    if (s == null) return ""
    val v = s.get("verified")?.asInt   ?: 0
    val u = s.get("unverified")?.asInt ?: 0
    val st = s.get("stale")?.asInt     ?: 0
    val p  = s.get("pinned")?.asInt    ?: 0
    return "$v verified · $st stale · $u unverified · $p pinned 📌"
  }

  /** Parses the two-line `dim log` format (fallback when API unavailable). */
  private fun parseDimLog(stdout: String): List<MemoryNode> {
    val claimRe = Regex("""^[✓✗~?]\s+(?:📌\s+)?\[([A-Z_]+)(?:[^\]]*)]\s+(.+)$""")
    val metaRe  = Regex("""^\s+id=([0-9a-f]{8})\s+status=(\w+)\s+conf=([\d.]+)(\s+pinned)?""")
    val items   = mutableListOf<MemoryNode>()
    val lines   = stdout.lines()
    var i = 0
    while (i < lines.size - 1) {
      val cm = claimRe.find(lines[i])
      val mm = cm?.let { metaRe.find(lines[i + 1]) }
      if (cm != null && mm != null) {
        items += MemoryNode(
          id         = mm.groupValues[1],
          shortId    = mm.groupValues[1],
          kind       = cm.groupValues[1],
          status     = mm.groupValues[2],
          confidence = mm.groupValues[3].toDoubleOrNull() ?: 0.5,
          claim      = cm.groupValues[2],
          pinned     = mm.groupValues[4].isNotBlank(),
          paths      = emptyList(),
          symbols    = emptyList(),
          evidence   = emptyList(),
          ticketRef  = null,
          createdAt  = null,
        )
        i += 2
      } else i++
    }
    return items
  }

  // ── filtering ──────────────────────────────────────────────────────────────

  private fun applyFilters() {
    val filtered = allMemories.filter { m ->
      (kindFilter   == "ALL" || m.kind   == kindFilter) &&
      (statusFilter == "ALL" || m.status == statusFilter) &&
      (searchQuery.isBlank() || m.claim.contains(searchQuery, ignoreCase = true)
        || m.kind.contains(searchQuery, ignoreCase = true))
    }
    listModel.replaceAll(filtered)
    statusLabel.text = summaryLine.ifBlank { "${filtered.size} / ${allMemories.size} memories" }
  }

  // ── detail view ────────────────────────────────────────────────────────────

  private fun showDetail(node: MemoryNode?) {
    if (node == null) { showCard(detailCards, "EMPTY"); return }

    claimArea.text = node.claim; claimArea.caretPosition = 0
    val levelSuffix = node.guardrailLevel?.let { " · ${guardrailIcon(it)} ${it.uppercase()}" } ?: ""
    kindLbl.text = node.kind + levelSuffix; kindLbl.foreground = kindColor(node.kind)

    val (sTxt, sClr) = statusStyle(node.status)
    statusLbl.text = sTxt; statusLbl.foreground = sClr

    val pct = (node.confidence * 100).toInt()
    confBar.value  = pct; confBar.string = "$pct%"
    confBar.foreground = when { pct >= 75 -> verifiedClr; pct >= 40 -> staleClr; else -> refutedClr }

    pinnedLbl.text = if (node.pinned) "📌 Yes — exempt from time decay" else "No"
    pinnedLbl.foreground = if (node.pinned) JBColor(Color(0, 100, 200), Color(80, 160, 255))
                           else UIUtil.getLabelForeground()

    idLbl.text      = node.shortId
    ticketLbl.text  = node.ticketRef ?: "—"
    val scope = (node.paths + node.symbols).joinToString(", ").ifBlank { "—" }
    scopeLbl.text   = if (scope.length > 60) scope.take(60) + "…" else scope
    createdLbl.text = node.createdAt ?: "—"

    evidenceArea.text = if (node.evidence.isEmpty()) "No evidence attached"
    else node.evidence.joinToString("\n") { e -> "${e.resultIcon} ${e.type}  ${e.payload.take(80)}" }
    evidenceArea.caretPosition = 0

    pinBtn.text = if (node.pinned) "📌 Unpin" else "📌 Pin"

    showCard(detailCards, "DETAIL")
  }

  // ── memory actions ─────────────────────────────────────────────────────────

  private fun togglePin() {
    val n = memoryList.selectedValue ?: return
    bg("Pin") {
      val verb = if (n.pinned) "unpin" else "pin"
      val r = DimRunner.run(project, listOf(verb, n.shortId))
      if (r.exitCode != 0) error(r.stdout.trim().ifBlank { "$verb failed" })
      AidimagNotifications.info(project,
        if (n.pinned) "Memory unpinned — normal decay resumes."
        else "Memory pinned 📌 — exempt from time decay.")
      AidimagStateService.getInstance(project).refreshMemoryStatus()
      loadDataAsync()
    }
  }

  private fun editSelected() {
    val n = memoryList.selectedValue ?: return
    ApplicationManager.getApplication().invokeLater {
      val dlg = EditMemoryDialog(project, n)
      if (dlg.showAndGet()) {
        bg("Edit Memory") {
          val args = mutableListOf<String>()
          
          // Update claim if changed
          if (dlg.claim != n.claim) {
            args.addAll(listOf("update", n.shortId, "-c", dlg.claim))
            val r = DimRunner.run(project, args)
            if (r.exitCode != 0) error(r.stdout.trim().ifBlank { "update claim failed" })
            args.clear()
          }
          
          // Update kind if changed
          if (dlg.kind != n.kind) {
            args.addAll(listOf("update", n.shortId, "-k", dlg.kind))
            if (dlg.kind == "GUARDRAIL" && dlg.guardrailLevel != null) {
              args.addAll(listOf("-g", dlg.guardrailLevel!!))
            }
            val r = DimRunner.run(project, args)
            if (r.exitCode != 0) error(r.stdout.trim().ifBlank { "update kind failed" })
            args.clear()
          }
          
          // Update guardrail level if changed
          if (dlg.kind == "GUARDRAIL" && dlg.guardrailLevel != n.guardrailLevel) {
            args.addAll(listOf("update", n.shortId, "-g", dlg.guardrailLevel!!))
            val r = DimRunner.run(project, args)
            if (r.exitCode != 0) error(r.stdout.trim().ifBlank { "update guardrail level failed" })
            args.clear()
          }
          
          // Add new evidence
          dlg.newEvidence.forEach { ev ->
            args.addAll(listOf("update", n.shortId, "-e", "${ev.type}:${ev.payload}"))
            val r = DimRunner.run(project, args)
            if (r.exitCode != 0) error(r.stdout.trim().ifBlank { "add evidence failed" })
            args.clear()
          }
          
          // Remove evidence - we can't remove by index, so skip this for now
          // Evidence removal would need evidence IDs which aren't available in the current structure
          
          AidimagNotifications.info(project, "Memory updated.")
          AidimagStateService.getInstance(project).refreshMemoryStatus()
          loadDataAsync()
        }
      }
    }
  }

  private fun verifySelected() {
    val n = memoryList.selectedValue ?: return
    bg("Verify Memory") {
      val r = DimRunner.run(project, listOf("verify", "-i", n.shortId))
      if (r.exitCode != 0) error(r.stdout.trim().ifBlank { "verify failed" })
      val status = when {
        r.stdout.contains("VERIFIED") -> "VERIFIED"
        r.stdout.contains("STALE") -> "STALE"
        else -> "UNKNOWN"
      }
      AidimagNotifications.info(project, "Memory verified: $status")
      AidimagStateService.getInstance(project).refreshMemoryStatus()
      loadDataAsync()
    }
  }

  private fun refuteSelected() {
    val n = memoryList.selectedValue ?: return
    val ok = Messages.showYesNoDialog(
      project,
      "Mark this memory as REFUTED?\n\n\"${n.claim.take(120)}\"",
      "Refute Memory",
      Messages.getQuestionIcon(),
    )
    if (ok != Messages.YES) return
    bg("Refute") {
      val r = DimRunner.run(project, listOf("refute", n.shortId))
      if (r.exitCode != 0) error(r.stdout.trim().ifBlank { "refute failed" })
      AidimagNotifications.info(project, "Memory refuted.")
      AidimagStateService.getInstance(project).refreshMemoryStatus()
      loadDataAsync()
    }
  }

  private fun showCtxMenu(e: MouseEvent) {
    val idx = memoryList.locationToIndex(e.point)
    if (idx >= 0) memoryList.selectedIndex = idx
    val n = memoryList.selectedValue ?: return
    JPopupMenu().apply {
      add(JMenuItem(if (n.pinned) "📌 Unpin" else "📌 Pin").also { it.addActionListener { togglePin() } })
      add(JMenuItem("✏️ Edit").also { it.addActionListener { editSelected() } })
      add(JMenuItem("✓ Verify This").also { it.addActionListener { verifySelected() } })
      add(JMenuItem("✓ Verify All").also { it.addActionListener { doVerifyAll() } })
      addSeparator()
      add(JMenuItem("✗ Refute").also { it.addActionListener { refuteSelected() } })
      show(memoryList, e.x, e.y)
    }
  }

  // ── toolbar action classes ─────────────────────────────────────────────────

  private inner class RefreshAction : AnAction("Refresh", "Reload memories", AllIcons.Actions.Refresh) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) { loadDataAsync() }
  }

  private inner class AddAction : AnAction("Add Memory", "Create a new memory", AllIcons.General.Add) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
      ApplicationManager.getApplication().invokeLater {
        val dlg = AddMemoryDialog(project)
        if (dlg.showAndGet()) {
          bg("Add Memory") {
            val args = buildList {
              add("remember"); add(dlg.claim)
              add("-k"); add(dlg.kind)
              dlg.guardrailLevel?.let { add("-g"); add(it) }
              if (dlg.paths.isNotEmpty()) {
                add("-p")
                addAll(dlg.paths)
              }
              if (dlg.symbols.isNotEmpty()) {
                add("-s")
                addAll(dlg.symbols)
              }
              dlg.evidence.forEach { ev ->
                add("-e")
                add("${ev.type}:${ev.payload}")
              }
              if (dlg.pinned) add("--pin")
            }
            val r = DimRunner.run(project, args)
            if (r.exitCode != 0) error(r.stdout.trim().ifBlank { "remember failed" })
            AidimagNotifications.info(project, "Memory saved.")
            AidimagStateService.getInstance(project).refreshMemoryStatus()
            loadDataAsync()
          }
        }
      }
    }
  }

  private inner class VerifyAllAction : AnAction("Verify All", "Run dim verify", AllIcons.Actions.RunAll) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) { doVerifyAll() }
  }

  private inner class MineAction : AnAction("Mine Commits", "Mine git history for memories", AllIcons.Vcs.History) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
      bg("Mine Commits") {
        val r = DimRunner.run(project, listOf("mine"), timeoutSeconds = 300)
        AidimagNotifications.info(project, r.stdout.trim().ifBlank { "Mine complete." })
        AidimagStateService.getInstance(project).refreshMemoryStatus()
        loadDataAsync()
      }
    }
  }

  private fun doVerifyAll() {
    bg("Verify") {
      val r = DimRunner.run(project, listOf("verify"), timeoutSeconds = 300)
      if (r.exitCode != 0) AidimagNotifications.warn(project, "Verify: ${r.stdout.trim()}")
      else                  AidimagNotifications.info(project, "Verify complete: ${r.stdout.trim()}")
      AidimagStateService.getInstance(project).refreshMemoryStatus()
      loadDataAsync()
    }
  }

  // ── renderer ───────────────────────────────────────────────────────────────

  private inner class MemoryNodeRenderer : ColoredListCellRenderer<MemoryNode>() {
    override fun customizeCellRenderer(
      list: JList<out MemoryNode>, value: MemoryNode,
      index: Int, selected: Boolean, hasFocus: Boolean,
    ) {
      val (sTxt, sClr) = statusStyle(value.status)
      val sAttr = SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, sClr)
      append("${value.statusIcon} ", sAttr)
      if (value.pinned) append("📌 ", SimpleTextAttributes.REGULAR_ATTRIBUTES)
      val kindLabel = value.guardrailLevel?.let { "${value.kind} ${guardrailIcon(it)}" } ?: value.kind
      append("[$kindLabel] ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, kindColor(value.kind)))
      append(value.shortClaim, SimpleTextAttributes.REGULAR_ATTRIBUTES)
      val pct = (value.confidence * 100).toInt()
      append("  $pct%", SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, UIUtil.getLabelDisabledForeground()))
      toolTipText = "${value.status} $pct% — ${value.claim}"
      ipad = JBUI.insets(3, 8)
    }
  }

  // ── utilities ──────────────────────────────────────────────────────────────

  private fun bg(name: String, block: () -> Unit) {
    runOnBackground(project, name, block)
  }

  private fun fetchJson(url: String): String {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 3_000; conn.readTimeout = 10_000
    return conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
  }

  private fun titled(title: String, inner: JComponent): JPanel = JPanel(BorderLayout()).apply {
    border = JBUI.Borders.customLine(UIUtil.getSeparatorColor())
    val header = JBLabel(" $title ").apply {
      foreground = UIUtil.getLabelDisabledForeground()
      font = UIUtil.getFont(UIUtil.FontSize.SMALL, UIUtil.getLabelFont())
      border = JBUI.Borders.empty(2, 4)
      background = UIUtil.getPanelBackground()
      isOpaque = true
    }
    val wrap = JPanel(BorderLayout()).apply { add(header, BorderLayout.NORTH); add(inner, BorderLayout.CENTER) }
    add(wrap, BorderLayout.CENTER)
  }

  private fun dimLbl(text: String) = JBLabel(text).apply {
    foreground = UIUtil.getLabelDisabledForeground()
  }

  private fun showCard(panel: JPanel, card: String) {
    (panel.layout as? CardLayout)?.show(panel, card)
  }

  override fun dispose() { /* no resources to clean up */ }

  // ── static helpers ─────────────────────────────────────────────────────────

  companion object {
    private val verifiedClr = JBColor(Color(34, 139, 34), Color(98, 198, 98))
    private val staleClr    = JBColor(Color(190, 90,  0), Color(240, 140, 60))
    private val refutedClr  = JBColor(Color(160, 0,   0), Color(220, 80,  80))

    fun statusStyle(status: String): Pair<String, Color> = when (status) {
      "VERIFIED"   -> "● VERIFIED"   to verifiedClr
      "STALE"      -> "● STALE"      to staleClr
      "REFUTED"    -> "● REFUTED"    to refutedClr
      else         -> "● UNVERIFIED" to JBColor.GRAY
    }

    fun kindColor(kind: String): Color = when (kind) {
      "DECISION"        -> JBColor(Color(0,   80,  180), Color(80,  150, 255))
      "CONVENTION"      -> JBColor(Color(0,   120, 100), Color(50,  190, 160))
      "GOTCHA"          -> JBColor(Color(170, 80,  0  ), Color(230, 150, 50 ))
      "FAILED_APPROACH" -> JBColor(Color(160, 0,   0  ), Color(220, 80,  80 ))
      "INVARIANT"       -> JBColor(Color(100, 0,   160), Color(180, 100, 240))
      "ARCHITECTURE"    -> JBColor(Color(0,   60,  140), Color(60,  120, 220))
      "TODO_CONTEXT"    -> JBColor(Color(80,  80,  80 ), Color(160, 160, 160))
      "GUARDRAIL"       -> JBColor(Color(200, 30,  30 ), Color(240, 90,  90 ))
      "SKILL"           -> JBColor(Color(0,   110, 180), Color(60,  170, 230))
      else              -> UIUtil.getLabelForeground()
    }

    fun guardrailIcon(level: String): String = when (level) {
      "never"     -> "🚫"
      "always"    -> "✅"
      "ask-first" -> "🤚"
      else        -> "⚠"
    }
  }
}

