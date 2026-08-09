import { useNavInput, type NavAction } from "@/hooks/navigation/use-nav-input";
import { DIALOG_FOCUSABLE_SELECTOR } from "@/hooks/navigation/use-dialog-nav";
import {
  findStudioNavigationTarget,
  type StudioNavigationDirection,
} from "@/lib/studio-navigation";
import { useCallback, useEffect, type RefObject } from "react";

const MANAGED_WIDGET_SELECTOR = '[role="menu"], [role="listbox"]';
const FOCUSED_ATTRIBUTE = "data-spatial-nav-focused";

function visibleFocusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      (element.offsetWidth > 0 || element.offsetHeight > 0),
  );
}

function directionFromAction(action: NavAction): StudioNavigationDirection | null {
  if (action.up) return "up";
  if (action.down) return "down";
  if (action.left) return "left";
  if (action.right) return "right";
  return null;
}

function dispatchManagedWidgetAction(element: HTMLElement, action: NavAction): void {
  let key: string | null = null;
  if (action.up) key = "ArrowUp";
  else if (action.down) key = "ArrowDown";
  else if (action.left) key = "ArrowLeft";
  else if (action.right) key = "ArrowRight";
  else if (action.confirm) key = "Enter";
  else if (action.back) key = "Escape";
  if (key) element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function markFocused(container: HTMLElement, target: HTMLElement): void {
  for (const element of container.querySelectorAll<HTMLElement>(`[${FOCUSED_ATTRIBUTE}]`)) {
    element.removeAttribute(FOCUSED_ATTRIBUTE);
  }
  target.setAttribute(FOCUSED_ATTRIBUTE, "true");
}

function focusControl(container: HTMLElement, target: HTMLElement): void {
  markFocused(container, target);
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function initialControl(
  container: HTMLElement,
  focusables: readonly HTMLElement[],
): HTMLElement | null {
  const currentTab = container.querySelector<HTMLElement>('[aria-current="page"]');
  return (currentTab && focusables.includes(currentTab) ? currentTab : focusables[0]) ?? null;
}

export function useSpatialNavigation(
  containerRef: RefObject<HTMLElement | null>,
  onBack: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && container.contains(target))
        markFocused(container, target);
    };
    container.addEventListener("focusin", onFocusIn);
    return () => {
      container.removeEventListener("focusin", onFocusIn);
      for (const element of container.querySelectorAll<HTMLElement>(`[${FOCUSED_ATTRIBUTE}]`)) {
        element.removeAttribute(FOCUSED_ATTRIBUTE);
      }
    };
  }, [containerRef, enabled]);

  useNavInput(
    useCallback(
      (action) => {
        if (!enabled) return false;
        const container = containerRef.current;
        if (!container) return false;
        const activeElement = document.activeElement;
        if (
          activeElement instanceof HTMLElement &&
          activeElement.closest(MANAGED_WIDGET_SELECTOR)
        ) {
          dispatchManagedWidgetAction(activeElement, action);
          return true;
        }
        if (
          activeElement instanceof HTMLElement &&
          activeElement.closest('[role="slider"]') &&
          (action.left || action.right)
        ) {
          dispatchManagedWidgetAction(activeElement, action);
          return true;
        }
        if (action.back) {
          onBack();
          return true;
        }

        const focusables = visibleFocusables(container);
        if (focusables.length === 0) return true;
        const currentIndex =
          activeElement instanceof HTMLElement ? focusables.indexOf(activeElement) : -1;
        if (action.confirm) {
          if (currentIndex >= 0) focusables[currentIndex].click();
          else {
            const initial = initialControl(container, focusables);
            if (initial) focusControl(container, initial);
          }
          return true;
        }

        const direction = directionFromAction(action);
        if (!direction) return false;
        if (currentIndex < 0) {
          const initial = initialControl(container, focusables);
          if (initial) focusControl(container, initial);
          return true;
        }
        const nextIndex = findStudioNavigationTarget(
          focusables.map((element) => element.getBoundingClientRect()),
          currentIndex,
          direction,
        );
        const next = focusables[nextIndex];
        if (next) focusControl(container, next);
        return true;
      },
      [containerRef, enabled, onBack],
    ),
  );
}

export function useStudioNavigation(
  containerRef: RefObject<HTMLElement | null>,
  onBack: () => void,
): void {
  useSpatialNavigation(containerRef, onBack, true);
}
