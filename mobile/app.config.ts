import type { ConfigContext, ExpoConfig } from "expo/config";

// Release builds talk only to the HTTPS server. Dev builds also need plain HTTP to
// reach the local backend from the Android emulator (http://10.0.2.2:8080).
const isRelease = process.env.APP_VARIANT === "production";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  plugins: [
    ...(config.plugins ?? []),
    [
      "expo-build-properties",
      {
        android: {
          usesCleartextTraffic: !isRelease,
          // Release builds are shrunk by R8. WorkManager (pulled in by Firebase messaging) creates its
          // Room database by reflection, so the generated *_Impl classes must keep their constructors.
          extraProguardRules: [
            "-keep class * extends androidx.room.RoomDatabase { <init>(); }",
            "-keep class androidx.work.impl.** { *; }",
          ].join("\n"),
        },
      },
    ],
  ],
});
