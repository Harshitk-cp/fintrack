import type { ConfigContext, ExpoConfig } from "expo/config";

// Release builds talk only to the HTTPS server. Dev builds also need plain HTTP to
// reach the local backend from the Android emulator (http://10.0.2.2:8080).
const isRelease = process.env.APP_VARIANT === "production";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  plugins: [...(config.plugins ?? []), ["expo-build-properties", { android: { usesCleartextTraffic: !isRelease } }]],
});
