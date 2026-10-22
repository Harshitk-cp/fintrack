// Launch screen: a pixel-art tree in the app palette. The canopy sways in a
// slow breeze and sheds pixel leaves, the wordmark fades in, then the whole
// screen dissolves into the app. Drawn in code, so nothing to license.
import { useEffect, useMemo } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { Easing, FadeIn, interpolate, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import Svg, { Rect } from "react-native-svg";
import { CyberBackground, Wordmark } from "./cyber";
import { Text } from "./text";
import { FONT, mix, MOTION, PALETTE, useTheme } from "@/lib/theme";

const COLS = 48;
const ROWS = 46;
const TRUNK_X = 24; // centre column
const PIVOT_ROW = 27; // the canopy sways around the top of the trunk

const LEAF_HIGHLIGHT = mix(PALETTE.orange, PALETTE.amande, 0.55);
const LEAF_SHADE = mix(PALETTE.orange, PALETTE.oxford, 0.22);
const LEAF_DEEP = mix(PALETTE.orange, PALETTE.oxford, 0.42);
const BARK_LIGHT = mix(PALETTE.oxford, PALETTE.vista, 0.35);

type Pixel = { x: number; y: number; c: string; o?: number };

function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** Bresenham line in grid cells. */
function line(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) return out;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** The tree as pixels: a swaying canopy (with its branches) and a fixed trunk and ground. */
function drawTree() {
  const rand = seeded(11);
  const canopy: Pixel[] = [];
  const fixed: Pixel[] = [];

  // Puffy clusters, like the reference trees: each is lit on its own top-left.
  const blobs: [number, number, number][] = [
    [24, 7, 6], [17, 9, 5.5], [31, 9, 5.5], [11, 14, 5], [37, 14, 5], [20, 14, 6.5], [29, 14, 6.5],
    [14, 19, 5], [34, 19, 5], [24, 18, 6], [8, 19, 3.5], [40, 19, 3.5],
  ];
  const cells = new Map<string, Pixel>();
  for (let y = 0; y < 28; y++) {
    for (let x = 0; x < COLS; x++) {
      const m = blobs.map(([cx, cy, r]) => ({ cx, cy, r, d: Math.hypot(x - cx, y - cy) / r })).sort((p, q) => p.d - q.d);
      const near = m[0]!;
      const n = rand();
      if (near.d > 1 - n * 0.22) continue; // ragged edge
      const seam = m[1] && m[1].d - near.d < 0.12 && near.d > 0.55; // where two clusters meet
      const light = ((near.cx - x) * 0.75 + (near.cy - y)) / near.r - (y > 17 ? 0.35 : 0) + (rand() - 0.5) * 0.35;
      const c = seam
        ? LEAF_SHADE
        : rand() < 0.03
          ? PALETTE.amande
          : light > 0.55 ? LEAF_HIGHLIGHT : light > -0.15 ? PALETTE.orange : light > -0.7 ? LEAF_SHADE : LEAF_DEEP;
      cells.set(`${x},${y}`, { x, y, c });
    }
  }

  // Branches: visible below the crown and through its gaps.
  const branches: [number, number, number, number][] = [
    [24, 27, 17, 21], [24, 27, 31, 21], [24, 26, 24, 20], [17, 21, 13, 19], [31, 21, 35, 19], [20, 24, 18, 25], [28, 24, 31, 25],
  ];
  for (const [x0, y0, x1, y1] of branches) {
    for (const [x, y] of line(x0, y0, x1, y1)) {
      const under = cells.get(`${x},${y}`);
      // Hidden under thick leaves, showing at the crown's lower edge.
      if (!under || y >= 21 || rand() < 0.25) canopy.push({ x, y, c: PALETTE.oxford });
    }
  }
  canopy.push(...cells.values());

  // Trunk: slim, with a slight lean, widening into roots; the left edge catches the light.
  for (let y = 26; y <= 42; y++) {
    const lean = Math.round(Math.sin((y - 26) / 16 * Math.PI) * 0.8);
    const half = y >= 41 ? 3 : y >= 38 ? 2 : y >= 32 ? 1.5 : 1;
    for (let x = Math.round(TRUNK_X - half) + lean; x <= Math.round(TRUNK_X + half) + lean; x++) {
      fixed.push({ x, y, c: x === Math.round(TRUNK_X - half) + lean ? BARK_LIGHT : PALETTE.oxford });
    }
  }
  // A soft shadow and fallen leaves at the foot.
  for (let x = 11; x <= 37; x++) fixed.push({ x, y: 43, c: PALETTE.oxford, o: 0.08 + 0.08 * (1 - Math.abs(x - TRUNK_X) / 13) });
  for (let i = 0; i < 34; i++) {
    const x = Math.round(TRUNK_X + (rand() - 0.5) * 2 * (5 + rand() * 14));
    const y = 42 + Math.floor(rand() * 2);
    if (Math.abs(x - TRUNK_X) <= 3 && y === 42) continue;
    fixed.push({ x, y, c: [PALETTE.orange, LEAF_HIGHLIGHT, LEAF_SHADE, PALETTE.amande][Math.floor(rand() * 4)]! });
  }
  return { canopy, fixed };
}

function Pixels({ pixels, cell }: { pixels: Pixel[]; cell: number }) {
  return (
    <Svg width={COLS * cell} height={ROWS * cell}>
      {pixels.map((p, i) => (
        <Rect key={i} x={p.x * cell} y={p.y * cell} width={cell} height={cell} fill={p.c} opacity={p.o ?? 1} />
      ))}
    </Svg>
  );
}

/** One leaf: falls from the crown to the ground, swaying sideways and fluttering. */
function Leaf({ cell, seed }: { cell: number; seed: number }) {
  const rand = seeded(seed * 97 + 13);
  const startX = (10 + rand() * 28) * cell;
  const startY = (13 + rand() * 11) * cell;
  const fall = (42 - startY / cell) * cell;
  const sway = (1.5 + rand() * 2) * cell;
  const drift = (rand() - 0.3) * 4 * cell; // a light breeze to the right
  const duration = 2800 + rand() * 1800;
  const delay = rand() * 2200;
  const phase = rand() * Math.PI * 2;
  const color = [PALETTE.orange, LEAF_HIGHLIGHT, LEAF_SHADE, PALETTE.amande][Math.floor(rand() * 4)]!;
  const size = cell * (rand() < 0.3 ? 0.7 : 1);

  const p = useSharedValue(0);
  useEffect(() => {
    p.set(withDelay(delay, withRepeat(withTiming(1, { duration, easing: Easing.linear }), -1)));
  }, [p, delay, duration]);
  const style = useAnimatedStyle(() => {
    const t = p.get();
    return {
      opacity: interpolate(t, [0, 0.08, 0.85, 1], [0, 1, 1, 0]),
      transform: [
        { translateX: startX + Math.sin(t * Math.PI * 2.4 + phase) * sway + t * drift },
        { translateY: startY + t * fall },
        { scaleX: 0.35 + 0.65 * Math.abs(Math.cos(t * Math.PI * 3 + phase)) }, // flutter
      ],
    };
  });
  return <Animated.View style={[styles.leaf, { width: size, height: size, backgroundColor: color }, style]} />;
}

export function Splash({ leaving, ready, onGone, onShown }: { leaving: boolean; ready: boolean; onGone: () => void; onShown?: () => void }) {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const cell = Math.max(4, Math.min(7, Math.floor((width * 0.78) / COLS)));
  const tree = useMemo(() => drawTree(), []);

  const breeze = useSharedValue(0);
  const enter = useSharedValue(0);
  const exit = useSharedValue(1);
  useEffect(() => {
    enter.set(withTiming(1, { duration: 700, easing: MOTION.ease }));
    breeze.set(withRepeat(withSequence(
      withTiming(1, { duration: 1900, easing: Easing.inOut(Easing.sin) }),
      withTiming(-1, { duration: 1900, easing: Easing.inOut(Easing.sin) }),
    ), -1));
  }, [enter, breeze]);
  useEffect(() => {
    if (!leaving) return;
    exit.set(withTiming(0, { duration: EXIT_MS, easing: MOTION.ease }));
    const timer = setTimeout(onGone, EXIT_MS);
    return () => clearTimeout(timer);
  }, [leaving, exit, onGone]);

  const pivotX = (TRUNK_X + 0.5) * cell;
  const pivotY = PIVOT_ROW * cell;
  const canopy = useAnimatedStyle(() => ({
    transform: [
      { translateX: pivotX }, { translateY: pivotY },
      { rotate: `${breeze.get() * 1.4}deg` },
      { translateX: -pivotX }, { translateY: -pivotY },
      { translateX: breeze.get() * 1.2 },
    ],
  }));
  const screen = useAnimatedStyle(() => ({ opacity: exit.get() }));
  const treeIn = useAnimatedStyle(() => ({ opacity: enter.get(), transform: [{ translateY: (1 - enter.get()) * 8 }] }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg }, screen]} onLayout={onShown} pointerEvents={leaving ? "none" : "auto"}>
      <CyberBackground />
      <View style={[styles.center, { paddingBottom: height * 0.08 }]}>
        <Animated.View style={[{ width: COLS * cell, height: ROWS * cell }, treeIn]}>
          <View style={StyleSheet.absoluteFill}>
            <Pixels pixels={tree.fixed} cell={cell} />
          </View>
          <Animated.View style={[StyleSheet.absoluteFill, canopy]}>
            <Pixels pixels={tree.canopy} cell={cell} />
          </Animated.View>
          {Array.from({ length: 14 }, (_, i) => (
            <Leaf key={i} cell={cell} seed={i + 1} />
          ))}
        </Animated.View>
        {ready && (
          <Animated.View entering={FadeInSlow} style={styles.brand}>
            <Wordmark size={30} />
            <Text style={[styles.tag, { color: t.muted }]}>PERSONAL LEDGER</Text>
          </Animated.View>
        )}
      </View>
    </Animated.View>
  );
}

// The wordmark arrives after the tree has settled.
const FadeInSlow = FadeIn.duration(800).delay(450).easing(MOTION.ease);
const EXIT_MS = 650;

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  leaf: { position: "absolute", left: 0, top: 0 },
  brand: { alignItems: "center", marginTop: 18, gap: 10 },
  tag: { fontFamily: FONT.pixel, fontSize: 10, letterSpacing: 3 },
});
