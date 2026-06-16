package com.aidimag.intellij.core

import com.aidimag.intellij.settings.AidimagSettingsState
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.WindowManager
import com.intellij.util.concurrency.AppExecutorUtil
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Project-level state for the status bar widgets + auto-sync timer.
 * Mirrors refreshStatusBar / refreshSyncStatus / scheduleAutoSync from the
 * VSCode extension.
 */
@Service(Service.Level.PROJECT)
class AidimagStateService(private val project: Project) : Disposable {

  enum class SyncClick { DASHBOARD, LOGIN, SYNC }

  private data class LastSync(val at: Date, val summary: String, val ok: Boolean)

  // ---- memory widget state (🧠) ----
  @Volatile var memoryText: String = "🧠 aidimag"
    private set
  @Volatile var memoryTooltip: String = "aidimag dashboard"
    private set
  @Volatile var hasStale: Boolean = false
    private set

  // ---- sync widget state (☁) ----
  @Volatile var syncVisible: Boolean = false
    private set
  @Volatile var syncText: String = ""
    private set
  @Volatile var syncTooltip: String = ""
    private set
  @Volatile var syncClickAction: SyncClick = SyncClick.SYNC
    private set

  @Volatile private var lastSync: LastSync? = null
  private var autoSyncFuture: ScheduledFuture<*>? = null
  private var initialSyncFuture: ScheduledFuture<*>? = null
  private var knowledgeSyncFuture: ScheduledFuture<*>? = null
  @Volatile private var knowledgeSyncing: Boolean = false

  /** Refresh both widgets on a pooled thread. Safe to call from any thread. */
  fun refreshAllAsync() {
    ApplicationManager.getApplication().executeOnPooledThread {
      refreshMemoryStatus()
      refreshSyncStatus()
    }
  }

  /** Runs `dim status` and updates the 🧠 widget. Call from a background thread. */
  fun refreshMemoryStatus() {
    try {
      val result = DimRunner.run(project, listOf("status"))
      val m = Regex("VERIFIED=(\\d+)\\s+UNVERIFIED=(\\d+)\\s+STALE=(\\d+)").find(result.stdout)
      if (m != null) {
        val (v, u, s) = m.destructured
        val pinned = Regex("pinned:\\s*(\\d+)").find(result.stdout)?.groupValues?.get(1)
        memoryText = "🧠 $v✓ $u? $s~"
        memoryTooltip = "aidimag: $v verified, $u unverified, $s stale" +
          (pinned?.let { ", $it pinned 📌" } ?: "") +
          " — click for dashboard"
        hasStale = s.toInt() > 0
      }
    } catch (_: Exception) {
      memoryText = "🧠 aidimag"
      memoryTooltip = "aidimag dashboard (dim CLI not reachable)"
      hasStale = false
    }
    updateWidgets()
  }

  /** Runs `dim cloud status` and updates the ☁ widget. Call from a background thread. */
  fun refreshSyncStatus() {
    try {
      val out = DimRunner.run(project, listOf("cloud", "status")).stdout
      if (Regex("Not cloud-linked", RegexOption.IGNORE_CASE).containsMatchIn(out)) {
        syncVisible = true
        syncText = "☁ not linked"
        syncTooltip =
          "aidimag: no team sync configured — click to open the dashboard (☁ Cloud) and link a server"
        syncClickAction = SyncClick.DASHBOARD
      } else {
        val brain = Regex("brain:\\s*(\\S+)").find(out)?.groupValues?.get(1) ?: "?"
        val tokenMissing = Regex("token:\\s*MISSING").containsMatchIn(out)
        val ls = lastSync
        val lastTxt = if (ls != null) {
          "Last sync ${SimpleDateFormat("HH:mm:ss").format(ls.at)}: ${ls.summary}"
        } else {
          "Not synced this session"
        }
        when {
          tokenMissing -> {
            syncText = "☁ $brain ⚠"
            syncTooltip =
              "aidimag: linked to brain '$brain' but NO TOKEN stored — click to log this device in (browser approval). $lastTxt"
            syncClickAction = SyncClick.LOGIN
          }
          ls != null && !ls.ok -> {
            syncText = "☁ $brain ✗"
            syncTooltip = "aidimag: last sync FAILED — click to retry. $lastTxt"
            syncClickAction = SyncClick.SYNC
          }
          else -> {
            syncText = if (ls != null) "☁ $brain ✓" else "☁ $brain"
            syncTooltip = "aidimag: team brain '$brain' — click to sync now. $lastTxt"
            syncClickAction = SyncClick.SYNC
          }
        }
        syncVisible = true
      }
    } catch (_: Exception) {
      // dim CLI not reachable — the 🧠 widget already signals that
      syncVisible = false
    }
    updateWidgets()
  }

