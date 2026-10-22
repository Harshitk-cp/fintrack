// The app's visual language: a pastel, minimal "tech label" look. Rounded bento
// cards on Amande paper, Oxford ink panels, Orange as the single loud colour,
// pixel-font labels, barcodes and thin rules as detail, and spring motion.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import Animated, {
  Easing, FadeInDown, interpolate, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, Path, Pattern, Rect } from "react-native-svg";
import { alpha, FONT, MOTION, PALETTE, RADIUS, useTheme } from "@/lib/theme";
import { PixelIcon } from "./pixel-icon";
import { Text, TextInput } from "./text";

const PRESS_IN = { duration: MOTION.fast, easing: MOTION.ease };
const PRESS_OUT = { duration: MOTION.base, easing: MOTION.ease };
const AnimatedPath = Animated.createAnimatedComponent(Path);

/** Full-screen paper: the page colour with a faint dot grid. */
export function CyberBackground() {
  const t = useTheme();
  const { width: w, height: h } = useWindowDimensions();
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg }]} />
      <Svg width={w} height={h}>
        <Defs>
          <Pattern id="dots" width={18} height={18} patternUnits="userSpaceOnUse">
            <Rect x={8} y={8} width={2} height={2} fill={PALETTE.oxford} opacity={0.09} />
          </Pattern>
        </Defs>
        <Rect width={w} height={h} fill="url(#dots)" />
      </Svg>
    </View>
  );
}

/** Fades its child in while it settles a few pixels upward; `index` staggers siblings. */
export function Reveal({ index = 0, children, style }: { index?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <Animated.View entering={FadeInDown.duration(MOTION.slow).easing(MOTION.ease).delay(40 + index * 50).withInitialValues({ transform: [{ translateY: 10 }] })} style={style}>
      {children}
    </Animated.View>
  );
}

/** Pressable that eases down slightly on touch. */
export function PressScale({ children, onPress, disabled, style, scale = 0.98, accessibilityLabel }: {
  children: ReactNode; onPress?: () => void; disabled?: boolean; style?: StyleProp<ViewStyle>; scale?: number; accessibilityLabel?: string;
}) {
  const s = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: s.get() }] }));
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPressIn={() => s.set(withTiming(scale, PRESS_IN))}
      onPressOut={() => s.set(withTiming(1, PRESS_OUT))}
    >
      <Animated.View style={[style, a]}>{children}</Animated.View>
    </Pressable>
  );
}

type ButtonKind = "primary" | "solid" | "ghost";

/**
 * Pill button. `solid` is the main action: an Oxford pill with an Orange disc
 * holding an arrow. `primary` is an outlined pill, `ghost` a quiet text button.
 */
export function CyberButton({ title, onPress, kind = "primary", busy, disabled, style, icon }: {
  title: string; onPress: () => void; kind?: ButtonKind; busy?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; icon?: ReactNode;
}) {
  const t = useTheme();
  const press = useSharedValue(0);
  const off = disabled || busy;
  const a = useAnimatedStyle(() => ({ transform: [{ scale: 1 - press.get() * 0.02 }] }));
  const disc = useAnimatedStyle(() => ({ transform: [{ translateX: press.get() * 3 }] }));
  const solid = kind === "solid";
  const label = solid ? t.onInk : t.text;

  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      onPressIn={() => press.set(withTiming(1, PRESS_IN))}
      onPressOut={() => press.set(withTiming(0, PRESS_OUT))}
      style={style}
    >
      <Animated.View
        style={[
          styles.button,
          solid ? { backgroundColor: t.ink } : kind === "primary" ? { borderWidth: 1.5, borderColor: t.text } : null,
          { opacity: off && !busy ? 0.4 : 1, paddingRight: solid ? 6 : 22 },
          a,
        ]}
      >
        {busy ? (
          <ActivityIndicator color={label} style={{ flex: 1 }} />
        ) : (
          <>
            <View style={[styles.buttonRow, solid && { flex: 1, paddingLeft: 16 }]}>
              {icon}
              <Text style={[styles.buttonText, { color: label }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                {title.toUpperCase()}
              </Text>
            </View>
            {solid && (
              <Animated.View style={[styles.disc, { backgroundColor: t.accent }, disc]}>
                <PixelIcon name="arrow-right" size={20} color={t.onAccent} />
              </Animated.View>
            )}
          </>
        )}
      </Animated.View>
    </Pressable>
  );
}

/** A labelled input: pixel label above a rounded field whose outline turns Orange while focused. */
export function CyberField({ label, style, onFocus, onBlur, ...input }: TextInputProps & { label: string }) {
  const t = useTheme();
  const focus = useSharedValue(0);
  const ring = useAnimatedStyle(() => ({ opacity: focus.get() }));
  const dot = useAnimatedStyle(() => ({ transform: [{ scale: focus.get() }] }));

  return (
    <View style={[styles.field, style]}>
      <PixelLabel>{label}</PixelLabel>
      <View style={[styles.fieldBox, { backgroundColor: t.inputBg, borderColor: t.border }]}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.fieldRing, { borderColor: t.accent }, ring]} />
        <TextInput
          placeholderTextColor={alpha(PALETTE.oxford, 0.32)}
          {...input}
          onFocus={(e) => {
            focus.set(withTiming(1, { duration: MOTION.fast, easing: MOTION.ease }));
            onFocus?.(e);
          }}
          onBlur={(e) => {
            focus.set(withTiming(0, { duration: 200 }));
            onBlur?.(e);
          }}
          style={[styles.fieldInput, { color: t.text }]}
        />
        <Animated.View style={[styles.fieldDot, { backgroundColor: t.accent }, dot]} />
      </View>
    </View>
  );
}

