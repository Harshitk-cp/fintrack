import { useCallback, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { ApiError, connectMail, disconnectMail, getMail, syncMail, type Mailbox, type MailState } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { alpha, PALETTE, RADIUS, useTheme } from "@/lib/theme";
import { useRefreshOnActive } from "@/lib/useRefreshOnActive";
import { CyberButton, CyberField, PixelLabel } from "./cyber";
import { PixelIcon } from "./pixel-icon";
import { Text } from "./text";
import { Card } from "./ui";

const ERRORS: Record<string, string> = {
  auth_failed: "The mail server rejected that email and app password. Check both, and that it's an app password, not your normal one.",
  connect_failed: "Couldn't reach the mail server. Check the server name, or try again.",
  bad_host: "That mail server name doesn't point to a public mail server.",
  unknown_provider: "We don't know this provider's mail server. Enter it below (usually imap.yourdomain.com).",
  too_many_mailboxes: "That's the most mailboxes you can connect. Remove one first.",
  mail_disabled: "Email reading is turned off on this server.",
  network_error: "Can't reach the Fintrack server.",
};

const STATUS: Record<Mailbox["status"], string> = {
  pending: "Checking for the first time…",
  ok: "Working",
  auth_failed: "Password stopped working: update it with a new app password",
  error: "Last check failed; it will retry",
};

/** Connect one or more mailboxes so bank alert emails are read alongside SMS. */
export function MailSettings() {
  const t = useTheme();
  const { session } = useSession();
  const [mail, setMail] = useState<MailState | null>(null);
  const [adding, setAdding] = useState<{ address: string } | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    const m = await getMail(session).catch(() => null);
    if (m) setMail(m);
  }, [session]);
  useRefreshOnActive(useCallback(() => void load(), [load]));

  if (!mail?.available) return null;
  const boxes = mail.mailboxes;
  const showForm = adding !== null || boxes.length === 0;

  return (
    <View style={styles.section}>
      <PixelLabel right={boxes.length ? `${boxes.length}/${mail.max}` : undefined}>Bank emails</PixelLabel>
      <Animated.View layout={LinearTransition.springify().damping(18)} style={{ gap: 10 }}>
        {boxes.map((m) => (
          <Animated.View key={m.id} entering={FadeIn} exiting={FadeOut}>
            <MailboxCard
              box={m}
              onSync={async () => {
                if (!session) return;
                await syncMail(session, m.id).catch(() => {});
                setTimeout(() => void load(), 3000);
              }}
              onFix={() => setAdding({ address: m.address })}
              onRemove={async () => {
                if (!session) return;
                await disconnectMail(session, m.id).catch(() => {});
                setMail({ ...mail, mailboxes: boxes.filter((x) => x.id !== m.id) });
              }}
            />
          </Animated.View>
        ))}

        {showForm ? (
          <Animated.View entering={FadeIn}>
            <AddMailbox
              key={adding?.address ?? "new"}
              initialAddress={adding?.address ?? ""}
              intro={boxes.length === 0}
              onCancel={boxes.length ? () => setAdding(null) : undefined}
              onAdded={(m) => {
                setMail(m);
                setAdding(null);
                // The first check runs on the server right away; show its result in a moment.
                setTimeout(() => void load(), 4000);
              }}
            />
          </Animated.View>
        ) : (
          boxes.length < mail.max && (
            <CyberButton title="Add another mailbox" kind="primary" icon={<PixelIcon name="plus" size={18} color={t.text} />} onPress={() => setAdding({ address: "" })} />
          )
        )}
      </Animated.View>
      <Text style={[styles.footer, { color: t.muted }]}>
        Fintrack only reads emails from banks that your provider has verified, never marks anything as read, and keeps app passwords encrypted on the server.
      </Text>
    </View>
  );
}

