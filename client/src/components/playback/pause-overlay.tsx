import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDialogNav } from "@/hooks/navigation/use-dialog-nav";
import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

const RING = "ring-2 ring-primary";
const NO_FOCUS_RING = "focus-visible:ring-0 focus-visible:border-transparent";

interface PauseOverlayProps {
  open: boolean;
  onExit: () => void;
  onContinue: () => void;
}

export const PauseOverlay = ({ open, onExit, onContinue }: PauseOverlayProps) => {
  const exitingRef = useRef(false);
  const handleExit = useCallback(() => {
    exitingRef.current = true;
    onExit();
  }, [onExit]);

  const onConfirm = useCallback(
    (index: number) => {
      if (index === 0) {
        onContinue();
      } else {
        handleExit();
      }
    },
    [handleExit, onContinue],
  );

  const { focusedIndex } = useDialogNav({
    open,
    itemCount: 2,
    onConfirm,
    onBack: onContinue,
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) return;
        if (exitingRef.current) return;
        onContinue();
      }}
    >
      <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Paused</AlertDialogTitle>
          <AlertDialogDescription>
            Your current score and recording will be saved before returning to the library.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            className={cn(NO_FOCUS_RING, open && focusedIndex === 0 && RING)}
          >
            Continue
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={handleExit}
            className={cn(NO_FOCUS_RING, open && focusedIndex === 1 && RING)}
          >
            Exit to Menu
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
