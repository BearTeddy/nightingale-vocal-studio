import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useMenuFocus } from "@/contexts/menu-focus-context";
import { GraduationCap } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router";

interface StudioActionProps {
  focusedSidebarIndex: number;
  registerCallback: (callback: (() => void) | null) => void;
}

export function StudioAction({ focusedSidebarIndex, registerCallback }: StudioActionProps) {
  const navigate = useNavigate();
  const { focus } = useMenuFocus();
  const open = () => navigate("/studio");

  useEffect(() => {
    registerCallback(open);
    return () => registerCallback(null);
  }, [registerCallback]);

  const focused =
    focus.active && focus.panel === "sidebar" && focus.sidebarIndex === focusedSidebarIndex;

  return (
    <SidebarGroup className="py-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            data-sidebar-nav-index={focusedSidebarIndex}
            className={focused ? "ring-2 ring-primary bg-sidebar-accent" : ""}
            onClick={open}
          >
            <GraduationCap className="size-4" />
            <span>Vocal Studio</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}