function MailboxCard({ box, onSync, onFix, onRemove }: { box: Mailbox; onSync: () => void; onFix: () => void; onRemove: () => void }) {
  const t = useTheme();
  const bad = box.status === "auth_failed" || box.status === "error";
  return (
    <Card style={{ gap: 10 }}>
      <View style={styles.boxTop}>
        <View style={[styles.boxIcon, { backgroundColor: bad ? t.accent : alpha(PALETTE.oxford, 0.06) }]}>
          <PixelIcon name="mail" size={20} color={t.text} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }} numberOfLines={1}>
            {box.address}
          </Text>
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: box.status === "ok" ? t.vista : t.accent }]} />
            <Text style={{ color: t.muted, fontSize: 13, flex: 1 }}>{STATUS[box.status]}</Text>
          </View>
        </View>
      </View>
      <Text style={{ color: t.muted, fontSize: 13 }}>
        {box.emails_found} bank email{box.emails_found === 1 ? "" : "s"} read
        {box.last_checked_at ? ` · checked ${formatDateTime(box.last_checked_at)}` : ""}
      </Text>
      <View style={styles.actions}>
        {box.status === "auth_failed" ? (
          <Text style={[styles.action, { color: t.link }]} onPress={onFix}>
            Update password
          </Text>
        ) : (
          <Text style={[styles.action, { color: t.link }]} onPress={onSync}>
            Sync now
          </Text>
        )}
        <Text style={[styles.action, { color: t.muted }]} onPress={onRemove}>
          Remove
        </Text>
      </View>
    </Card>
  );
}

function AddMailbox({ initialAddress, intro, onCancel, onAdded }: { initialAddress: string; intro: boolean; onCancel?: () => void; onAdded: (m: MailState) => void }) {
  const t = useTheme();
  const { session } = useSession();
  const [address, setAddress] = useState(initialAddress);
  const [password, setPassword] = useState("");
  const [host, setHost] = useState("");
  const [needHost, setNeedHost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      onAdded(await connectMail(session, { address: address.trim(), app_password: password, ...(needHost && host.trim() ? { host: host.trim() } : {}) }));
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "unknown";
      if (code === "unknown_provider") setNeedHost(true);
      setError(ERRORS[code] ?? "Couldn't connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const gmail = /@(gmail|googlemail)\.com$/i.test(address.trim());
  return (
    <Card style={{ gap: 4 }}>
      {intro && (
        <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20, marginBottom: 10 }}>
          Banks also send an email for most payments. Reading them catches payments whose SMS never arrived and fills in details an SMS leaves out. You can connect up to five mailboxes.
        </Text>
      )}
      <CyberField
        label="Email"
        value={address}
        onChangeText={setAddress}
        placeholder="you@gmail.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        // Not a login: stops iOS offering to save the app password to the keychain.
        autoComplete="off"
        textContentType="none"
        editable={!initialAddress}
      />
      <CyberField label="App password" value={password} onChangeText={setPassword} placeholder="abcd efgh ijkl mnop" secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="none" autoComplete="off" />
      {needHost && <CyberField label="Mail server (IMAP)" value={host} onChangeText={setHost} placeholder="imap.yourdomain.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" />}

      <View style={[styles.help, { backgroundColor: t.cardStrong }]}>
        <PixelIcon name="lock" size={18} color={t.text} />
        <Text style={{ color: t.text, fontSize: 13, lineHeight: 19, flex: 1 }}>
          {gmail || !address
            ? "Gmail: turn on 2-Step Verification, then create an app password named Fintrack and paste the 16 letters here."
            : "Use an app password from your email provider's security settings, not your normal password."}
          {(gmail || !address) && (
            <Text style={{ textDecorationLine: "underline", fontWeight: "600" }} onPress={() => void Linking.openURL("https://myaccount.google.com/apppasswords")}>
              {"  Open Google app passwords"}
            </Text>
          )}
        </Text>
      </View>

      {error && (
        <Animated.View entering={FadeIn} style={[styles.error, { backgroundColor: t.accent }]}>
          <Text style={{ color: t.onAccent, fontSize: 14, lineHeight: 19, fontWeight: "600" }}>{error}</Text>
        </Animated.View>
      )}
      <CyberButton
        title={initialAddress ? "Update password" : "Connect mailbox"}
        kind="solid"
        busy={busy}
        disabled={!address.includes("@") || password.replace(/\s/g, "").length < 8}
        onPress={connect}
        style={{ marginTop: 8 }}
      />
      {onCancel && (
        <Text style={{ color: t.muted, fontSize: 14, textAlign: "center", marginTop: 10, textDecorationLine: "underline" }} onPress={onCancel}>
          Cancel
        </Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 24 },
  footer: { fontSize: 13, lineHeight: 18, marginTop: 8, marginHorizontal: 6 },
  boxTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  boxIcon: { width: 40, height: 40, borderRadius: RADIUS.tile, alignItems: "center", justifyContent: "center" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  actions: { flexDirection: "row", justifyContent: "space-between", paddingTop: 4 },
  action: { fontSize: 15, fontWeight: "600", textDecorationLine: "underline" },
  help: { flexDirection: "row", gap: 10, borderRadius: 14, padding: 12, marginTop: 4, marginBottom: 8 },
  error: { borderRadius: 14, padding: 12, marginBottom: 8 },
});
