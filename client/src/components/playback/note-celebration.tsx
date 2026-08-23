import { usePlaybackMicState } from "@/contexts/playback";
import { noteCelebrationForStreak } from "@/lib/playback/note-celebration";
import { useEffect, useRef, useState } from "react";

interface CompactHit {
  id: number;
  headline: string;
  accent: string;
}

export function NoteCelebration() {
  const { micReady, melody, performance } = usePlaybackMicState();
  const [hit, setHit] = useState<CompactHit | null>(null);
  const previousStreakRef = useRef(0);
  const nextHitIdRef = useRef(1);

  const strictScoring = micReady && melody?.strict_scoring_available === true;

  useEffect(() => {
    const previous = previousStreakRef.current;
    previousStreakRef.current = performance.streak;
    if (!strictScoring || performance.streak <= previous) {
      if (performance.streak < previous) setHit(null);
      return;
    }

    const id = nextHitIdRef.current;
    nextHitIdRef.current += 1;
    const celebration = noteCelebrationForStreak(performance.streak);
    setHit({ id, headline: celebration.headline, accent: celebration.accent });
    const timer = window.setTimeout(() => setHit(null), 720);
    return () => window.clearTimeout(timer);
  }, [performance.streak, strictScoring]);

  if (!strictScoring) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-live="polite">
      <span className="sr-only">
        {hit ? `${hit.headline} ${performance.streak} note combo` : ""}
      </span>

      {performance.streak >= 2 && (
        <div
          key={performance.streak}
          className="nightingale-combo-badge absolute bottom-2 left-3 flex items-baseline gap-1 rounded-full border border-cyan-200/35 bg-black/65 px-2 py-1 text-white shadow-[0_0_16px_rgba(103,232,249,0.3)] backdrop-blur-md"
        >
          <span className="text-base font-black tabular-nums tracking-tight text-cyan-200">
            ×{performance.streak}
          </span>
          <span className="text-[0.55rem] font-bold tracking-[0.14em] text-white/80">COMBO</span>
        </div>
      )}

      {hit && (
        <div
          key={hit.id}
          className="nightingale-compact-hit absolute bottom-10 left-3 text-xs font-black italic tracking-wide drop-shadow-[0_2px_5px_rgba(0,0,0,0.95)]"
          style={{ color: hit.accent }}
          aria-hidden
        >
          {hit.headline}
        </div>
      )}
    </div>
  );
}
