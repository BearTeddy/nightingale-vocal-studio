import { Button } from "@/components/ui/button";
import { Play } from "lucide-react";

interface PauseOverlayProps {
  open: boolean;
  onContinue: () => void;
}

export const PauseOverlay = ({ open, onContinue }: PauseOverlayProps) => {
  if (!open) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <Button
        type="button"
        size="lg"
        className="pointer-events-auto h-11 gap-2 border border-white/20 bg-black/75 px-4 text-sm text-white shadow-lg backdrop-blur-md hover:bg-black/85"
        onClick={onContinue}
      >
        <Play className="size-4 fill-current" />
        Paused
      </Button>
    </div>
  );
};
