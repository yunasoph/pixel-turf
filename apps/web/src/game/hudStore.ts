import { create } from "zustand";

export type Phase = "menu" | "countdown" | "play" | "over";
export type SprintMode = "ready" | "running" | "recharging";

export interface LeaderRow {
  i: number;
  name: string;
  color: string;
  pct: number;
  me: boolean;
  rank: number;
}

export interface ResultRow {
  rank: number;
  name: string;
  color: string;
  pct: number;
  me: boolean;
}

interface ResultsData {
  title: string;
  sub: string;
  rows: ResultRow[];
  winnerColor: string;
}

interface HudState {
  phase: Phase;
  countdown: string;
  time: number;
  duration: number;
  low: boolean;
  leaderboard: LeaderRow[];
  sprint: {
    mode: SprintMode;
    progress: number;
    shield: number;
  };
  toast: {
    id: number;
    text: string;
    color: string;
  } | null;
  results: ResultsData | null;
  muted: boolean;
  toastId: number;

  showToast: (text: string, color: string) => void;
  reset: (duration: number) => void;
}

export const useHudStore = create<HudState>()((set) => ({
  phase: "menu",
  countdown: "3",
  time: 90,
  duration: 90,
  low: false,
  leaderboard: [],
  sprint: {
    mode: "ready",
    progress: 1,
    shield: 0,
  },
  toast: null,
  results: null,
  muted: false,
  toastId: 0,

  showToast: (text, color) =>
    set((s) => ({
      toastId: s.toastId + 1,
      toast: {
        id: s.toastId + 1,
        text,
        color,
      },
    })),

  reset: (duration) =>
    set({
      phase: "countdown",
      countdown: "3",
      time: duration,
      duration,
      low: false,
      leaderboard: [],
      sprint: {
        mode: "ready",
        progress: 1,
        shield: 0,
      },
      toast: null,
      results: null,
    }),
}));
