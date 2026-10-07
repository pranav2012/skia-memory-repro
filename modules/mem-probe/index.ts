import { requireOptionalNativeModule } from "expo";

type MemProbeModule = {
  footprint(): number;
  graphics(): number;
  appendLog(line: string): void;
  clearLog(): void;
};

export const MemProbe = requireOptionalNativeModule<MemProbeModule>("MemProbe");
