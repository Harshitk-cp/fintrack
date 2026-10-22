import Svg, { Path } from "react-native-svg";
import { useTheme } from "@/lib/theme";
import { PIXEL_ICONS, type PixelIconName } from "./pixel-icon-data";

export type { PixelIconName };

/** A pixelarticons glyph. Sizes that are multiples of 12 keep the pixels crisp. */
export function PixelIcon({ name, size = 24, color }: { name: PixelIconName; size?: number; color?: string }) {
  const t = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={PIXEL_ICONS[name]} fill={color ?? t.text} />
    </Svg>
  );
}
