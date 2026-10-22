package expo.modules.smscollector

/**
 * Decides on-device which SMS may leave the phone. Personal messages, OTPs and
 * anything without a money amount are never uploaded. The server re-checks.
 */
object SmsFilter {
  // Banks send from alphanumeric headers like "AX-HDFCBK-S"; people send from phone numbers.
  private val PHONE_NUMBER = Regex("""^\+?\d[\d\s-]{5,}$""")
  private val AMOUNT = Regex("""(?i)(rs\.?|inr|₹)\s*\d""")
  private val MONEY_WORD = Regex("""(?i)\b(debited|credited|spent|sent|paid|withdrawn|received|refund\w*|revers\w*|dr\.?|cr\.?|txn|transaction)\b""")
  private val OTP = Regex("""(?i)\b(otp|one[\s-]?time[\s-]?password|verification code|passcode)\b""")

  fun shouldForward(sender: String?, body: String): Boolean {
    if (sender != null && PHONE_NUMBER.matches(sender.trim())) return false
    if (OTP.containsMatchIn(body)) return false
    return AMOUNT.containsMatchIn(body) && MONEY_WORD.containsMatchIn(body)
  }
}