/** "FINTRACK" in Unbounded with the two-rings-and-a-dot mark. The dot breathes slowly. */
export function Wordmark({ size = 34, style, color }: { size?: number; style?: StyleProp<ViewStyle>; color?: string }) {
  const t = useTheme();
  const ink = color ?? t.text;
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.set(withRepeat(withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }), -1, true));
  }, [pulse]);
  const dot = useAnimatedStyle(() => ({ opacity: interpolate(pulse.get(), [0, 1], [0.75, 1]) }));
  const r = size * 0.36;
  return (
    <View style={[styles.wordmarkRow, style]} accessibilityRole="header" accessibilityLabel="Fintrack">
      <Text style={[styles.wordmark, { fontSize: size, lineHeight: size * 1.2, color: ink }]}>FINTRACK</Text>
      <View style={{ flexDirection: "row", alignItems: "center", marginLeft: size * 0.3 }}>
        <View style={{ width: r * 2, height: r * 2, borderRadius: r, borderWidth: 1.5, borderColor: ink }} />
        <View style={{ width: r * 2, height: r * 2, borderRadius: r, borderWidth: 1.5, borderColor: ink, marginLeft: -r * 0.7 }} />
        <Animated.View style={[{ width: r * 2, height: r * 2, borderRadius: r, backgroundColor: t.accent, marginLeft: -r * 0.35 }, dot]} />
      </View>
    </View>
  );
}

/** Three pixel squares that brighten in turn: the assistant is thinking. */
export function ThinkingDots({ color }: { color?: string }) {
  const t = useTheme();
  const v = useSharedValue(0);
  useEffect(() => {
    v.set(withRepeat(withTiming(1, { duration: 1400, easing: Easing.linear }), -1));
  }, [v]);
  return (
    <View style={{ flexDirection: "row", gap: 6, paddingVertical: 6 }} accessibilityLabel="Thinking">
      {[0, 1, 2].map((i) => (
        <ThinkingDot key={i} v={v} offset={i / 3} color={color ?? t.text} />
      ))}
    </View>
  );
}

function ThinkingDot({ v, offset, color }: { v: ReturnType<typeof useSharedValue<number>>; offset: number; color: string }) {
  const style = useAnimatedStyle(() => {
    // A soft wave: each square peaks a third of a cycle after the previous one.
    const phase = (v.get() - offset + 1) % 1;
    return { opacity: 0.25 + 0.75 * Math.max(0, Math.sin(phase * Math.PI)) };
  });
  return <Animated.View style={[{ width: 7, height: 7, backgroundColor: color }, style]} />;
}

