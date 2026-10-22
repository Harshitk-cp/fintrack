import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chip } from "@/components/ui";
import { ApiError, ask, type ChatMessage } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useTheme } from "@/lib/theme";

const SUGGESTIONS = [
  "How much have I spent this month?",
  "What are my top 5 categories this month?",
  "How much did I spend on food last week?",
  "What were my biggest payments this month?",
  "Compare this month with last month",
];

// The server accepts at most 20 messages; older context is dropped first.
const MAX_HISTORY = 19;

export default function AskScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { session } = useSession();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<FlatList<ChatMessage>>(null);
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", () => setKeyboard(true));
    const hide = Keyboard.addListener("keyboardWillHide", () => setKeyboard(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // The iOS tab bar floats over the screen; keep the input above it unless the keyboard is up.
  const bottomPad = Platform.OS === "ios" ? (keyboard ? 8 : insets.bottom + 54) : 8;

  async function send(text: string) {
    const q = text.trim();
    if (!q || !session || busy) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      let history = next.slice(-MAX_HISTORY);
      if (history[0]?.role === "assistant") history = history.slice(1);
      const { answer } = await ask(session, history);
      setMessages([...next, { role: "assistant", content: answer }]);
    } catch (e) {
      setMessages(messages); // put the question back so it can be retried
      setInput(q);
      setError(
        e instanceof ApiError && e.code === "assistant_disabled"
          ? "The assistant is off on this server. Set ANTHROPIC_API_KEY on the server to turn it on."
          : e instanceof ApiError && e.code === "network_error"
            ? "Can't reach the server."
            : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
      <FlatList
        ref={list}
        contentInsetAdjustmentBehavior="automatic"
        data={messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: 16, gap: 10, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={{ gap: 14, paddingTop: 8 }}>
            <Text style={{ color: t.text, fontSize: 22, fontWeight: "700" }}>Ask about your money</Text>
            <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21 }}>
              Answers come from your own transactions. It can only read them, not change anything.
            </Text>
            <View style={styles.chips}>
              {SUGGESTIONS.map((s) => (
                <Chip key={s} label={s} onPress={() => send(s)} />
              ))}
            </View>
          </View>
        }
        renderItem={({ item }) => {
          const mine = item.role === "user";
          return (
            <View style={[styles.bubble, mine ? [styles.mine, { backgroundColor: t.accent }] : [styles.theirs, { backgroundColor: t.card, borderColor: t.border }]]}>
              <Text style={{ color: mine ? "#fff" : t.text, fontSize: 15, lineHeight: 21 }} selectable>
                {mine ? item.content : withBold(item.content)}
              </Text>
            </View>
          );
        }}
        ListFooterComponent={
          <View>
            {busy && <ActivityIndicator style={{ alignSelf: "flex-start", margin: 8 }} color={t.muted} />}
            {error && <Text style={{ color: t.danger, fontSize: 14 }}>{error}</Text>}
          </View>
        }
      />
      <View style={[styles.bar, { borderTopColor: t.border, backgroundColor: t.bg, paddingBottom: bottomPad }]}>
        <TextInput
          style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.inputBg }]}
          value={input}
          onChangeText={setInput}
          placeholder="Ask a question"
          placeholderTextColor={t.muted}
          multiline
          maxLength={1000}
          onSubmitEditing={() => send(input)}
          submitBehavior="submit"
          returnKeyType="send"
        />
        <Pressable
          onPress={() => send(input)}
          disabled={!input.trim() || busy}
          accessibilityRole="button"
          accessibilityLabel="Send"
          style={({ pressed }) => [styles.send, { backgroundColor: t.accent, opacity: !input.trim() || busy ? 0.4 : pressed ? 0.8 : 1 }]}
        >
          <Text style={{ color: "#fff", fontSize: 18, fontWeight: "700" }}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

/** Renders the **bold** spans the assistant uses; everything else stays plain text. */
function withBold(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 ? (
      <Text key={i} style={{ fontWeight: "700" }}>
        {part}
      </Text>
    ) : (
      part
    ),
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bubble: { maxWidth: "85%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  mine: { alignSelf: "flex-end", borderBottomRightRadius: 4 },
  theirs: { alignSelf: "flex-start", borderBottomLeftRadius: 4, borderWidth: StyleSheet.hairlineWidth },
  bar: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: 16, maxHeight: 120 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
});
