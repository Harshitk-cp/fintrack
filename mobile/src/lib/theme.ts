// A light, pastel palette built from exactly four colours. Every other shade is
// one of them with transparency, or two of them mixed. Amande is the paper,
// Oxford the ink, Orange the one loud colour (fills, icons, outlines; never
// small text, it's too faint on Amande), Vista Bleu a calm second card colour.
export const PALETTE = {
  orange: "#FF8400",
  vista: "#8FA0D8",
  amande: "#F9DFC6",
  oxford: "#0B0829",
} as const;

/** A palette colour at the given opacity (0–1). */
export const alpha = (hex: string, a: number) =>
  `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;

/** `a` blended towards `b` by `t` (0–1), as an opaque hex colour. */
export function mix(a: string, b: string, t: number) {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(ch(a, i) * (1 - t) + ch(b, i) * t).toString(16).padStart(2, "0")).join("")}`;
}

const theme = {
  /** The page: Amande with a touch of Oxford, so Amande cards lift off it. */
  bg: mix(PALETTE.amande, PALETTE.oxford, 0.07),
  card: PALETTE.amande,
  cardStrong: mix(PALETTE.amande, PALETTE.oxford, 0.05),
  /** Dark "ink" panels (hero cards, the tab bar) and the text on them. */
  ink: PALETTE.oxford,
  onInk: PALETTE.amande,
  inkMuted: alpha(PALETTE.amande, 0.6),
  text: PALETTE.oxford,
  muted: alpha(PALETTE.oxford, 0.58),
  border: alpha(PALETTE.oxford, 0.14),
  accent: PALETTE.orange,
  onAccent: PALETTE.oxford,
  /** Text that would have been orange: links and warnings stay readable in Oxford. */
  link: PALETTE.oxford,
  dangerText: PALETTE.oxford,
  credit: PALETTE.oxford,
  danger: PALETTE.orange,
  vista: PALETTE.vista,
  inputBg: PALETTE.amande,
  glow: alpha(PALETTE.orange, 0.35),
};

export type Theme = typeof theme;

export function useTheme(): Theme {
  return theme;
}

/** Unbounded (wide, heavy) for big numbers and the wordmark; Silkscreen (pixel) for labels; Chakra Petch for reading. */
export const FONT = {
  display: "Unbounded_800ExtraBold",
  displayMedium: "Unbounded_600SemiBold",
  pixel: "Silkscreen_400Regular",
  pixelBold: "Silkscreen_700Bold",
  regular: "ChakraPetch_400Regular",
  medium: "ChakraPetch_500Medium",
  semibold: "ChakraPetch_600SemiBold",
  bold: "ChakraPetch_700Bold",
} as const;

export const RADIUS = { card: 24, field: 14, pill: 999, tile: 12 } as const;

/** The floating tab bar: a fixed height, and its distance from the bottom edge. */
export const TAB_BAR_HEIGHT = 76;
export const tabBarBottom = (safeAreaBottom: number) => Math.max(safeAreaBottom - 8, 12);
/** Where the top of the tab bar sits, measured from the bottom of the screen. */
export const tabBarTop = (safeAreaBottom: number) => tabBarBottom(safeAreaBottom) + TAB_BAR_HEIGHT;

/** Room to leave at the bottom of scrolling tab screens so content clears the floating tab bar. */
export const TAB_BAR_SPACE = 120;

/** Header styling shared by every stack. */
export function useStackOptions() {
  return {
    headerStyle: { backgroundColor: theme.bg },
    headerTintColor: theme.text,
    headerTitleStyle: { fontFamily: FONT.pixel, fontSize: 15, color: theme.text },
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal" as const,
    contentStyle: { backgroundColor: "transparent" },
  };
}