/** Small uppercase pixel label, used for field and section titles. */
export function PixelLabel({ children, color, style, right }: { children: string; color?: string; style?: StyleProp<ViewStyle>; right?: string }) {
  const t = useTheme();
  return (
    <View style={[styles.labelRow, style]}>
      <Text style={[styles.label, { color: color ?? t.muted }]}>{children.toUpperCase()}</Text>
      {right && <Text style={[styles.label, { color: color ?? t.muted }]}>{right.toUpperCase()}</Text>}
    </View>
  );
}

/** "LEFT ←————→ RIGHT": a thin labelled rule, the reference's 1989 ←→ 2023 line. */
export function MetaRule({ left, right, color }: { left: string; right: string; color?: string }) {
  const t = useTheme();
  const c = color ?? t.text;
  return (
    <View style={styles.metaRow}>
      <Text style={[styles.meta, { color: c }]}>{left}</Text>
      <View style={styles.metaLine}>
        <View style={[styles.arrowL, { borderRightColor: c }]} />
        <View style={{ flex: 1, height: 1.5, backgroundColor: c }} />
        <View style={[styles.arrowR, { borderLeftColor: c }]} />
      </View>
      <Text style={[styles.meta, { color: c }]}>{right}</Text>
    </View>
  );
}

/** Bar positions for a barcode; a seeded generator so the same seed draws the same code. */
function barcodeBars(width: number, seed: number) {
  let x = seed * 9301 + 49297;
  const rand = () => (x = (x * 9301 + 49297) % 233280) / 233280;
  const bars: { x: number; w: number }[] = [];
  for (let pos = 0; pos < width; ) {
    const w = 1 + Math.floor(rand() * 3);
    if (pos + w > width) break;
    bars.push({ x: pos, w });
    pos += w + 1 + Math.floor(rand() * 3);
  }
  return bars;
}

/** A decorative barcode; `seed` keeps it identical across renders. */
export function Barcode({ width, height = 34, seed = 7, color }: { width: number; height?: number; seed?: number; color?: string }) {
  const t = useTheme();
  const bars = barcodeBars(width, seed);
  return (
    <Svg width={width} height={height}>
      {bars.map((b, i) => (
        <Rect key={i} x={b.x} y={0} width={b.w} height={height} fill={color ?? t.text} />
      ))}
    </Svg>
  );
}

/** Counts from the previous value to `target` with an ease-out, for headline numbers. */
export function useCountUp(target: number, duration = 900) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = Date.now();
    const begin = from.current;
    let frame = requestAnimationFrame(function tick() {
      const p = Math.min((Date.now() - start) / duration, 1);
      setShown(begin + (target - begin) * (1 - (1 - p) ** 3));
      if (p < 1) frame = requestAnimationFrame(tick);
      else from.current = target;
    });
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return shown;
}

/** A segmented pixel bar that springs to `value` (0–1). */
export function Meter({ value, color, track, height = 8, delay = 0 }: { value: number; color?: string; track?: string; height?: number; delay?: number }) {
  const t = useTheme();
  const [w, setW] = useState(0);
  const v = useSharedValue(0);
  useEffect(() => {
    v.set(withDelay(delay, withTiming(Math.max(0, Math.min(value, 1)), { duration: 900, easing: MOTION.ease })));
  }, [value, delay, v]);
  const fill = useAnimatedStyle(() => ({ width: v.get() * w }));
  const seg = height + 2;
  // The gaps between segments take the colour of whatever the meter sits on.
  const gap = track ? t.ink : t.card;
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height, backgroundColor: track ?? alpha(PALETTE.oxford, 0.1), overflow: "hidden", borderRadius: 2 }}>
      <Animated.View style={[{ height, backgroundColor: color ?? t.accent }, fill]} />
      {w > 0 && (
        <Svg width={w} height={height} style={StyleSheet.absoluteFill}>
          {Array.from({ length: Math.floor(w / seg) }, (_, i) => (
            <Rect key={i} x={(i + 1) * seg - 2} y={0} width={2} height={height} fill={gap} />
          ))}
        </Svg>
      )}
    </View>
  );
}

