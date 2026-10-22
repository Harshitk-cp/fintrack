package expo.modules.smscollector

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.work.WorkInfo
import androidx.work.WorkManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SmsCollectorModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("SmsCollector")

    Function("configure") { serverUrl: String, token: String ->
      CollectorStore(context).configure(serverUrl, token)
    }

    Function("disable") {
      CollectorStore(context).disable()
    }

    AsyncFunction("getStatus") {
      val store = CollectorStore(context)
      val pending = WorkManager.getInstance(context)
        .getWorkInfosByTag(UploadWorker.TAG).get()
        .count { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING || it.state == WorkInfo.State.BLOCKED }
      mapOf(
        "enabled" to store.enabled,
        "hasPermission" to (ContextCompat.checkSelfPermission(context, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED),
        "pending" to pending,
        "forwardedCount" to store.forwardedCount,
        "lastForwardedAt" to store.lastForwardedAt.takeIf { it > 0 },
        "lastSeenAt" to store.lastSeenAt.takeIf { it > 0 },
        "lastError" to store.lastError,
        "lastErrorAt" to store.lastErrorAt.takeIf { it > 0 },
      )
    }
  }
}
