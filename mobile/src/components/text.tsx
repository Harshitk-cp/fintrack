// Drop-in Text / TextInput that use the app fonts. Custom fonts on Android need
// the exact face per weight, so fontWeight is mapped to a Chakra Petch face
// unless a fontFamily (e.g. the pixel font) is set explicitly.
import type { ComponentProps } from "react";
import { Text as RNText, TextInput as RNTextInput, StyleSheet, type TextProps, type TextStyle } from "react-native";
import { FONT, useTheme } from "@/lib/theme";

function face(style: TextStyle): TextStyle {
  if (style.fontFamily) return { fontWeight: undefined };
  const w = String(style.fontWeight ?? "400");
  const fontFamily = w === "700" || w === "800" || w === "900" || w === "bold" ? FONT.bold : w === "600" ? FONT.semibold : w === "500" ? FONT.medium : FONT.regular;
  return { fontFamily, fontWeight: undefined };
}

export function Text({ style, ...rest }: TextProps) {
  const flat = StyleSheet.flatten(style) ?? {};
  return <RNText {...rest} style={[style, face(flat)]} />;
}

export function TextInput({ style, ...rest }: ComponentProps<typeof RNTextInput>) {
  const t = useTheme();
  const flat = StyleSheet.flatten(style) ?? {};
  return <RNTextInput selectionColor={t.accent} keyboardAppearance="dark" {...rest} style={[style, face(flat)]} />;
}
