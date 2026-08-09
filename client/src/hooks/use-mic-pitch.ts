import {
  microphoneAdapter,
  type MicCaptureOptions,
  type MicrophoneAdapter,
} from "@/bridge/microphone";
import { useMicSamples } from "@/hooks/use-mic-samples";
import { SampleRing } from "@/lib/mic/sample-ring";
import { PITCH_WINDOW_SAMPLES } from "@/lib/pitch/constants";
import { createMicPitchDetector, detectMicPitchDetails } from "@/lib/pitch/detect";
import { freqToSemitone } from "@/lib/pitch/state";
import type { MicCaptureStatus } from "@/types/MicCaptureStatus";
import type { PitchFrame } from "@/types/PitchFrame";
import { useCallback, useEffect, useRef, useState } from "react";

/** ~30 Hz pitch updates: more than enough for vocal pitch tracking. */
const PITCH_TICK_MS = 33;
const RING_CAPACITY = PITCH_WINDOW_SAMPLES * 2;
const MIC_RETRY_MS = 1_500;

const defaultAdapter = microphoneAdapter;

export function useMicPitch(enabled: boolean) {
  const [latestPitch, setLatestPitch] = useState<number | null>(null);
  const [latestFrame, setLatestFrame] = useState<PitchFrame | null>(null);
  const [active, setActive] = useState(false);
  const ringRef = useRef<SampleRing | null>(null);
  const sampleRateRef = useRef(0);
  const sampleIndexRef = useRef(0);
  const lastDetectedEndIndexRef = useRef(0);
  const lastStreamFrameAtRef = useRef(0);
  const lastFallbackEndIndexRef = useRef(0);
  const fallbackBusyRef = useRef(false);

  if (ringRef.current === null) {
    ringRef.current = new SampleRing(RING_CAPACITY);
  }

  useMicSamples((frame) => {
    sampleRateRef.current = frame.sample_rate;
    sampleIndexRef.current = frame.sample_index + frame.samples.length;
    lastStreamFrameAtRef.current = performance.now();
    ringRef.current?.push(frame.samples);
  }, enabled);

  useEffect(() => {
    if (!enabled) {
      setLatestPitch(null);
      setLatestFrame(null);
      setActive(false);
      ringRef.current?.reset();
      sampleRateRef.current = 0;
      lastDetectedEndIndexRef.current = 0;
      lastStreamFrameAtRef.current = 0;
      lastFallbackEndIndexRef.current = 0;
      fallbackBusyRef.current = false;
      return;
    }

    setActive(true);
    const detector = createMicPitchDetector();
    const window = new Float32Array(PITCH_WINDOW_SAMPLES);

    const updatePitch = (samples: Float32Array, sr: number, sampleIndex: number) => {
      lastDetectedEndIndexRef.current = sampleIndex;
      const details = detectMicPitchDetails(detector, samples, sr);
      setLatestPitch(details.hz);
      setLatestFrame({
        hz: details.hz,
        midi: details.hz == null ? null : freqToSemitone(details.hz),
        clarity: details.clarity,
        rms: details.rms,
        peak: details.peak,
        voiced: details.hz != null,
        sample_index: sampleIndex,
        sample_rate: sr,
        captured_at_ms: (sampleIndex / sr) * 1000,
      });
    };

    const pollFallback = async () => {
      if (
        !defaultAdapter.getLatestSamples ||
        fallbackBusyRef.current ||
        performance.now() - lastStreamFrameAtRef.current < 250
      ) {
        return;
      }
      fallbackBusyRef.current = true;
      try {
        const frame = await defaultAdapter.getLatestSamples();
        if (!frame || frame.samples.length < PITCH_WINDOW_SAMPLES) return;
        const endIndex = frame.sample_index + frame.samples.length;
        if (endIndex === lastFallbackEndIndexRef.current) return;
        lastFallbackEndIndexRef.current = endIndex;
        const samples = Float32Array.from(frame.samples.slice(-PITCH_WINDOW_SAMPLES));
        updatePitch(samples, frame.sample_rate, endIndex);
      } catch {
        // Capture errors remain owned by useMicCapture; retry the diagnostic path.
      } finally {
        fallbackBusyRef.current = false;
      }
    };

    const tick = () => {
      const ring = ringRef.current;
      const sr = sampleRateRef.current;
      const sampleIndex = sampleIndexRef.current;
      if (
        ring &&
        sr > 0 &&
        sampleIndex !== lastDetectedEndIndexRef.current &&
        performance.now() - lastStreamFrameAtRef.current < 250 &&
        ring.readMostRecent(window)
      ) {
        updatePitch(window, sr, sampleIndex);
        return;
      }
      void pollFallback();
    };

    const id = setInterval(tick, PITCH_TICK_MS);

    return () => {
      clearInterval(id);
      setLatestPitch(null);
      setLatestFrame(null);
      setActive(false);
    };
  }, [enabled]);

  return { latestPitch, latestFrame, active, error: null as string | null };
}

export function useMicCapture(
  deviceId: string | null,
  enabled: boolean,
  options: MicCaptureOptions,
  adapter: MicrophoneAdapter = defaultAdapter,
) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [status, setStatus] = useState<MicCaptureStatus | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const startedRef = useRef(false);
  const generationRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);

  const cancelRetry = useCallback(() => {
    if (retryTimerRef.current == null) return;
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const scheduleRetry = useCallback(() => {
    if (retryTimerRef.current != null) return;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setRetryGeneration((current) => current + 1);
    }, MIC_RETRY_MS);
  }, []);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    if (!enabled) {
      cancelRetry();
      if (startedRef.current) {
        adapter.stopCapture().catch(() => {});
        startedRef.current = false;
      }
      setError(null);
      setActive(false);
      setDeviceName(null);
      setStatus(null);
      return;
    }

    let cancelled = false;

    const run = async () => {
      setStatus(null);
      try {
        const startedDevice = await adapter.startCapture(deviceId, options);

        if (cancelled) {
          if (generationRef.current === generation) {
            await adapter.stopCapture().catch(() => {});
          }
          return;
        }

        if (generationRef.current !== generation) return;
        startedRef.current = true;
        cancelRetry();
        setDeviceName(startedDevice);
        setActive(true);
        setError(null);
      } catch (e) {
        void adapter.stopCapture().catch(() => {});
        startedRef.current = false;
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
          setActive(false);
          setDeviceName(null);
          scheduleRetry();
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (generationRef.current === generation && startedRef.current) {
        adapter.stopCapture().catch(() => {});
        startedRef.current = false;
      }
      setActive(false);
    };
  }, [enabled, options.emit_audio, deviceId, adapter, retryGeneration, cancelRetry, scheduleRetry]);

  useEffect(() => cancelRetry, [cancelRetry]);

  useEffect(() => {
    if (!enabled || !active || !adapter.getCaptureStatus) return;
    let cancelled = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const status = await adapter.getCaptureStatus?.();
        if (!cancelled && status) setStatus(status);
        if (!cancelled && status && !status.running) {
          startedRef.current = false;
          setActive(false);
          setDeviceName(null);
          setError("The microphone stopped or was disconnected");
          void adapter.stopCapture().catch(() => {});
          scheduleRetry();
        }
      } catch {
        // The start/stop command path owns IPC errors; the next poll retries.
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, adapter, enabled, scheduleRetry]);

  return { active, error, deviceName, status };
}
