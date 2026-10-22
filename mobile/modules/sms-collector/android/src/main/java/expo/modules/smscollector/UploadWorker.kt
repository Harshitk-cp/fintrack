package expo.modules.smscollector

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * POSTs one SMS to /v1/sms. WorkManager persists the job, waits for network,
 * and retries with backoff. Retries are safe: the server dedupes by content.
 */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

  override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
    val store = CollectorStore(applicationContext)
    val url = store.serverUrl
    val token = store.token
    if (url == null || token == null) return@withContext Result.failure()
    if (!isAllowedUrl(url)) {
      store.recordError("refusing non-HTTPS server URL")
      return@withContext Result.failure()
    }

    val body = inputData.getString(KEY_BODY) ?: return@withContext Result.failure()
    val payload = JSONObject()
      .put("body", body)
      .put("received_at", iso(inputData.getLong(KEY_RECEIVED_AT, System.currentTimeMillis())))
      .put("source_id", inputData.getString(KEY_SOURCE_ID))
    inputData.getString(KEY_SENDER)?.let { payload.put("sender", it.take(40)) }

    val status = try {
      post("$url/v1/sms", token, payload.toString())
    } catch (e: Exception) {
      store.recordError("network: ${e.javaClass.simpleName}")
      return@withContext if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.failure()
    }

    when {
      status in 200..299 -> { store.recordSuccess(); Result.success() }
      status == 422 -> Result.success() // server refused it as an OTP; nothing to retry
      status == 401 -> { store.recordError("unauthorized: re-pair this phone"); Result.failure() }
      status in 400..499 && status != 429 -> { store.recordError("rejected: HTTP $status"); Result.failure() }
      else -> {
        store.recordError("server: HTTP $status")
        if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.failure()
      }
    }
  }

  private fun post(url: String, token: String, json: String): Int {
    val conn = URL(url).openConnection() as HttpURLConnection
    try {
      conn.requestMethod = "POST"
      conn.connectTimeout = 15_000
      conn.readTimeout = 30_000
      conn.doOutput = true
      conn.setRequestProperty("Content-Type", "application/json")
      conn.setRequestProperty("Authorization", "Bearer $token")
      conn.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
      return conn.responseCode
    } finally {
      conn.disconnect()
    }
  }

  companion object {
    const val TAG = "fintrack-sms-upload"
    private const val KEY_SENDER = "sender"
    private const val KEY_BODY = "body"
    private const val KEY_RECEIVED_AT = "received_at"
    private const val KEY_SOURCE_ID = "source_id"
    private const val MAX_ATTEMPTS = 20

    fun enqueue(context: Context, sender: String?, body: String, receivedAt: Long) {
      val sourceId = sha256("$sender|$receivedAt|$body")
      val request = OneTimeWorkRequestBuilder<UploadWorker>()
        .setInputData(
          workDataOf(KEY_SENDER to sender, KEY_BODY to body, KEY_RECEIVED_AT to receivedAt, KEY_SOURCE_ID to sourceId),
        )
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .addTag(TAG)
        .build()
      // Unique per message so a duplicate broadcast doesn't queue it twice.
      WorkManager.getInstance(context).enqueueUniqueWork("sms-$sourceId", ExistingWorkPolicy.KEEP, request)
    }

    // Bank SMS and the device token never travel over plain HTTP, except to a
    // backend on this machine (emulator host alias or localhost) during development.
    private val LOCAL_HOSTS = setOf("10.0.2.2", "localhost", "127.0.0.1")

    fun isAllowedUrl(url: String): Boolean {
      val parsed = try { URL(url) } catch (e: Exception) { return false }
      return parsed.protocol == "https" || (parsed.protocol == "http" && parsed.host in LOCAL_HOSTS)
    }

    private fun iso(millis: Long): String =
      SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date(millis))

    private fun sha256(s: String): String =
      MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }.take(32)
  }
}
