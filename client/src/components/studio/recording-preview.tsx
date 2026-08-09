import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import type { RecordingPreviewController } from "@/hooks/use-recording-preview";
import { formatRecordingPreviewTime } from "@/lib/recording-preview";
import { LoaderCircle, Pause, Play, X } from "lucide-react";

export function RecordingPreview({ preview }: { preview: RecordingPreviewController }) {
  if (!preview.path) return null;

  return (
    <div
      className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-y border-border py-3"
      role="region"
      aria-label="Recording preview"
    >
      <Button
        type="button"
        size="icon"
        variant="outline"
        title={preview.playing ? "Pause recording preview" : "Play recording preview"}
        disabled={preview.loading && !preview.playing}
        onClick={() => void preview.toggle()}
      >
        {preview.loading && !preview.playing ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : preview.playing ? (
          <Pause className="size-4" />
        ) : (
          <Play className="size-4" />
        )}
      </Button>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium" title={preview.label}>
          {preview.label}
        </p>
        <Slider
          className="mt-2"
          aria-label="Recording preview position"
          min={0}
          max={Math.max(0.01, preview.duration)}
          step={0.1}
          value={[Math.min(preview.currentTime, Math.max(0.01, preview.duration))]}
          disabled={preview.duration <= 0 || preview.error != null}
          onValueChange={(values) => preview.seek(values[0] ?? 0)}
        />
      </div>
      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {formatRecordingPreviewTime(preview.currentTime)} /{" "}
        {formatRecordingPreviewTime(preview.duration)}
      </span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        title="Close recording preview"
        onClick={preview.stop}
      >
        <X className="size-4" />
      </Button>
      {preview.error && (
        <p className="col-span-full text-xs text-destructive" role="alert">
          Preview: {preview.error}
        </p>
      )}
    </div>
  );
}
