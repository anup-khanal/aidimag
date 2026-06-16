package com.aidimag.intellij.core

import com.aidimag.intellij.settings.AidimagSettingsState
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.openapi.project.Project

data class CommandResult(
  val exitCode: Int,
  val stdout: String,
)

object DimRunner {
  /**
   * Builds a command line for the dim CLI that inherits the user's *shell*
   * environment (ParentEnvironmentType.CONSOLE). This matters on macOS:
   * IDEs launched from Finder/Toolbox get a minimal PATH that does not
   * include npm-global bin dirs, so a plain ProcessBuilder("dim", ...)
   * fails with "Cannot run program dim".
   */
  fun commandLine(project: Project, args: List<String>): GeneralCommandLine {
    val root = project.basePath ?: error("Open a project folder with .aidimag first.")
    val dimPath = AidimagSettingsState.getInstance().state.dimPath.ifBlank { "dim" }
    return GeneralCommandLine(listOf(dimPath) + args)
      .withWorkDirectory(root)
      .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
      .withRedirectErrorStream(true)
  }

  fun run(project: Project, args: List<String>, timeoutSeconds: Long = 120): CommandResult {
    val cmd = commandLine(project, args)
    // CapturingProcessHandler reads stdout/stderr concurrently, so large
    // outputs cannot deadlock the pipe like waitFor()-then-read would.
    val output = CapturingProcessHandler(cmd).runProcess(timeoutSeconds.toInt() * 1000)
    if (output.isTimeout) {
      error("Command timed out: ${cmd.commandLineString}")
    }
    return CommandResult(output.exitCode, output.stdout)
  }
}
