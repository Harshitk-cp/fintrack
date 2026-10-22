package expo.modules.smscollector

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/** Receives every incoming SMS, keeps only bank-style messages, and queues them for upload. */
class SmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    val store = CollectorStore(context)
    if (!store.enabled) return

    val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
    // A long SMS arrives as several parts from the same sender; join them back up.
    parts.filterNotNull()
      .groupBy { it.originatingAddress }
      .forEach { (sender, msgs) ->
        val body = msgs.joinToString("") { it.messageBody ?: "" }
        val receivedAt = msgs.minOf { it.timestampMillis }
        if (SmsFilter.shouldForward(sender, body)) {
          store.recordSeen()
          UploadWorker.enqueue(context, sender, body, receivedAt)
        }
      }
  }
}
