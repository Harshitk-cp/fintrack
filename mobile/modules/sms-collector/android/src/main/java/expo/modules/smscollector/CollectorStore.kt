package expo.modules.smscollector

import android.content.Context
import android.content.SharedPreferences

/**
 * Server URL, device token and sync health. Stored in app-private
 * SharedPreferences, which only this app (and root) can read.
 */
class CollectorStore(context: Context) {
  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences("fintrack_sms_collector", Context.MODE_PRIVATE)

  val serverUrl: String? get() = prefs.getString("server_url", null)
  val token: String? get() = prefs.getString("token", null)
  val enabled: Boolean get() = prefs.getBoolean("enabled", false) && serverUrl != null && token != null

  fun configure(serverUrl: String, token: String) {
    prefs.edit()
      .putString("server_url", serverUrl.trimEnd('/'))
      .putString("token", token)
      .putBoolean("enabled", true)
      .apply()
  }

  fun disable() {
    prefs.edit().remove("token").putBoolean("enabled", false).apply()
  }

  fun recordSuccess() {
    prefs.edit()
      .putLong("forwarded_count", prefs.getLong("forwarded_count", 0) + 1)
      .putLong("last_forwarded_at", System.currentTimeMillis())
      .remove("last_error")
      .apply()
  }

  fun recordError(message: String) {
    prefs.edit()
      .putString("last_error", message)
      .putLong("last_error_at", System.currentTimeMillis())
      .apply()
  }

  fun recordSeen() {
    prefs.edit().putLong("last_seen_at", System.currentTimeMillis()).apply()
  }

  val forwardedCount: Long get() = prefs.getLong("forwarded_count", 0)
  val lastForwardedAt: Long get() = prefs.getLong("last_forwarded_at", 0)
  val lastSeenAt: Long get() = prefs.getLong("last_seen_at", 0)
  val lastError: String? get() = prefs.getString("last_error", null)
  val lastErrorAt: Long get() = prefs.getLong("last_error_at", 0)
}
