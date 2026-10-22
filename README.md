# fintrack

Personal finance tracker for two users. Phones forward bank SMS to a small API on a VPS, which turns them into a deduplicated transaction ledger.

Parsers cover Bank of Baroda and HDFC (debit, Diners Club Millennia and Tata Neo cards). Other banks go through a generic fallback, with Claude as the last resort. The app adds categories, a review queue, manual entries, alerts and an assistant on top.

## Parsing tiers

1. **Tuned parsers (BoB, HDFC):** built and tested against real messages.
2. **Generic rules:** about 20 common Indian banks recognized by sender ID or name (SBI, ICICI, Axis, Kotak and others), plus any "*Name* Bank" written in the text. These use the same field extraction as the tuned parsers, at lower confidence.
3. **Claude fallback:** SMS still unrecognized after the rules are sent to Claude in the background, never inside the request. This is on only when `ANTHROPIC_API_KEY` is set.
   - The model's answer is grounded against the SMS text. The amount must literally appear in the message, or no transaction is created.
   - Account digits, reference numbers and UPI IDs that don't appear in the text are dropped.
   - These transactions are tagged `llm/<model>` with confidence 0.5.
   - A failed call is retried up to 3 times. The last error is saved in `evidence.llm_error`.

To try the fallback on one message: `pbpaste | pnpm -s fintrack parse --llm`.

## How it works

- Each SMS is stored as **evidence**. Evidence resolves to a canonical **transaction**, so one payment reported by several messages is counted once.
- Messages are matched only on the bank or UPI reference. Two ₹180 payments with different references stay as two transactions.
- OTPs are rejected before they are stored. Due reminders, autopay notices, failed transactions and collect requests are marked `ignored`, and their raw text is not kept.
- Raw SMS text is encrypted with AES-256-GCM and deleted after 30 days (90 days for unrecognized messages, so a parser can be written for them). The structured ledger is kept.
- Messages from unknown banks or in unknown formats are marked `unrecognized`. The parser never guesses missing amounts or directions.

## Categories and the review queue

Each new transaction is categorised when it's created:
1. **Payee rules** the user taught the app (matched by UPI ID, else by merchant name).
2. **Built-in merchant keywords** (`src/categories.ts`): Swiggy is Food, Zepto is Groceries, Uber is Transport, and so on.
3. Otherwise the transaction goes to the **Review** tab with a question: "Who was this paid to?" for a bare UPI ID or phone number, "What was this for?" for an unknown merchant, or "Is this right?" when Claude read the SMS.

Answering in Review saves a payee rule and applies it to that payee's other unanswered transactions, so each payee is asked about once. The user can also mark a payment as a transfer between their own accounts, or as "don't count"; both are left out of spending totals, along with card bill payments and ATM withdrawals (`src/stats.ts`).

Cash and anything else without an SMS can be added by hand. Manual entries can be edited and deleted; bank transactions can only be relabelled or excluded, because the SMS would recreate them.

## Alerts

The notifier (`src/notify.ts`) runs every 30 seconds and right after each new transaction. It writes to an in-app inbox:
- **Payment alerts** for payments at or above the user's threshold (₹500 by default).
- **Review prompts** for new transactions it couldn't categorise, whatever their size.
- **A daily digest** at the user's chosen hour (21:00 by default): today's spending, top categories, the month so far and anything waiting for review.
- **Budget warnings** at 80% and 100% of an optional monthly budget.

