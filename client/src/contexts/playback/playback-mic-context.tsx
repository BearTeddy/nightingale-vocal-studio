/**
 * Owns everything mic-shaped during playback: device selection, pitch capture,
 * monitor toggle, reactive shader uniforms, and the pitch-scoring series/score.
 *
 * Reads playback state (isReady, isPlaying, paused) from the transport context
 * to gate hardware capture, and persists user toggles to the app config.
 */

import { useMicCapture, useMicPitch } from "@/hooks/use-mic-pitch";
import { useMicDevices } from "@/queries/use-mic-devices";
import { useMicReactive, type MicReactiveRef } from "@/hooks/use-mic-reactive";
import { usePitchScoring } from "@/hooks/use-pitch-scoring";
import { usePlaybackConfigPersist } from "@/hooks/playback/use-playback-config-persist";
import { DEFAULT_MIC_LATENCY_COMPENSATION_SEC } from "@/lib/pitch/constants";
import {
  scoringDifficulty,
  scoringDifficultyProfile,
  type ScoringDifficulty,
} from "@/lib/pitch/difficulty";
import type { PitchSeries } from "@/lib/pitch/state";
import { transformMelodyMap } from "@/lib/pitch/melody";
import { planRecordingAttachment } from "@/lib/recording-sync";
import { shouldAutoExportRecording } from "@/lib/recording-recovery";
import { loadMelodyMap } from "@/bridge/playback";
import { updateMicMonitorEnabled, updateMicMonitorGain } from "@/bridge/microphone";
import {
  exportRecording,
  getVocalRecordingStatus,
  pauseVocalRecording,
  resumeVocalRecording,
  savePracticeSession,
  startVocalRecording,
  stopVocalRecording,
} from "@/bridge/recording";
import type { AppConfig } from "@/types/AppConfig";
import type { MelodyMap } from "@/types/MelodyMap";
import type { MicCaptureStatus } from "@/types/MicCaptureStatus";
import type { PerformanceScore } from "@/types/PerformanceScore";
import type { PitchFrame } from "@/types/PitchFrame";
import type { RecordingTake } from "@/types/RecordingTake";
import type { TransportSegment } from "@/types/TransportSegment";
import { useProfiles } from "@/queries/use-profiles";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  usePlaybackTransportActions,
  usePlaybackTransportState,
} from "./playback-transport-context";
import type { TransportEvent } from "./playback-transport-context";

export interface PlaybackMicState {
  micUserEnabled: boolean;
  micMonitorUserEnabled: boolean;
  micMonitorGain: number;
  selectedMicId: string | null;
  micName: string;
  pitchScore: number | null;
  rawScore: number;
  series: PitchSeries;
  micCaptureActive: boolean;
  micCaptureStatus: MicCaptureStatus | null;
  micPitchActive: boolean;
  micReady: boolean;
  latestFrame: PitchFrame | null;
  melody: MelodyMap | null;
  performance: PerformanceScore;
  performanceSeries: PitchSeries;
  recordingWanted: boolean;
  recordingStatus:
    | "off"
    | "arming"
    | "recording"
    | "paused"
    | "finalizing"
    | "exporting-video"
    | "ready"
    | "failed";
  recordingTake: RecordingTake | null;
  recordingError: string | null;
  vocalGain: number;
  videoExportAvailable: boolean;
  feedbackMode: "coach" | "game";
  scoringDifficulty: ScoringDifficulty;
}

export interface PlaybackMicActions {
  reactiveRef: MicReactiveRef;
  handleToggleMic: () => void;
  handleCycleMic: () => void;
  handleToggleMicMonitor: () => void;
  setMicMonitorGain: (gain: number) => void;
  handleToggleRecording: () => void;
  setVocalGain: (gain: number) => void;
  renderRecordingMix: () => void;
  retryRecordingExport: () => void;
  exportRecordingVideo: () => void;
  setFeedbackMode: (mode: "coach" | "game") => void;
  setScoringDifficulty: (difficulty: ScoringDifficulty) => void;
}

