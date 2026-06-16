package com.aidimag.intellij.core

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project

object AidimagNotifications {
  private const val GROUP_ID = "aidimag"

  fun info(project: Project, message: String) = notify(project, message, NotificationType.INFORMATION)

  fun warn(project: Project, message: String) = notify(project, message, NotificationType.WARNING)

  fun error(project: Project, message: String) = notify(project, message, NotificationType.ERROR)

  fun infoWithAction(project: Project, message: String, actionTitle: String, action: () -> Unit) =
    notify(project, message, NotificationType.INFORMATION, actionTitle, action)

  fun warnWithAction(project: Project, message: String, actionTitle: String, action: () -> Unit) =
    notify(project, message, NotificationType.WARNING, actionTitle, action)

  fun errorWithAction(project: Project, message: String, actionTitle: String, action: () -> Unit) =
    notify(project, message, NotificationType.ERROR, actionTitle, action)

  private fun notify(
    project: Project,
    message: String,
    type: NotificationType,
    actionTitle: String? = null,
    action: (() -> Unit)? = null,
  ) {
    val notification = NotificationGroupManager.getInstance()
      .getNotificationGroup(GROUP_ID)
      .createNotification(message, type)
    if (actionTitle != null && action != null) {
      notification.addAction(NotificationAction.createSimpleExpiring(actionTitle) { action() })
    }
    notification.notify(project)
  }
}