**Push notifications** go through [ntfy](https://ntfy.sh), because a free Apple account can't send iOS push from our own app. The user turns push on in Settings, which creates a secret topic; they subscribe to it in the ntfy app (iOS or Android), and tapping an alert opens the transaction in Fintrack. ntfy.sh is the default server and sees alert text (amounts and payees). To avoid that, run ntfy on the VPS and set `FINTRACK_PUSH_URL`.

## Bank emails

Banks email most payments as well as texting them. Each person can connect up to five mailboxes in Settings with an **app password** (Gmail: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords). The server logs in to check it before saving it, keeps it sealed with the data key, and never returns it.

Every 5 minutes (and right after connecting, or on **Sync**) the server reads INBOX over IMAP:
- read-only (`EXAMINE`): nothing is marked as read, moved or deleted;
- the first sync looks back 30 days, later ones continue from the last UID seen;
- only mail from bank domains (a list, plus any `.bank.in` address) with a payment-like subject is read; offers, statements, OTPs and everything else are skipped without a parse or a model call;
- only mail your provider authenticated is trusted: the topmost `Authentication-Results` header (added by Gmail/Outlook, not the sender) must show DMARC pass, or a DKIM pass signed by the bank's own domain. Forged "bank" emails are skipped;
- a custom mail server must resolve only to public addresses (no loopback, private, link-local or metadata IPs) and use TLS on port 993; the connection is pinned to the checked address.
- the alert part of the body (subject first, disclaimers cut off) goes through the same parser and Haiku fallback as SMS.

An SMS and an email about the same payment become **one** transaction: they join on the UPI/bank reference, or, when one of them has none, on same bank + amount + direction within 15 minutes (36 hours if the message has only a date) as long as that transaction doesn't already have a message from the same source. The second message fills in what the first left out (reference, UPI ID, payee, account). Two SMS for identical purchases never merge.

Payments that arrive more than 6 hours after they happened (a first mailbox sync, an SMS backlog) don't trigger alerts; they still appear in the app and the review queue.

## Assistant

The **Ask** tab sends the conversation to `POST /v1/ask`, which runs Claude (Haiku by default) with two read-only tools: `search_transactions` and `spending_breakdown`. Both are scoped to the asking user, and all totals are computed in SQL, so the model reports figures rather than calculating them. It is off unless `ANTHROPIC_API_KEY` is set.

## Local development

```sh
pnpm install
docker compose up -d                       # Postgres on 127.0.0.1:54329
cp .env.example .env && pnpm -s fintrack keygen   # paste key into .env
pnpm test                                  # parser + DB/API tests (needs a fintrack_test database, see below)
pnpm dev                                   # API on :8080 with reload
```

Create the test database once with `psql postgres://fintrack:fintrack@127.0.0.1:54329/fintrack -c "create database fintrack_test"`.

### Testing against a real SMS

```sh
pbpaste | pnpm -s fintrack parse
```

This prints what the parser extracts and touches no database. When a real message parses incorrectly, add it to `tests/sms.test.ts` with the account digits masked, then fix the parser.

## Deploying to the VPS

```sh
cd deploy
cp .env.example .env                 # set domain, Postgres password, data key
docker compose up -d --build
docker compose exec app node src/main.ts user add --name Kage
docker compose exec app node src/main.ts device add --user <user-id> --name "Kage iPhone" --platform ios
```

Point the domain's DNS A record at the VPS before starting the stack; Caddy obtains the TLS certificate automatically. Back up `FINTRACK_DATA_KEY` somewhere safe. Without it the stored raw SMS can't be decrypted, though the ledger itself still works.

Revoke a lost phone's token with `device revoke --id <device-id>`.

## Mobile app (`mobile/`)

The Expo app runs on iOS and Android. It has four tabs:
- **Home:** the month's spending against the budget, a breakdown by category, and transactions with the bank name only. Search, the notification inbox and **Add** (manual entry) are in the header. Tapping a transaction opens it for editing.
- **Review:** transactions the app couldn't work out, each with one-tap answers.
- **Ask:** questions about your spending, answered by the assistant.
- **Settings:** alert threshold, daily summary time, budget, push setup, account, the SMS collector status on Android and the Shortcut setup guide on iOS.

**Accounts.** People sign up in the app with a phone number and a 4-digit PIN, and sign in with the same on any other phone; every phone gets its own token for the same account. The number isn't verified, it only names the account. Five wrong PINs lock the account for 15 minutes, doubling with each further five (up to a day), and sign-in is limited to 10 tries a minute per IP. A forgotten PIN is reset on the server:

```sh
pnpm -s fintrack user set-pin --phone 9876543210 --pin 4821
```

**App lock.** The app locks every time it opens or returns from the background. Face ID, Touch ID or the fingerprint unlocks it, and the account PIN is the fallback. The lock screen also hides balances in the app switcher.

Pairing codes (`fintrack pair --user <id> …`) still work through the API, for scripts and collectors, but the app signs in with phone and PIN.

Running locally:

```sh
cd mobile
npm install
npx expo run:ios       # simulator; server defaults to http://localhost:8080
npx expo run:android   # emulator; server defaults to http://10.0.2.2:8080
```

Plain HTTP is for local development only:
- `app.config.ts` turns off Android cleartext traffic when `APP_VARIANT=production`.
- Release builds of the app reject any server URL that isn't `https://`.
- The native uploader never sends SMS over HTTP, except to `10.0.2.2` or `localhost`.

### Android collector

The native module in `mobile/modules/sms-collector` does the following:
- It receives every incoming SMS, even when the app is closed.
- It forwards only messages that:
  - come from an alphanumeric sender ID (banks), not a phone number (people),
  - contain an amount and a debit/credit word,
  - and don't look like an OTP.
- Uploads go through WorkManager, so they wait for network and retry with backoff. The server ignores duplicates, so retries are safe.
- The settings screen shows whether SMS permission is granted, how many messages were forwarded, how many are waiting, and the last error.

To test on the emulator: `adb emu sms send AXHDFCBK "Spent Rs.250 On HDFC Bank Card 1234 At ZEPTO On 2026-10-21:20:00:00"`.

## iOS collector (Shortcuts automation)

iOS doesn't let apps read SMS, so a personal automation forwards matching messages instead. The app's Settings screen shows these steps, with buttons to copy the URL and the Authorization header.

1. Open **Shortcuts → Automation → New Automation → Message**.
2. Leave **Sender** as *Any Sender*, because bank sender IDs can't be picked as contacts. Set **Message Contains** to `Rs`. Choose **Run Immediately**, then **Next → Create New Shortcut**.
   - If one of your banks writes `INR` instead, add a second automation for that.
3. Add an **If** action:
   - Tap *Shortcut Input* and choose **Content**. *Shortcut Input* is a Message, with Content, Sender and Recipients properties.
   - Set the condition to **does not contain** and type `OTP`.
   - Delete the **Otherwise** row.
4. Add **Get Contents of URL** and drag it between **If** and **End If**. Shortcuts pre-fills its URL with *Shortcut Input*: tap it, choose **Clear Variable**, then paste `https://<your-domain>/v1/sms`.
5. Tap **›** on the action to show its options:
   - **Method:** POST
   - **Headers:** `Authorization` = `Bearer <device token>`
   - **Request Body:** JSON, with a Text field `body` = *Shortcut Input → Content*. Optionally add a second Text field, `sender` = *Shortcut Input → Sender*, which helps identify the bank.
6. Save. **The first time a bank SMS arrives, iOS asks whether to allow sending it to your server. Tap Always Allow**, or the automation stops at that prompt.

Notes:
- The server rejects OTPs too. The **If** step just keeps them from leaving the phone.
- Resending the same SMS is harmless, because ingestion is idempotent.
- `received_at` is optional. The automation runs as the SMS arrives, so the server's receive time is accurate enough, and most bank SMS include their own timestamp. If you send it anyway, blank values are ignored.

**What has been verified:**
- On an iOS 26.2 simulator:
  - the trigger options and the *Shortcut Input* properties above;
  - and the request half of the automation (POST, header, JSON body), run against the API, which created a linked transaction.
- **Still unverified:** the trigger firing on a real iPhone, and its behaviour while the phone is locked. The simulator can't receive SMS.

## API

All `/v1` routes require `Authorization: Bearer <device token>` and are limited to 120 requests per minute per token.

| Route | Purpose |
|---|---|
| `POST /v1/sms` | `{ body, sender?, received_at?, source_id? }` → `{ evidenceId, status, reason, transactionId, duplicate }`. Returns `422` for OTPs. |
| `GET /v1/transactions?limit=&before=&review=1&category=&q=` | Newest first, scoped to the token's user. `review=1` lists the review queue |
| `POST /v1/transactions` | Manual entry: `{ amount_minor, direction, counterparty, category?, occurred_at?, paid_with?, note? }` |
| `GET /v1/transactions/:id` | One transaction, plus where it came from (sender and parser, never the SMS text) |
| `PATCH /v1/transactions/:id` | `{ label?, category?, note?, event_type?, excluded?, remember? }`. Marks it reviewed. `remember` saves a payee rule and returns `applied_to` |
| `DELETE /v1/transactions/:id` | Manual entries only |
| `GET /v1/summary?month=YYYY-MM` | Month totals, by bank and by category, budget and review count |
| `GET /v1/notifications`, `POST /v1/notifications/read` | The inbox |
| `GET/PATCH /v1/settings`, `POST /v1/settings/push/test` | Alert threshold, digest hour, budget, push on/off |
| `GET /v1/mail`, `PUT /v1/mail`, `DELETE /v1/mail/:id`, `POST /v1/mail/sync[?id=]` | Bank-email mailboxes, up to 5 per user. `PUT { address, app_password, host? }` adds one, or updates the password of that address; it checks the login first (`422 auth_failed`, `connect_failed`, `bad_host`, `unknown_provider`; `409 too_many_mailboxes`) |
| `POST /v1/ask` | `{ messages: [{ role, content }] }` → `{ answer }`. `503` when no API key is set |
| `GET /healthz` | Liveness check |

Amounts are integers in paise (`amount_minor`).

## Next steps

- Subscription detection, monthly report
