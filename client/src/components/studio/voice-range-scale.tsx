import {
  VOCAL_RANGE_REFERENCES,
  VOCAL_SCALE_HIGH_MIDI,
  VOCAL_SCALE_LOW_MIDI,
  vocalRangePlacement,
} from "@/lib/voice-range";

interface VoiceRangeScaleProps {
  lowMidi: number | null;
  highMidi: number | null;
  tessituraLowMidi: number | null;
  tessituraHighMidi: number | null;
  midiName: (midi: number | null) => string;
}

const OCTAVE_TICKS = [36, 48, 60, 72, 84] as const;

interface RangeRowProps {
  label: string;
  lowMidi: number;
  highMidi: number;
  midiName: VoiceRangeScaleProps["midiName"];
  emphasis?: "range" | "tessitura";
}

function RangeTrack({ label, lowMidi, highMidi, midiName, emphasis }: RangeRowProps) {
  const placement = vocalRangePlacement(lowMidi, highMidi);
  const barClass =
    emphasis === "range"
      ? "bg-emerald-500"
      : emphasis === "tessitura"
        ? "bg-cyan-500"
        : "bg-muted-foreground/40";

  return (
    <div className="grid min-w-[36rem] grid-cols-[7rem_minmax(20rem,1fr)_5rem] items-center gap-3 py-1.5">
      <span className={`text-xs ${emphasis ? "font-semibold" : "text-muted-foreground"}`}>
        {label}
      </span>
      <div className="relative h-5 border-x border-border" aria-hidden="true">
        {OCTAVE_TICKS.map((midi) => (
          <span
            key={midi}
            className="absolute inset-y-0 border-l border-border/70"
            style={{
              left: `${((midi - VOCAL_SCALE_LOW_MIDI) / (VOCAL_SCALE_HIGH_MIDI - VOCAL_SCALE_LOW_MIDI)) * 100}%`,
            }}
          />
        ))}
        <span
          className={`absolute top-1/2 h-2.5 -translate-y-1/2 ${barClass}`}
          style={{ left: `${placement.leftPercent}%`, width: `${placement.widthPercent}%` }}
        />
      </div>
      <span className="text-right text-xs tabular-nums text-muted-foreground">
        {midiName(lowMidi)}-{midiName(highMidi)}
      </span>
    </div>
  );
}

export function VoiceRangeScale({
  lowMidi,
  highMidi,
  tessituraLowMidi,
  tessituraHighMidi,
  midiName,
}: VoiceRangeScaleProps) {
  const hasMeasuredRange =
    lowMidi != null && highMidi != null && tessituraLowMidi != null && tessituraHighMidi != null;

  return (
    <section className="mt-8 border-y border-border py-6" aria-labelledby="voice-range-scale-title">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id="voice-range-scale-title" className="text-sm font-semibold">
            Full vocal range scale
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Approximate ensemble references. Range alone does not assign a voice type.
          </p>
        </div>
        {hasMeasuredRange && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-4 bg-emerald-500" /> Comfortable range
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-4 bg-cyan-500" /> Tessitura
            </span>
          </div>
        )}
      </div>

      <div className="mt-5 overflow-x-auto pb-2">
        <div className="grid min-w-[36rem] grid-cols-[7rem_minmax(20rem,1fr)_5rem] gap-3 text-xs text-muted-foreground">
          <span>Reference</span>
          <div className="relative h-5" aria-hidden="true">
            {OCTAVE_TICKS.map((midi) => (
              <span
                key={midi}
                className="absolute -translate-x-1/2 tabular-nums first:translate-x-0 last:-translate-x-full"
                style={{
                  left: `${((midi - VOCAL_SCALE_LOW_MIDI) / (VOCAL_SCALE_HIGH_MIDI - VOCAL_SCALE_LOW_MIDI)) * 100}%`,
                }}
              >
                {midiName(midi)}
              </span>
            ))}
          </div>
          <span className="text-right">Notes</span>
        </div>

        {hasMeasuredRange && (
          <div className="mt-1 border-y border-border py-1">
            <RangeTrack
              label="Your range"
              lowMidi={lowMidi}
              highMidi={highMidi}
              midiName={midiName}
              emphasis="range"
            />
            <RangeTrack
              label="Your tessitura"
              lowMidi={tessituraLowMidi}
              highMidi={tessituraHighMidi}
              midiName={midiName}
              emphasis="tessitura"
            />
          </div>
        )}

        <div className={hasMeasuredRange ? "mt-1" : "mt-1 border-t border-border pt-1"}>
          {VOCAL_RANGE_REFERENCES.map((range) => (
            <RangeTrack key={range.id} {...range} midiName={midiName} />
          ))}
        </div>
      </div>

      <p className="mt-3 max-w-3xl text-xs leading-relaxed text-muted-foreground">
        Classification also considers where the voice is comfortable, tone, register transitions,
        age, and training. Very low and high specialist ranges can extend beyond C2-C6.
      </p>
    </section>
  );
}
