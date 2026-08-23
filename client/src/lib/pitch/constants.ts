export const PITCH_WINDOW_SAMPLES = 2048;

// Covers the complete C2-C6 Vocal Studio scale with detector headroom.
export const MIN_PITCH_HZ = 55;
export const MAX_PITCH_HZ = 1200;

export const PITCH_CLARITY_THRESHOLD = 0.4;

export const MIC_PITCH_CLARITY_THRESHOLD = 0.55;

export const REF_RMS_GATE = 0.005;
export const MIC_RMS_GATE = 0.003;
export const MIC_CLIPPED_PEAK = 0.985;

export const PUSH_INTERVAL_SEC = 0.02;
export const PITCH_DISCONTINUITY_SEC = 0.5;
export const SMOOTHING = 0.55;

export const PITCH_BUFFER_SIZE = 200;

export const PITCH_FULL_CREDIT_CENTS = 25;
export const PITCH_ZERO_CREDIT_CENTS = 100;

export const DEFAULT_MIC_LATENCY_COMPENSATION_SEC = 0.08;
export const MIN_MIC_LATENCY_COMPENSATION_SEC = 0;
export const MAX_MIC_LATENCY_COMPENSATION_SEC = 0.5;
