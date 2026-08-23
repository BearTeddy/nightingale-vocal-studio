import { microphoneAdapter, type MicrophoneAdapter, type StopListening } from "@/bridge/microphone";
import {
  MAX_MIC_LATENCY_COMPENSATION_SEC,
  MIN_MIC_LATENCY_COMPENSATION_SEC,
} from "@/lib/pitch/constants";

const BASELINE_MS = 300;
const TEST_TIMEOUT_MS = 2200;
const BEEP_DELAY_MS = 120;
const BEEP_FREQ_HZ = 1000;
const BEEP_DURATION_SEC = 0.16;
const BEEP_GAIN = 0.9;

function rms(samples: number[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function clampLatency(sec: number): number {
  return Math.min(
    MAX_MIC_LATENCY_COMPENSATION_SEC,
    Math.max(MIN_MIC_LATENCY_COMPENSATION_SEC, sec),
  );
}

async function createUnlockedAudioContext(): Promise<AudioContext> {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextCtor();
  await context.resume();

  // Unlock output during the button click gesture; the audible beep plays after baseline capture.
  // Use a real one-sample buffer: some WebAudio hosts ignore a BufferSource with no buffer.
  const unlock = context.createBufferSource();
  unlock.buffer = context.createBuffer(1, 1, context.sampleRate);
  unlock.connect(context.destination);
  unlock.start();

  return context;
}

async function playBeep(context: AudioContext): Promise<number> {
  if (context.state !== "running") {
    await context.resume();
  }

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "square";
  oscillator.frequency.value = BEEP_FREQ_HZ;
  gain.gain.setValueAtTime(0.0001, context.currentTime);

  const startAt = context.currentTime + BEEP_DELAY_MS / 1000;
  gain.gain.exponentialRampToValueAtTime(BEEP_GAIN, startAt + 0.01);
  gain.gain.setValueAtTime(BEEP_GAIN, startAt + BEEP_DURATION_SEC - 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + BEEP_DURATION_SEC);

  oscillator.connect(gain).connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + BEEP_DURATION_SEC);

  return performance.now() + (startAt - context.currentTime) * 1000;
}

export async function measureMicLatencySec(
  deviceId: string | null,
  adapter: MicrophoneAdapter = microphoneAdapter,
): Promise<number> {
  let stopListening: StopListening = () => {};
  let beepWallStart = 0;
  let baselineSum = 0;
  let baselineCount = 0;
  const startedAt = performance.now();
  const context = await createUnlockedAudioContext();

  try {
    await adapter.startCapture(deviceId, { emit_audio: false, monitor_mode: null });

    return await new Promise<number>((resolve, reject) => {
      let done = false;
      let threshold = 0.02;

      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        stopListening();
        void adapter.stopCapture().catch(() => {});
        void context.close().catch(() => {});
        fn();
      };

      const timer = window.setTimeout(() => {
        finish(() =>
          reject(
            new Error("No mic response detected. Increase speaker volume or move mic closer."),
          ),
        );
      }, TEST_TIMEOUT_MS);

      adapter
        .onSamples((frame) => {
          const now = performance.now();
          const level = rms(frame.samples);

          if (!beepWallStart) {
            baselineSum += level;
            baselineCount += 1;
            return;
          }

          if (now < beepWallStart) return;

          if (level >= threshold) {
            window.clearTimeout(timer);
            finish(() => resolve(clampLatency((now - beepWallStart) / 1000)));
          }
        })
        .then((stop) => {
          stopListening = stop;
        })
        .catch((error) => {
          window.clearTimeout(timer);
          finish(() => reject(error));
        });

      window.setTimeout(
        () => {
          const baseline = baselineCount > 0 ? baselineSum / baselineCount : 0;
          threshold = Math.max(0.02, baseline + 0.03, baseline * 6);
          playBeep(context)
            .then((start) => {
              beepWallStart = start;
            })
            .catch((error) => {
              window.clearTimeout(timer);
              finish(() => reject(error));
            });
        },
        Math.max(0, BASELINE_MS - (performance.now() - startedAt)),
      );
    });
  } catch (error) {
    stopListening();
    await adapter.stopCapture().catch(() => {});
    await context.close().catch(() => {});
    throw error;
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
