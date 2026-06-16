package com.aidimag.intellij.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

@State(name = "AidimagSettings", storages = [Storage("aidimag.xml")])
@Service(Service.Level.APP)
class AidimagSettingsState : PersistentStateComponent<AidimagSettingsState.State> {
  data class State(
    var dimPath: String = "dim",
    var uiPort: Int = 4517,
    var autoSyncMinutes: Int = 10,
    var knowledgeWatch: Boolean = true,
  )

  private var state = State()

  override fun getState(): State = state

  override fun loadState(state: State) {
    this.state = state
  }

  companion object {
    fun getInstance(): AidimagSettingsState {
      return ApplicationManager.getApplication().getService(AidimagSettingsState::class.java)
    }
  }
}

