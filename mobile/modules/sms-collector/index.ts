import { NativeModule, requireOptionalNativeModule } from "expo";

export interface CollectorStatus {
  enabled: boolean;
  hasPermission: boolean;
  pending: number;
  forwardedCount: number;
  lastForwardedAt: number | null;
  lastSeenAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

declare class SmsCollectorModule extends NativeModule<{}> {
  configure(serverUrl: string, token: string): void;
  disable(): void;
  getStatus(): Promise<CollectorStatus>;
}

/** Android only; null on iOS, where apps can't read SMS (the Shortcut forwards instead). */
export default requireOptionalNativeModule<SmsCollectorModule>("SmsCollector");
