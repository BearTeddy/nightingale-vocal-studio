/**
 * Drives the end-of-song result dialog: watches transport.isFinished + the
 * skip-outro pending flag, persists the run's score to the active profile,
 * plays the success chime, and exposes the props the result dialog needs.
 */

import successSoundUrl from "@/assets/sounds/success.mp3";
import {
  usePlaybackMicState,
  usePlaybackTranscriptActions,
  usePlaybackTranscriptState,
  usePlaybackTransportActions,
  usePlaybackTransportState,
} from "@/contexts/playback";
import { PROFILES } from "@/queries/keys";
import { useProfiles } from "@/queries/use-profiles";
import { addScore } from "@/bridge/profile";
import type { ScoreRecord } from "@/types/ScoreRecord";
import type { Song } from "@/types/Song";
import type { PerformanceScore } from "@/types/PerformanceScore";
import type { RecordingTake } from "@/types/RecordingTake";
import type { MelodyMap } from "@/types/MelodyMap";
import type { PitchSeries } from "@/lib/pitch/state";
import {
  personalBestForRun,
  strictRawScore,
  type PersonalBestComparison,
} from "@/utils/playback/result";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

export interface PlaybackResult {
  open: boolean;
  score: number;
  performance: PerformanceScore;
  performanceSeries: PitchSeries;
  melody: MelodyMap | null;
  recordingTake: RecordingTake | null;
  recordingStatus: string;
  recordingError: string | null;
  scores: ScoreRecord[];
  activeProfile: string | null;
  personalBest: PersonalBestComparison | null;
  onFinish: () => void;
}

export function usePlaybackResult(song: Song): PlaybackResult {
  const fileHash = song.file_hash;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: profileData, isLoading: profilesLoading } = useProfiles();

  const { isFinished } = usePlaybackTransportState();
  const { handleExit } = usePlaybackTransportActions();
  const { performance, performanceSeries, melody, recordingTake, recordingStatus, recordingError } =
    usePlaybackMicState();
  const { skipOutroPending } = usePlaybackTranscriptState();
  const { clearSkipOutroPending } = usePlaybackTranscriptActions();

  const [showResult, setShowResult] = useState(false);
  const [resultScore, setResultScore] = useState(0);
  const [personalBest, setPersonalBest] = useState<PersonalBestComparison | null>(null);

  const finishHandledRef = useRef(false);

  useEffect(() => {
    if (!isFinished && !skipOutroPending) {
      return;
    }

    if (profilesLoading && !profileData) {
      return;
    }

    if (finishHandledRef.current) {
      return;
    }

    finishHandledRef.current = true;
    clearSkipOutroPending();

    const finalScore = strictRawScore(melody, performance);
    const active = profileData?.active ?? null;
    const shouldShowResult = finalScore > 0 || recordingTake != null || recordingStatus !== "off";

    if (!shouldShowResult) {
      navigate("/", { replace: true });
      return;
    }

    void (async () => {
      try {
        setPersonalBest(
          active != null && finalScore > 0
            ? personalBestForRun(
                profileData?.scores ?? [],
                fileHash,
                active,
                finalScore,
                performance.scoring_difficulty,
                performance.pitch_tolerance_factor,
              )
            : null,
        );
        if (active != null && finalScore > 0) {
          await addScore(
            fileHash,
            finalScore,
            performance.scoring_difficulty,
            performance.pitch_tolerance_factor,
          );
          await queryClient.invalidateQueries({ queryKey: PROFILES });
        }
        setResultScore(performance.overall);
        setShowResult(true);
      } catch (e) {
        toast.error(`Could not save score: ${e instanceof Error ? e.message : String(e)}`);
        navigate("/", { replace: true });
      }
    })();
  }, [
    isFinished,
    skipOutroPending,
    fileHash,
    navigate,
    profileData,
    profilesLoading,
    queryClient,
    clearSkipOutroPending,
    performance,
    performanceSeries,
    melody,
    recordingStatus,
    recordingTake,
  ]);

  useEffect(() => {
    if (!showResult) {
      return;
    }

    const audioEl = new Audio(successSoundUrl);
    void audioEl.play().catch(() => {});

    return () => {
      audioEl.pause();
      audioEl.src = "";
    };
  }, [showResult]);

  const onFinish = useCallback(() => {
    setShowResult(false);
    handleExit();
  }, [handleExit]);

  return {
    open: showResult,
    score: resultScore,
    performance,
    performanceSeries,
    melody,
    recordingTake,
    recordingStatus,
    recordingError,
    scores: profileData?.scores ?? [],
    activeProfile: profileData?.active ?? null,
    personalBest,
    onFinish,
  };
}
