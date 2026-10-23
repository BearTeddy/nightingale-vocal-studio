import { useEffect, useId, useState } from "react";
import {
  MAX_PITCH_TOLERANCE_FACTOR,
  MIN_PITCH_TOLERANCE_FACTOR,
  PITCH_TOLERANCE_FACTOR_STEP,
  pitchToleranceFactor,
  scoringDifficultyProfile,
  type ScoringDifficulty,
} from "@/lib/pitch/difficulty";

interface Props {
  value: number;
  difficulty: ScoringDifficulty;
  onChange: (factor: number) => void;
  className?: string;
  compact?: boolean;
  disabled?: boolean;
}

export function PitchToleranceControl({
  value,
  difficulty,
  onChange,
  className,
  compact,
  disabled,
}: Props) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const profile = scoringDifficultyProfile(difficulty, draft);
  const commit = (raw: string) => {
    const next = pitchToleranceFactor(Number(raw));
    if (next !== value) onChange(next);
  };

  return (
    <div
      className={
        compact
          ? "w-64 max-w-[70vw] space-y-1 border border-white/20 bg-black/75 px-3 py-2 text-white"
          : "space-y-2"
      }
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <label htmlFor={id} className="font-medium">
          Pitch catching
        </label>
        <output htmlFor={id} className="tabular-nums">
          {draft.toFixed(2)}× · ±{Math.round(profile.fullCreditCents)} cents
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={MIN_PITCH_TOLERANCE_FACTOR}
        max={MAX_PITCH_TOLERANCE_FACTOR}
        step={PITCH_TOLERANCE_FACTOR_STEP}
        value={draft}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        aria-valuetext={`${draft.toFixed(2)} times forgiveness; full pitch credit within ${Math.round(profile.fullCreditCents)} cents`}
        className={`h-6 w-full cursor-pointer accent-cyan-400 disabled:cursor-default disabled:opacity-50 ${className ?? ""}`}
        onChange={(event) => setDraft(pitchToleranceFactor(Number(event.currentTarget.value)))}
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerCancel={() => setDraft(value)}
        onPointerUp={(event) => commit(event.currentTarget.value)}
        onKeyUp={(event) => commit(event.currentTarget.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
      />
      <div className="flex justify-between text-xs opacity-80">
        <span>Hard · 0.50×</span>
        <span>Easy · 2.00×</span>
      </div>
      <p id={`${id}-hint`} className="text-xs opacity-75">
        {compact
          ? "Adjust anytime · score recalculates on release"
          : `${profile.label} base. Higher values widen the scoring window. 1.00× is the default. This does not change your detected voice or microphone sensitivity.`}
      </p>
    </div>
  );
}
