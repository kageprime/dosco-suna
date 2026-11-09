import type { Icon } from '@phosphor-icons/react';
import { create } from 'zustand';

/** One row of the Workspace settings rail, as the project sidebar draws it. */
export interface WorkspaceSettingsRailRow {
  key: string;
  href: string;
  label: string;
  icon: Icon;
  /** Leaves Workspace settings (Capture): never the active row. */
  linkOut?: boolean;
}

export interface WorkspaceSettingsRailGroup {
  id: string;
  /** Absent: the group draws no heading (the Support footer). */
  label?: string;
  rows: WorkspaceSettingsRailRow[];
}

/**
 * The rail Workspace settings computes (`ProjectAdminDashboard`), published so
 * the project sidebar can drill into it. The page owns the rules for who sees
 * which row; the sidebar only draws what is here.
 *
 * The last rail stays after the page unmounts. The sidebar still draws it
 * while it slides back to the main nav, and the next visit starts from it
 * instead of a skeleton. `projectId` keeps one project's rail out of another.
 */
export interface WorkspaceSettingsRail {
  projectId: string;
  groups: WorkspaceSettingsRailGroup[];
  /** The Support group (Help), drawn under the groups. */
  footer: WorkspaceSettingsRailGroup | null;
  active: string | undefined;
}

interface WorkspaceSettingsRailState {
  rail: WorkspaceSettingsRail | null;
  setRail: (rail: WorkspaceSettingsRail) => void;
  /**
   * Per project, the page the sidebar's Back row returns to: its last
   * non-settings URL. Absent: the project home.
   */
  returnTo: Record<string, string>;
  setReturnTo: (projectId: string, href: string) => void;
  /**
   * The project sidebar is docked open on the desktop, so on a settings route
   * it shows this rail. The page then hides its own rail: one rail on screen,
   * never two. A host without the project sidebar never sets it, so its page
   * keeps the rail.
   */
  sidebarDocked: boolean;
  setSidebarDocked: (sidebarDocked: boolean) => void;
  /**
   * A settings search result waiting to land: once `section` is on screen,
   * the page scrolls to `text` and marks it (`useSettingsSearchLanding`).
   */
  pendingFind: { projectId: string; section: string; text: string } | null;
  setPendingFind: (pendingFind: { projectId: string; section: string; text: string } | null) => void;
}

export const useWorkspaceSettingsRailStore = create<WorkspaceSettingsRailState>((set) => ({
  rail: null,
  setRail: (rail) => set({ rail }),
  returnTo: {},
  setReturnTo: (projectId, href) =>
    set((state) => (state.returnTo[projectId] === href ? state : { returnTo: { ...state.returnTo, [projectId]: href } })),
  sidebarDocked: false,
  setSidebarDocked: (sidebarDocked) => set({ sidebarDocked }),
  pendingFind: null,
  setPendingFind: (pendingFind) => set({ pendingFind }),
}));
