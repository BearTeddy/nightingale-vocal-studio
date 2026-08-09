import { MIC_RMS_GATE } from "@/lib/pitch/constants";
import type { MicCaptureStatus } from "@/types/MicCaptureStatus";

export type MicInputSignalState =
  | "offline"
  | "starting"
  | "no-samples"
  | "silent"
  | "weak"
  | "live"
  | "clipping"
  | "error";

export interface MicInputDiagnostic {
  state: MicInputSignalState;
  label: string;
  detail: string;
  rmsDb: number | null;
  peakPercent: number;
}

export function amplitudeDb(amplitude: number): number | null {
  if (!Number.isFinite(amplitude) || amplitude <= 0) return null;
  return Math.round(20 * Math.log10(amplitude) * 10) / 10;
}

export function diagnoseMicInput(
  status: MicCaptureStatus | null,
  active: boolean,
): MicInputDiagnostic {
  const rmsDb = amplitudeDb(status?.rms ?? 0);
  const peakPercent = Math.round(Math.max(0, Math.min(1, status?.peak ?? 0)) * 100);
  const result = (
    state: MicInputSignalState,
    label: string,
    detail: string,
  ): MicInputDiagnostic => ({ state, label, detail, rmsDb, peakPercent });

  if (!active) return result("offline", "OFFLINE", "Capture is not active");
  if (!status) return result("starting", "STARTING", "Waiting for native status");
  if (!status.running) return result("error", "STOPPED", "Native input stream stopped");
  if (!status.channel_attached)
    return result("error", "NO CHANNEL", "Audio is not reaching the UI");
  if (status.input_samples === 0)
    return result("no-samples", "NO SAMPLES", "Device opened with no audio");
  if (status.peak >= 0.98 || status.rms >= 0.7) {
    return result("clipping", "CLIPPING", "Lower the input level");
  }
  if (status.rms < MIC_RMS_GATE) return result("silent", "SILENT", "No usable signal detected");
  if (status.rms < 0.012) return result("weak", "WEAK", "Move closer or raise input gain");
  if (status.send_errors > 0) return result("error", "IPC ERRORS", "Audio frames were lost");
  return result("live", "LIVE", "Audio samples are arriving");
}