/** A 270° arc gauge that sweeps to `value` (0–1), with tick dots; the reference's "26K" dial. */
export function Gauge({ value, size = 220, color, track, children }: { value: number; size?: number; color?: string; track?: string; children?: ReactNode }) {
  const t = useTheme();
  const stroke = 7;
  const r = (size - stroke * 2 - 16) / 2;
  const c = size / 2;
  const start = 135; // degrees, clockwise from 3 o'clock
  const sweep = 270;
  const point = (deg: number, radius = r) => {
    const a = (deg * Math.PI) / 180;
    return { x: c + radius * Math.cos(a), y: c + radius * Math.sin(a) };
  };
  const s = point(start);
  const e = point(start + sweep);
  const d = `M ${s.x} ${s.y} A ${r} ${r} 0 1 1 ${e.x} ${e.y}`;
  const length = (Math.PI * 2 * r * sweep) / 360;
  const v = useSharedValue(0);
  useEffect(() => {
    v.set(withDelay(200, withTiming(Math.max(0, Math.min(value, 1)), { duration: 1200, easing: MOTION.ease })));
  }, [value, v]);
  const props = useAnimatedProps(() => ({ strokeDashoffset: length * (1 - v.get()) }));
  const ticks = Array.from({ length: 10 }, (_, i) => point(start + (sweep / 9) * i, r + 13));

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Path d={d} stroke={track ?? alpha(PALETTE.amande, 0.25)} strokeWidth={stroke} strokeLinecap="round" fill="none" />
        <AnimatedPath d={d} stroke={color ?? t.accent} strokeWidth={stroke} strokeLinecap="round" fill="none" strokeDasharray={`${length} ${length}`} animatedProps={props} />
        {ticks.map((p, i) => (
          <Circle key={i} cx={p.x} cy={p.y} r={1.6} fill={track ?? alpha(PALETTE.amande, 0.5)} />
        ))}
      </Svg>
      {children}
    </View>
  );
}

/** Tiny bar chart for a week, with day initials under each bar; the highest bar is Orange. */
export function MiniBars({ values, labels, color, accent, height = 40 }: { values: number[]; labels: string[]; color?: string; accent?: string; height?: number }) {
  const t = useTheme();
  const max = Math.max(1, ...values);
  const top = values.indexOf(Math.max(...values));
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
      {values.map((v, i) => (
        <View key={i} style={{ alignItems: "center", gap: 4 }}>
          <View style={{ height, justifyContent: "flex-end" }}>
            <Reveal index={i}>
              <View style={{ width: 5, height: Math.max(3, (v / max) * height), borderRadius: 2, backgroundColor: v > 0 && i === top ? (accent ?? t.accent) : (color ?? t.text) }} />
            </Reveal>
          </View>
          <Text style={[styles.dayLabel, { color: color ?? t.text }]}>{labels[i]}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 56, borderRadius: RADIUS.pill, flexDirection: "row", alignItems: "center", justifyContent: "center", paddingLeft: 22 },
  buttonRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  buttonText: { fontFamily: FONT.pixel, fontSize: 14, letterSpacing: 2.5 },
  disc: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  field: { marginBottom: 18 },
  fieldBox: { height: 54, borderRadius: RADIUS.field, borderWidth: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 16 },
  fieldRing: { borderRadius: RADIUS.field, borderWidth: 1.5 },
  fieldInput: { flex: 1, fontSize: 17, height: "100%" },
  fieldDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 8 },
  wordmarkRow: { flexDirection: "row", alignItems: "center" },
  wordmark: { fontFamily: FONT.display, letterSpacing: -0.5 },
  labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8, marginHorizontal: 4 },
  label: { fontFamily: FONT.pixel, fontSize: 10, letterSpacing: 1.8 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  meta: { fontFamily: FONT.displayMedium, fontSize: 15 },
  metaLine: { flex: 1, flexDirection: "row", alignItems: "center" },
  arrowL: { width: 0, height: 0, borderTopWidth: 5, borderBottomWidth: 5, borderRightWidth: 8, borderTopColor: "transparent", borderBottomColor: "transparent" },
  arrowR: { width: 0, height: 0, borderTopWidth: 5, borderBottomWidth: 5, borderLeftWidth: 8, borderTopColor: "transparent", borderBottomColor: "transparent" },
  dayLabel: { fontFamily: FONT.pixel, fontSize: 7, opacity: 0.8 },
});