const MicStateContext = createContext<PlaybackMicState | null>(null);
const MicActionsContext = createContext<PlaybackMicActions | null>(null);

interface PlaybackMicProviderProps {
  fileHash: string;
  title: string;
  artist: string;
  videoPath: string | null;
  keyOffset: number;
  tempo: number;
  config: AppConfig | null;
  children: ReactNode;
}

export function PlaybackMicProvider({
  fileHash,
  title,
  artist,
  videoPath,
  keyOffset,
  tempo,
  config,
  children,
}: PlaybackMicProviderProps) {
  const { isReady, isPlaying, isFinished, paused, duration } = usePlaybackTransportState();
  const { subscribe, subscribeTransportEvents, getCurrentTime, getVocalsBuffer } =
    usePlaybackTransportActions();

  const persistConfig = usePlaybackConfigPersist(config);

  const [micUserEnabled, setMicUserEnabled] = useState(config?.mic_active ?? true);
  const [micMonitorUserEnabled, setMicMonitorUserEnabled] = useState(
    config?.mic_monitoring ?? false,
  );
  const [micMonitorGain, setMicMonitorGainState] = useState(config?.mic_monitor_gain ?? 0.65);
  const [selectedMicId, setSelectedMicId] = useState<string | null>(config?.preferred_mic ?? null);
  const [melody, setMelody] = useState<MelodyMap | null>(null);
  const { data: profiles } = useProfiles();
  const [recordingWanted, setRecordingWanted] = useState(false);
  const [recordingStatus, setRecordingStatus] =
    useState<PlaybackMicState["recordingStatus"]>("off");
  const [recordingTake, setRecordingTake] = useState<RecordingTake | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [vocalGain, setVocalGainState] = useState(1);
  const [feedbackMode, setFeedbackMode] = useState<"coach" | "game">("coach");
  const [selectedScoringDifficulty, setSelectedScoringDifficulty] = useState<ScoringDifficulty>(
    () => scoringDifficulty(config?.scoring_difficulty),
  );
  const [performanceSeries, setPerformanceSeries] = useState<PitchSeries>({
    refPitches: [],
    userPitches: [],
    similarities: [],
    timestamps: [],
  });
  const recordingStartedRef = useRef(false);
  const recordingStartTimeRef = useRef(Math.floor(Date.now() / 1000));
  const practiceStartTimeRef = useRef(Math.floor(Date.now() / 1000));
  const practiceSessionSavedRef = useRef(false);
  const recordingTakeRef = useRef<RecordingTake | null>(null);
  const recordingStatusRef = useRef<PlaybackMicState["recordingStatus"]>("off");
  const vocalGainRef = useRef(1);
  const openSegmentRef = useRef<{ sourceStart: number; recordedStart: number } | null>(null);
  const transportSegmentsRef = useRef<TransportSegment[]>([]);
  const transportQueueRef = useRef<Promise<void>>(Promise.resolve());
  const finalizingRef = useRef(false);
  const sessionEndedRef = useRef(false);
  const mountedRef = useRef(true);
  const finalizeRecordingRef = useRef(
    async (_sourceEnd: number, _completion: "completed" | "interrupted") => {},
  );
  const performanceRef = useRef<PerformanceScore | null>(null);
  const getPerformanceSeriesRef = useRef<() => PitchSeries>(() => ({
    refPitches: [],
    userPitches: [],
    similarities: [],
    timestamps: [],
  }));
  const micUserEnabledRef = useRef(micUserEnabled);
  const feedbackModeRef = useRef(feedbackMode);

  useEffect(() => {
    let cancelled = false;
    void loadMelodyMap(fileHash)
      .then((next) => {
        if (!cancelled) setMelody(next ? transformMelodyMap(next, keyOffset, tempo) : null);
      })
      .catch(() => {
        if (!cancelled) setMelody(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fileHash, keyOffset, tempo]);

  const micDevices = useMicDevices();

  const micPitchEnabled = isReady && isPlaying && !paused && micUserEnabled;
  const micMonitorEnabled = isReady && isPlaying && !paused && micMonitorUserEnabled;
  // Start capture while stems are loading so the recording can include a real
  // pre-roll even on machines where playback becomes ready immediately.
  const captureEnabled =
    micUserEnabled && (recordingWanted || micPitchEnabled || micMonitorEnabled);

  const captureOptions = useMemo(
    () => ({
      // Monitoring is toggled through the live command below. Starting with it
      // off avoids ever restarting the shared pitch/recording capture stream.
      emit_audio: false,
      monitor_mode: config?.mic_monitor_mode ?? "low_latency",
    }),
    [config?.mic_monitor_mode],
  );

  const {
    active: micCaptureActive,
    error: micCaptureError,
    status: micCaptureStatus,
  } = useMicCapture(selectedMicId, captureEnabled, captureOptions);
  const {
    latestFrame,
    active: micPitchActive,
    error: micPitchError,
  } = useMicPitch(micPitchEnabled);
  const reactiveRef = useMicReactive(micPitchEnabled);

  useEffect(() => {
    const enabled = micCaptureActive && micMonitorEnabled;
    void updateMicMonitorEnabled(enabled).catch((error) => {
      if (!enabled) return;
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Mic monitor: ${message}`);
    });
  }, [micCaptureActive, micMonitorEnabled]);

  const { series, score, performance, getPerformanceSeries, getPitchInputEvidence } =
    usePitchScoring(
      { isReady, duration, getReferenceBuffer: getVocalsBuffer, subscribe },
      latestFrame,
      melody,
      config?.mic_latency_compensation_sec ?? DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
      selectedScoringDifficulty,
    );
  const getPitchInputEvidenceRef = useRef(getPitchInputEvidence);
  performanceRef.current = performance;
  getPerformanceSeriesRef.current = getPerformanceSeries;
  getPitchInputEvidenceRef.current = getPitchInputEvidence;
  micUserEnabledRef.current = micUserEnabled;
  vocalGainRef.current = vocalGain;
  feedbackModeRef.current = feedbackMode;

  const updateRecordingStatus = useCallback((status: PlaybackMicState["recordingStatus"]) => {
    recordingStatusRef.current = status;
    if (mountedRef.current) setRecordingStatus(status);
  }, []);

  const updateRecordingTake = useCallback((take: RecordingTake | null) => {
    recordingTakeRef.current = take;
    if (mountedRef.current) setRecordingTake(take);
  }, []);

  const recordedPosition = useCallback(async () => {
    const status = await getVocalRecordingStatus();
    return status.sample_rate > 0 ? status.captured_samples / status.sample_rate : 0;
  }, []);

  const closeOpenSegment = useCallback((sourceEnd: number, recordedEnd: number) => {
    const open = openSegmentRef.current;
    openSegmentRef.current = null;
    if (!open) return;
    const segment = {
      source_start: Math.max(0, open.sourceStart),
      source_end: Math.max(0, sourceEnd),
      recorded_start: Math.max(0, open.recordedStart),
      recorded_end: Math.max(0, recordedEnd),
    };
    if (
      segment.source_end - segment.source_start >= 0.01 &&
      segment.recorded_end - segment.recorded_start >= 0.01
    ) {
      transportSegmentsRef.current.push(segment);
    }
  }, []);

  const finalizeRecordingNow = useCallback(
    async (sourceEnd: number, completion: "completed" | "interrupted") => {
      sessionEndedRef.current = true;
      recordingStartedRef.current = false;
      updateRecordingStatus("finalizing");
      try {
        await pauseVocalRecording();
        const position = await recordedPosition();
        closeOpenSegment(sourceEnd, position);
        const take = await stopVocalRecording();
        if (!take) {
          updateRecordingStatus("off");
          return;
        }
        updateRecordingTake(take);

        const recordedDuration = take.recorded_samples / Math.max(1, take.sample_rate);
        const segments = transportSegmentsRef.current
          .map((segment) => ({
            ...segment,
            recorded_end: Math.min(segment.recorded_end, recordedDuration),
          }))
          .filter(
            (segment) =>
              segment.source_end > segment.source_start &&
              segment.recorded_end > segment.recorded_start,
          );
        if (segments.length === 0 && recordedDuration > 0) {
          segments.push({
            source_start: take.playback_start_sec,
            source_end: take.playback_start_sec + recordedDuration,
            recorded_start: 0,
            recorded_end: recordedDuration,
          });
        }

        const scorePayload = performanceRef.current;
        const completedSeries = getPerformanceSeriesRef.current();
        const pitchInput = getPitchInputEvidenceRef.current(micUserEnabledRef.current);
        if (mountedRef.current) setPerformanceSeries(completedSeries);
        try {
          practiceSessionSavedRef.current = true;
          await savePracticeSession({
            id: take.session_id,
            profile: take.profile,
            song_hash: fileHash,
            kind: "karaoke",
            started_at: recordingStartTimeRef.current,
            ended_at: Math.floor(Date.now() / 1000),
            performance_json: JSON.stringify({
              ...scorePayload,
              completion,
              feedback_mode: feedbackModeRef.current,
              mic_latency_compensation_sec:
                config?.mic_latency_compensation_sec ?? DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
              pitch_series: completedSeries,
              pitch_input: pitchInput,
            }),
            recording_take_id: take.id,
            transport_segments: segments,
          });
        } catch (error) {
          practiceSessionSavedRef.current = false;
          const message = error instanceof Error ? error.message : String(error);
          if (mountedRef.current) toast.error(`Session history: ${message}`);
        }

        if (!shouldAutoExportRecording(take.status)) {
          const message = take.error ?? "The vocal recording is incomplete";
          if (mountedRef.current) {
            setRecordingError(message);
            toast.error(`${message}. Your dry vocal is saved in History and can be recovered.`);
          }
          updateRecordingStatus("failed");
          return;
        }

        try {
          const exported = await exportRecording(
            take.id,
            config?.mic_latency_compensation_sec ?? DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
            vocalGainRef.current,
            null,
            segments,
          );
          updateRecordingTake(exported);
          updateRecordingStatus("ready");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (mountedRef.current) {
            setRecordingError(message);
            toast.error(`Export: ${message}. Your dry vocal is still saved.`);
          }
          updateRecordingStatus("failed");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (mountedRef.current) {
          setRecordingError(message);
          toast.error(`Recording: ${message}`);
        }
        updateRecordingStatus("failed");
      } finally {
        finalizingRef.current = false;
      }
    },
    [
      closeOpenSegment,
      config?.mic_latency_compensation_sec,
      fileHash,
      recordedPosition,
      updateRecordingStatus,
      updateRecordingTake,
    ],
  );
  finalizeRecordingRef.current = finalizeRecordingNow;

  const saveUnrecordedPracticeSession = useCallback(
    async (completion: "completed" | "interrupted") => {
      if (practiceSessionSavedRef.current) return;
      const scorePayload = performanceRef.current;
      if (!scorePayload || scorePayload.phrases.length === 0) return;
      const completedSeries = getPerformanceSeriesRef.current();
      const pitchInput = getPitchInputEvidenceRef.current(micUserEnabledRef.current);
      practiceSessionSavedRef.current = true;
      const endedAt = Math.floor(Date.now() / 1000);
      try {
        await savePracticeSession({
          id: `karaoke-${fileHash}-${Date.now()}`,
          profile: profiles?.active ?? "Guest",
          song_hash: fileHash,
          kind: "karaoke",
          started_at: practiceStartTimeRef.current,
          ended_at: endedAt,
          performance_json: JSON.stringify({
            ...scorePayload,
            completion,
            feedback_mode: feedbackModeRef.current,
            mic_latency_compensation_sec:
              config?.mic_latency_compensation_sec ?? DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
            pitch_series: completedSeries,
            pitch_input: pitchInput,
          }),
          recording_take_id: null,
          transport_segments: [],
        });
      } catch (error) {
        practiceSessionSavedRef.current = false;
        if (mountedRef.current) {
          toast.error(`Session history: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    [config?.mic_latency_compensation_sec, fileHash, profiles?.active],
  );

  const handleTransportEvent = useCallback(
    async (event: TransportEvent) => {
      const terminal = event.type === "finish" || event.type === "exit";
      if (!recordingStartedRef.current) {
        if (terminal) {
          await saveUnrecordedPracticeSession(
            event.type === "finish" ? "completed" : "interrupted",
          );
        }
        return;
      }
      if (!terminal && finalizingRef.current) return;
      if (event.type === "pause") {
        await pauseVocalRecording();
        closeOpenSegment(event.sourceTime, await recordedPosition());
        updateRecordingStatus("paused");
        return;
      }
      if (event.type === "resume") {
        openSegmentRef.current = {
          sourceStart: event.sourceTime,
          recordedStart: await recordedPosition(),
        };
        await resumeVocalRecording();
        updateRecordingStatus("recording");
        return;
      }
      if (event.type === "seek") {
        await pauseVocalRecording();
        const position = await recordedPosition();
        closeOpenSegment(event.sourceTime, position);
        if (event.playing) {
          openSegmentRef.current = { sourceStart: event.targetTime, recordedStart: position };
          await resumeVocalRecording();
        }
        return;
      }
      sessionEndedRef.current = true;
      finalizingRef.current = true;
      await finalizeRecordingNow(
        event.sourceTime,
        event.type === "finish" ? "completed" : "interrupted",
      );
    },
    [
      closeOpenSegment,
      finalizeRecordingNow,
      recordedPosition,
      saveUnrecordedPracticeSession,
      updateRecordingStatus,
    ],
  );

  useEffect(
    () =>
      subscribeTransportEvents((event) => {
        if (
          (event.type === "finish" || event.type === "exit") &&
          recordingStartedRef.current &&
          !finalizingRef.current
        ) {
          sessionEndedRef.current = true;
          finalizingRef.current = true;
        }
        transportQueueRef.current = transportQueueRef.current
          .then(() => handleTransportEvent(event))
          .catch((error) => {
            if (mountedRef.current) {
              const message = error instanceof Error ? error.message : String(error);
              setRecordingError(message);
              updateRecordingStatus("failed");
              toast.error(`Recording sync: ${message}`);
            }
          });
      }),
    [handleTransportEvent, subscribeTransportEvents, updateRecordingStatus],
  );

  useEffect(() => {
    if (
      !recordingWanted ||
      !micUserEnabled ||
      !micCaptureActive ||
      !isPlaying ||
      paused ||
      sessionEndedRef.current ||
      recordingStartedRef.current
    ) {
      return;
    }
    recordingStartedRef.current = true;
    finalizingRef.current = false;
    recorderOverrunShown.current = false;
    transportSegmentsRef.current = [];
    openSegmentRef.current = null;
    setPerformanceSeries({ refPitches: [], userPitches: [], similarities: [], timestamps: [] });
    recordingStartTimeRef.current = Math.floor(Date.now() / 1000);
    updateRecordingStatus("arming");
    setRecordingError(null);
    const playbackStart = getCurrentTime();
    transportQueueRef.current = transportQueueRef.current
      .then(async () => {
        const before = await getVocalRecordingStatus();
        const take = await startVocalRecording({
          song_hash: fileHash,
          profile: profiles?.active ?? "Guest",
          title,
          artist,
          playback_time_sec: playbackStart,
        });
        const after = await getVocalRecordingStatus();
        const attachment = planRecordingAttachment(before, after, playbackStart, getCurrentTime());
        if (attachment.resumeNativeRecorder) await resumeVocalRecording();
        updateRecordingTake(take);
        openSegmentRef.current = {
          sourceStart: attachment.sourceStart,
          recordedStart: attachment.recordedStart,
        };
        updateRecordingStatus("recording");
      })
      .catch((error) => {
        recordingStartedRef.current = false;
        const message = error instanceof Error ? error.message : String(error);
        setRecordingError(message);
        updateRecordingStatus("failed");
        toast.error(`Recording: ${message}`);
      });
  }, [
    artist,
    fileHash,
    getCurrentTime,
    isPlaying,
    micCaptureActive,
    micUserEnabled,
    paused,
    profiles?.active,
    recordingWanted,
    title,
    updateRecordingStatus,
    updateRecordingTake,
  ]);

  useEffect(() => {
    if (!isFinished || !recordingStartedRef.current || finalizingRef.current) return;
    sessionEndedRef.current = true;
    finalizingRef.current = true;
    transportQueueRef.current = transportQueueRef.current.then(() =>
      finalizeRecordingNow(duration || getCurrentTime(), "completed"),
    );
  }, [duration, finalizeRecordingNow, getCurrentTime, isFinished]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (recordingStartedRef.current && !finalizingRef.current) {
        sessionEndedRef.current = true;
        finalizingRef.current = true;
        const sourceEnd = getCurrentTime();
        transportQueueRef.current = transportQueueRef.current.then(() =>
          finalizeRecordingRef.current(sourceEnd, "interrupted"),
        );
      }
    };
  }, [getCurrentTime]);

  const micErrorShown = useRef(false);
  useEffect(() => {
    const micError = micCaptureError ?? micPitchError;
    if (micError && !micErrorShown.current) {
      micErrorShown.current = true;
      toast.error(`Microphone: ${micError}`);
    }
    if (!micError) {
      micErrorShown.current = false;
    }
  }, [micCaptureError, micPitchError]);

  const recorderOverrunShown = useRef(false);
  useEffect(() => {
    if (!recordingStartedRef.current || finalizingRef.current) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getVocalRecordingStatus()
        .then((status) => {
          if (cancelled || recorderOverrunShown.current) return;
          if (!status.overrun && !status.error) return;
          recorderOverrunShown.current = true;
          const message =
            status.error ?? "Recording queue overrun; the dry vocal will be marked incomplete";
          setRecordingError(message);
          toast.error(message);
        })
        .catch(() => {});
    }, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [recordingStatus]);

  const handleToggleMic = useCallback(() => {
    setMicUserEnabled((prev) => {
      const next = !prev;
      if (!next && recordingStartedRef.current && !finalizingRef.current) {
        sessionEndedRef.current = true;
        finalizingRef.current = true;
        const sourceEnd = getCurrentTime();
        transportQueueRef.current = transportQueueRef.current.then(() =>
          finalizeRecordingRef.current(sourceEnd, "interrupted"),
        );
      }
      if (!next && micMonitorUserEnabled) {
        setMicMonitorUserEnabled(false);
        persistConfig({ mic_active: false, mic_monitoring: false });
      } else {
        if (next) sessionEndedRef.current = false;
        persistConfig({ mic_active: next });
      }
      return next;
    });
  }, [getCurrentTime, persistConfig, micMonitorUserEnabled]);

  const handleCycleMic = useCallback(() => {
    if (micDevices.length <= 1) return;
    const currentIdx = micDevices.findIndex((d) => d.deviceId === selectedMicId);
    const nextIdx = (currentIdx + 1) % micDevices.length;
    const next = micDevices[nextIdx];
    setSelectedMicId(next.deviceId);
    persistConfig({ preferred_mic: next.deviceId });
  }, [micDevices, selectedMicId, persistConfig]);

  const handleToggleMicMonitor = useCallback(() => {
    setMicMonitorUserEnabled((prev) => {
      const next = !prev;
      persistConfig({ mic_monitoring: next });
      if (next && !micUserEnabled) {
        setMicUserEnabled(true);
        persistConfig({ mic_active: true });
      }
      if (next) {
        toast.info("Mic monitor on — wired headphones recommended");
      }
      return next;
    });
  }, [persistConfig, micUserEnabled]);

  const changeMicMonitorGain = useCallback((gain: number) => {
    const next = Math.max(0, Math.min(2, gain));
    setMicMonitorGainState(next);
    void updateMicMonitorGain(next).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Karaoke voice volume: ${message}`);
    });
  }, []);

  const changeScoringDifficulty = useCallback(
    (difficulty: ScoringDifficulty) => {
      if (selectedScoringDifficulty === difficulty) return;
      if (!isFinished && getCurrentTime() > 0.25) {
        toast.info("Scoring strictness is locked for this performance. Restart to change it.");
        return;
      }
      setSelectedScoringDifficulty(difficulty);
      persistConfig({ scoring_difficulty: difficulty });
      toast.success(`${scoringDifficultyProfile(difficulty).label} scoring selected`);
    },
    [getCurrentTime, isFinished, persistConfig, selectedScoringDifficulty],
  );

  const handleToggleRecording = useCallback(() => {
    setRecordingWanted((current) => {
      const next = !current;
      if (!next && recordingStartedRef.current && !finalizingRef.current) {
        sessionEndedRef.current = true;
        finalizingRef.current = true;
        const sourceEnd = getCurrentTime();
        transportQueueRef.current = transportQueueRef.current.then(() =>
          finalizeRecordingRef.current(sourceEnd, "interrupted"),
        );
      } else if (next) {
        sessionEndedRef.current = false;
        finalizingRef.current = false;
        updateRecordingStatus("off");
        setRecordingError(null);
      }
      return next;
    });
  }, [getCurrentTime, updateRecordingStatus]);

  const retryRecordingExport = useCallback(() => {
    const take = recordingTakeRef.current;
    if (!take || finalizingRef.current) return;
    finalizingRef.current = true;
    updateRecordingStatus("finalizing");
    setRecordingError(null);
    void exportRecording(
      take.id,
      config?.mic_latency_compensation_sec ?? DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
      vocalGainRef.current,
      null,
      transportSegmentsRef.current,
    )
      .then((exported) => {
        updateRecordingTake(exported);
        updateRecordingStatus("ready");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setRecordingError(message);
        updateRecordingStatus("failed");
        toast.error(`Export: ${message}`);
      })
      .finally(() => {
        finalizingRef.current = false;
      });
  }, [config?.mic_latency_compensation_sec, updateRecordingStatus, updateRecordingTake]);

  const setVocalGain = useCallback((gain: number) => {
    const next = Math.max(0, Math.min(2, gain));
    vocalGainRef.current = next;
    setVocalGainState(next);
  }, []);

  const renderRecordingMix = useCallback(() => {
    const take = recordingTakeRef.current;
    if (!take || finalizingRef.current) return;
    finalizingRef.current = true;
    updateRecordingStatus(take.video_path && videoPath ? "exporting-video" : "finalizing");
    setRecordingError(null);
    void exportRecording(
      take.id,
      config?.mic_latency_compensation_sec ?? DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
      vocalGainRef.current,
      take.video_path && videoPath ? videoPath : null,
      transportSegmentsRef.current,
    )
      .then((exported) => {
        updateRecordingTake(exported);
        updateRecordingStatus("ready");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setRecordingError(message);
        updateRecordingStatus("failed");
        toast.error(`Mix export: ${message}`);
      })
      .finally(() => {
        finalizingRef.current = false;
      });
  }, [config?.mic_latency_compensation_sec, updateRecordingStatus, updateRecordingTake, videoPath]);

  const exportRecordingVideo = useCallback(() => {
    const take = recordingTakeRef.current;
    if (!take || !videoPath || finalizingRef.current) return;
    finalizingRef.current = true;
    updateRecordingStatus("exporting-video");
    setRecordingError(null);
    void exportRecording(
      take.id,
      config?.mic_latency_compensation_sec ?? DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
      vocalGainRef.current,
      videoPath,
      transportSegmentsRef.current,
    )
      .then((exported) => {
        if (!exported.video_path) throw new Error("Video export did not create an MP4 file");
        updateRecordingTake(exported);
        updateRecordingStatus("ready");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setRecordingError(message);
        updateRecordingStatus("failed");
        toast.error(`Video export: ${message}`);
      })
      .finally(() => {
        finalizingRef.current = false;
      });
  }, [config?.mic_latency_compensation_sec, updateRecordingStatus, updateRecordingTake, videoPath]);

  const stateValue = useMemo<PlaybackMicState>(() => {
    const micReady = micCaptureActive && micPitchActive && micUserEnabled;
    const strictScoringAvailable = melody?.strict_scoring_available === true;
    return {
      micUserEnabled,
      micMonitorUserEnabled,
      micMonitorGain,
      selectedMicId,
      micName: selectedMicId ?? "Default",
      pitchScore: micReady && strictScoringAvailable ? score : null,
      rawScore: strictScoringAvailable ? score : 0,
      series,
      micCaptureActive,
      micCaptureStatus,
      micPitchActive,
      micReady,
      latestFrame,
      melody,
      performance,
      performanceSeries,
      recordingWanted,
      recordingStatus,
      recordingTake,
      recordingError,
      vocalGain,
      videoExportAvailable: videoPath != null,
      feedbackMode,
      scoringDifficulty: selectedScoringDifficulty,
    };
  }, [
    micUserEnabled,
    micMonitorUserEnabled,
    micMonitorGain,
    selectedMicId,
    score,
    series,
    micCaptureActive,
    micCaptureStatus,
    micPitchActive,
    latestFrame,
    melody,
    performance,
    performanceSeries,
    recordingWanted,
    recordingStatus,
    recordingTake,
    recordingError,
    vocalGain,
    videoPath,
    feedbackMode,
    selectedScoringDifficulty,
  ]);

  const actionsValue = useMemo<PlaybackMicActions>(
    () => ({
      reactiveRef,
      handleToggleMic,
      handleCycleMic,
      handleToggleMicMonitor,
      setMicMonitorGain: changeMicMonitorGain,
      handleToggleRecording,
      setVocalGain,
      renderRecordingMix,
      retryRecordingExport,
      exportRecordingVideo,
      setFeedbackMode,
      setScoringDifficulty: changeScoringDifficulty,
    }),
    [
      reactiveRef,
      handleToggleMic,
      handleCycleMic,
      handleToggleMicMonitor,
      changeMicMonitorGain,
      handleToggleRecording,
      setVocalGain,
      renderRecordingMix,
      retryRecordingExport,
      exportRecordingVideo,
      setFeedbackMode,
      changeScoringDifficulty,
    ],
  );

  return (
    <MicStateContext.Provider value={stateValue}>
      <MicActionsContext.Provider value={actionsValue}>{children}</MicActionsContext.Provider>
    </MicStateContext.Provider>
  );
}

export function usePlaybackMicState(): PlaybackMicState {
  const ctx = useContext(MicStateContext);
  if (!ctx) {
    throw new Error("usePlaybackMicState must be used within a PlaybackMicProvider");
  }
  return ctx;
}

export function usePlaybackMicActions(): PlaybackMicActions {
  const ctx = useContext(MicActionsContext);
  if (!ctx) {
    throw new Error("usePlaybackMicActions must be used within a PlaybackMicProvider");
  }
  return ctx;
}
