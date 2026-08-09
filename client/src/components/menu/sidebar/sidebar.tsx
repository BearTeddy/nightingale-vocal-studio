import {
  Sidebar as ShadCnSidebar,
  SidebarFooter,
  SidebarProvider,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { Stats } from "./stats";
import { Header } from "./header";
import { MainNavigation } from "./main-navigation";
import { Actions } from "./actions";
import { StudioAction } from "./studio-action";
import { useMenuFocus } from "@/contexts/menu-focus-context";
import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from "react";

const THEME_SLOT_INDEX = 0;
const FOLDER_SLOT_INDEX = THEME_SLOT_INDEX + 1;
const MAIN_NAV_BASE_INDEX = FOLDER_SLOT_INDEX + 1;

type SidebarCallback = () => void;
type SidebarSubCallback = (subIndex: number) => void;

export const Sidebar = ({ children }: PropsWithChildren<{}>) => {
  const { focus, actionsRef, setFocus } = useMenuFocus();
  const [mainNavigationCallbacks, setMainNavigationCallbacks] = useState<SidebarCallback[]>([]);

  const focusRef = useRef(focus);
  const themeCallbackRef = useRef<SidebarCallback | null>(null);
  const folderCallbackRef = useRef<SidebarSubCallback | null>(null);
  const studioCallbackRef = useRef<SidebarCallback | null>(null);
  const cacheCallbackRef = useRef<SidebarSubCallback | null>(null);
  const actionsCallbackRef = useRef<SidebarCallback | null>(null);

  focusRef.current = focus;

  const studioSlotIndex = MAIN_NAV_BASE_INDEX + mainNavigationCallbacks.length;
  const cacheSlotIndex = studioSlotIndex + 1;
  const actionsSlotIndex = cacheSlotIndex + 1;
  const sidebarCount = actionsSlotIndex + 1;

  const registerThemeCallback = useCallback((callback: (() => void) | null) => {
    themeCallbackRef.current = callback;
  }, []);

  const registerMainNavigationCallbacks = useCallback((callbacks: SidebarCallback[]) => {
    setMainNavigationCallbacks(callbacks);
  }, []);

  const registerFolderCallback = useCallback((callback: SidebarSubCallback | null) => {
    folderCallbackRef.current = callback;
  }, []);

  const registerStudioCallback = useCallback((callback: SidebarCallback | null) => {
    studioCallbackRef.current = callback;
  }, []);

  const registerCacheCallback = useCallback((callback: SidebarSubCallback | null) => {
    cacheCallbackRef.current = callback;
  }, []);

  const registerActionsCallback = useCallback((callback: SidebarCallback | null) => {
    actionsCallbackRef.current = callback;
  }, []);

  const confirmSidebarSlot = useCallback(
    (index: number) => {
      if (index === THEME_SLOT_INDEX) {
        themeCallbackRef.current?.();
        return;
      }

      if (index === FOLDER_SLOT_INDEX) {
        folderCallbackRef.current?.(focusRef.current.sidebarSubIndex);
        return;
      }

      if (index >= MAIN_NAV_BASE_INDEX && index < cacheSlotIndex) {
        mainNavigationCallbacks[index - MAIN_NAV_BASE_INDEX]?.();
        return;
      }

      if (index === studioSlotIndex) {
        studioCallbackRef.current?.();
        return;
      }

      if (index === cacheSlotIndex) {
        cacheCallbackRef.current?.(focusRef.current.sidebarSubIndex);
        return;
      }

      if (index === actionsSlotIndex) {
        actionsCallbackRef.current?.();
      }
    },
    [actionsSlotIndex, cacheSlotIndex, mainNavigationCallbacks, studioSlotIndex],
  );

  const clampSidebarFocus = useCallback(() => {
    setFocus((prev) => {
      const sidebarIndex = Math.min(prev.sidebarIndex, sidebarCount - 1);
      return sidebarIndex === prev.sidebarIndex ? prev : { ...prev, sidebarIndex };
    });
  }, [setFocus, sidebarCount]);

  useEffect(() => {
    actionsRef.current.sidebarCount = sidebarCount;
    actionsRef.current.onConfirmSidebar = confirmSidebarSlot;
    clampSidebarFocus();

    return () => {
      actionsRef.current.onConfirmSidebar = null;
      actionsRef.current.sidebarCount = 0;
    };
  }, [actionsRef, clampSidebarFocus, confirmSidebarSlot, sidebarCount]);

  return (
    <SidebarProvider>
      <ShadCnSidebar>
        <Header focusedSidebarIndex={THEME_SLOT_INDEX} registerCallback={registerThemeCallback} />

        <MainNavigation
          baseIndex={MAIN_NAV_BASE_INDEX}
          registerCallbacks={registerMainNavigationCallbacks}
          folderFocusedSidebarIndex={FOLDER_SLOT_INDEX}
          registerFolderCallback={registerFolderCallback}
        />

        <StudioAction
          focusedSidebarIndex={studioSlotIndex}
          registerCallback={registerStudioCallback}
        />

        <SidebarFooter>
          <Stats
            cacheFocusedSidebarIndex={cacheSlotIndex}
            registerCacheCallback={registerCacheCallback}
          />
          <SidebarSeparator />
          <Actions
            focusedSidebarIndex={actionsSlotIndex}
            registerCallback={registerActionsCallback}
          />
        </SidebarFooter>
      </ShadCnSidebar>
      {children}
    </SidebarProvider>
  );
};