  /** Runs `dim sync`. Call from a background thread. */
  fun syncNow(silent: Boolean) {
    syncText = "☁ syncing…"
    syncVisible = true
    updateWidgets()
    try {
      val result = DimRunner.run(project, listOf("sync"))
      if (result.exitCode != 0) error(result.stdout.trim().ifBlank { "sync failed" })
      lastSync = LastSync(Date(), result.stdout.trim(), true)
      if (!silent) AidimagNotifications.info(project, "aidimag: ${result.stdout.trim()}")
      refreshMemoryStatus()
    } catch (t: Throwable) {
      lastSync = LastSync(Date(), t.message ?: "sync failed", false)
      // background failures stay quiet — the ☁ ✗ widget carries the signal
      if (!silent) AidimagNotifications.error(project, "aidimag sync: ${t.message}")
    }
    refreshSyncStatus()
  }

  /** Call from a background thread. */
  fun isCloudLinked(): Boolean = try {
    val out = DimRunner.run(project, listOf("cloud", "status")).stdout
    !Regex("Not cloud-linked", RegexOption.IGNORE_CASE).containsMatchIn(out) &&
      !Regex("token:\\s*MISSING").containsMatchIn(out)
  } catch (_: Exception) {
    false
  }

  /** (Re)schedules the periodic background sync based on settings. */
  @Synchronized
  fun scheduleAutoSync() {
    autoSyncFuture?.cancel(false)
    autoSyncFuture = null
    val minutes = AidimagSettingsState.getInstance().state.autoSyncMinutes
    if (minutes <= 0) return
    autoSyncFuture = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(
      {
        if (!project.isDisposed && isCloudLinked()) syncNow(silent = true)
      },
      minutes.toLong(),
      minutes.toLong(),
      TimeUnit.MINUTES,
    )
  }

  /** One-shot background sync ~5s after startup (if linked), like the VSCode extension. */
  @Synchronized
  fun scheduleInitialSync() {
    initialSyncFuture?.cancel(false)
    initialSyncFuture = AppExecutorUtil.getAppScheduledExecutorService().schedule(
      {
        val minutes = AidimagSettingsState.getInstance().state.autoSyncMinutes
        if (!project.isDisposed && minutes > 0 && isCloudLinked()) syncNow(silent = true)
      },
      5,
      TimeUnit.SECONDS,
    )
  }

  private fun updateWidgets() {
    ApplicationManager.getApplication().invokeLater {
      if (project.isDisposed) return@invokeLater
      val statusBar = WindowManager.getInstance().getStatusBar(project) ?: return@invokeLater
      statusBar.updateWidget("AidimagMemoryStatus")
      statusBar.updateWidget("AidimagSyncStatus")
    }
  }

  // ---- knowledge inbox ----

  /** Inbox folder (repo-relative) from .aidimag/config.json → knowledge.folder; default "knowledge". */
  fun knowledgeFolder(): String {
    val base = project.basePath ?: return "knowledge"
    return try {
      val json = File(base, ".aidimag/config.json").readText()
      // light-touch parse: pull "folder" from the knowledge block (default otherwise)
      val block = Regex("\"knowledge\"\\s*:\\s*\\{([\\s\\S]*?)\\}").find(json)?.groupValues?.get(1)
      val folder = block?.let { Regex("\"folder\"\\s*:\\s*\"([^\"]+)\"").find(it)?.groupValues?.get(1) }
      folder?.trim()?.ifBlank { null } ?: "knowledge"
    } catch (_: Exception) {
      "knowledge"
    }
  }

  /** Debounced trigger used by the inbox watcher when a doc is dropped. */
  @Synchronized
  fun scheduleKnowledgeSync() {
    knowledgeSyncFuture?.cancel(false)
    knowledgeSyncFuture = AppExecutorUtil.getAppScheduledExecutorService().schedule(
      { if (!project.isDisposed) syncKnowledge(manual = false) },
      1,
      TimeUnit.SECONDS,
    )
  }

  /**
   * Runs `dim knowledge sync`: summarizes dropped inbox docs into review proposals.
   * Call from a background thread. Best-effort — background failures stay quiet.
   */
  fun syncKnowledge(manual: Boolean) {
    if (knowledgeSyncing) return
    knowledgeSyncing = true
    try {
      val result = DimRunner.run(project, listOf("knowledge", "sync"))
      val processed = Regex("Processed (\\d+) doc").find(result.stdout)?.groupValues?.get(1)?.toIntOrNull() ?: 0
      when {
        processed > 0 -> {
          AidimagNotifications.info(
            project,
            "aidimag: summarized $processed knowledge doc(s) into the review queue — open the dashboard to review.",
          )
          refreshMemoryStatus()
        }
        manual -> AidimagNotifications.info(project, "aidimag: knowledge inbox is up to date.")
      }
    } catch (t: Throwable) {
      if (manual) AidimagNotifications.error(project, "aidimag knowledge sync: ${t.message}")
    } finally {
      knowledgeSyncing = false
    }
  }

  override fun dispose() {
    autoSyncFuture?.cancel(false)
    initialSyncFuture?.cancel(false)
    knowledgeSyncFuture?.cancel(false)
  }

  companion object {
    fun getInstance(project: Project): AidimagStateService = project.service()
  }
}

