import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  LEARNING_STAGES,
  buildDailyPlan,
  type AssistPreset,
  type AttemptKind,
  type SkillProgress,
} from "@/lib/learning";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Ear,
  LibraryBig,
  Mic2,
  Route,
  Sparkles,
} from "lucide-react";
import { useMemo } from "react";

interface LearningHomeProps {
  progress: readonly SkillProgress[];
  comfortableRange: string | null;
  onOpenSetup: () => void;
  onStartLesson: (lessonId: string, assistPreset?: AssistPreset, attemptKind?: AttemptKind) => void;
  onOpenTechnique: () => void;
  onOpenSongs: () => void;
  onOpenProgress: () => void;
}

const MASTERY_VALUE: Record<SkillProgress["mastery"], number> = {
  new: 0,
  practicing: 25,
  assisted: 50,
  independent: 75,
  transferred: 100,
};

function stageProgress(
  stageId: (typeof LEARNING_STAGES)[number]["id"],
  progress: readonly SkillProgress[],
) {
  const stage = LEARNING_STAGES.find((candidate) => candidate.id === stageId);
  if (!stage) return 0;
  const values = stage.coreSkills.map(
    (skillId) => MASTERY_VALUE[progress.find((item) => item.skillId === skillId)?.mastery ?? "new"],
  );
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

export function LearningHome({
  progress,
  comfortableRange,
  onOpenSetup,
  onStartLesson,
  onOpenTechnique,
  onOpenSongs,
  onOpenProgress,
}: LearningHomeProps) {
  const dailyPlan = useMemo(() => buildDailyPlan({ nowMs: Date.now(), progress }), [progress]);
  const stage =
    LEARNING_STAGES.find((candidate) => candidate.id === dailyPlan.stage) ?? LEARNING_STAGES[0];

  const handlePlanItem = (item: (typeof dailyPlan.items)[number]) => {
    if (item.lessonId) {
      const attemptKind: AttemptKind =
        item.kind === "review" ? "review" : item.kind === "transfer" ? "transfer" : "lesson";
      onStartLesson(item.lessonId, item.assistPreset, attemptKind);
    } else if (item.kind === "check-in") onOpenSetup();
    else onOpenProgress();
  };

  return (
    <section className="py-7">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-primary">
            <Route className="size-4" /> STAGE {stage.order}: {stage.title.toUpperCase()}
          </div>
          <h2 className="mt-2 max-w-3xl text-3xl font-semibold tracking-tight">
            Today, build one skill and use it somewhere real.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {stage.summary} Help fades as your control becomes repeatable, but every exercise stays
            available whenever you want it.
          </p>

          <div className="mt-7 border-y border-border">
            {dailyPlan.items.map((item, index) => (
              <button
                key={`${item.kind}-${item.lessonId ?? item.title}`}
                type="button"
                onClick={() => handlePlanItem(item)}
                className="group grid w-full grid-cols-[2.5rem_minmax(0,1fr)_4rem_1.5rem] items-center gap-3 border-b border-border px-2 py-3 text-left last:border-b-0 hover:bg-muted/50"
              >
                <span className="flex size-8 items-center justify-center border border-border text-xs font-semibold tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{item.title}</span>
                  <span className="mt-0.5 block text-xs capitalize text-muted-foreground">
                    {item.kind.replace("-", " ")}
                    {item.assistPreset ? ` · ${item.assistPreset} guide` : ""}
                    {item.due ? " · due today" : ""}
                  </span>
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                  <Clock3 className="size-3.5" /> {item.minutes}m
                </span>
                <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>

          <div className="mt-7 grid gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={onOpenTechnique}
              className="border border-border p-4 text-left hover:bg-muted/50"
            >
              <Sparkles className="size-5 text-primary" />
              <span className="mt-4 block text-sm font-medium">Higher notes and voice control</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                Move one semitone at a time, then compare tongue, jaw, lip, and vowel experiments.
              </span>
            </button>
            <button
              type="button"
              onClick={() => onStartLesson("pitch-imitation.single-note-echo")}
              className="border border-border p-4 text-left hover:bg-muted/50"
            >
              <Ear className="size-5 text-primary" />
              <span className="mt-4 block text-sm font-medium">Pitch imitation</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                Hear a note, wait, then echo it in a comfortable part of your voice.
              </span>
            </button>
            <button
              type="button"
              onClick={onOpenSongs}
              className="border border-border p-4 text-left hover:bg-muted/50"
            >
              <LibraryBig className="size-5 text-primary" />
              <span className="mt-4 block text-sm font-medium">Song Coach</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                Transfer the current skill into short loops from analyzed songs.
              </span>
            </button>
          </div>
        </div>

        <aside className="border-l border-border pl-6">
          <p className="text-xs font-medium text-muted-foreground">TODAY’S SETUP</p>
          <div className="mt-3 flex items-start gap-3">
            <Mic2 className="mt-0.5 size-5 text-primary" />
            <div>
              <p className="text-sm font-medium">
                {comfortableRange ? "Comfortable range ready" : "Set up your comfortable range"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {comfortableRange ?? "No range is used until the short setup is complete."}
              </p>
            </div>
          </div>
          <Button type="button" variant="outline" className="mt-4 w-full" onClick={onOpenSetup}>
            {comfortableRange ? "Repeat setup" : "Start Stage 0 setup"}
          </Button>

          <div className="mt-7 flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-muted-foreground">SKILL MAP</p>
            <button
              type="button"
              onClick={onOpenProgress}
              className="text-xs text-primary hover:underline"
            >
              Details
            </button>
          </div>
          <div className="mt-3 space-y-3">
            {LEARNING_STAGES.map((definition) => {
              const value = stageProgress(definition.id, progress);
              return (
                <div key={definition.id}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                    <span
                      className={
                        definition.id === stage.id ? "font-medium" : "text-muted-foreground"
                      }
                    >
                      {definition.order}. {definition.title}
                    </span>
                    {value === 100 ? (
                      <CheckCircle2 className="size-3.5 text-emerald-500" />
                    ) : (
                      <span className="text-muted-foreground tabular-nums">
                        {Math.round(value)}%
                      </span>
                    )}
                  </div>
                  <Progress value={value} className="h-1 rounded-none" />
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </section>
  );
}
