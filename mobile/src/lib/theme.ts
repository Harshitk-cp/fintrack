import { useColorScheme } from "react-native";

const light = {
  bg: "#F6F6F3",
  card: "#FFFFFF",
  text: "#16181D",
  muted: "#6B7079",
  border: "#E4E4DF",
  accent: "#1F6F5C",
  credit: "#1F7A4D",
  danger: "#B4372C",
  inputBg: "#FFFFFF",
};

const dark: typeof light = {
  bg: "#0F1113",
  card: "#1A1D21",
  text: "#ECEDEE",
  muted: "#9BA1A6",
  border: "#2A2E33",
  accent: "#4DB892",
  credit: "#5CC98F",
  danger: "#F07167",
  inputBg: "#15181B",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

/** Header styling shared by every stack. */
export function useStackOptions() {
  const t = useTheme();
  return {
    headerStyle: { backgroundColor: t.bg },
    headerTintColor: t.text,
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal" as const,
    contentStyle: { backgroundColor: t.bg },
  };
}
