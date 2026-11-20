import { io } from "socket.io-client";

const KEY = "pixel-turf:playerId";

function makePlayerId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `p-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function getPlayerId(): string {
  let id: string | null = null;

  try {
    id = window.sessionStorage.getItem(KEY);

    if (!id) {
      id = makePlayerId();
      window.sessionStorage.setItem(KEY, id);
    }
  } catch {
    id = makePlayerId();
  }

  return id;
}

const DEFAULT_PROD_SERVER_URL = "https://pixelturf.onrender.com";

const rawServerUrl = import.meta.env.VITE_SERVER_URL?.trim();
const SERVER_URL =
  (rawServerUrl ? rawServerUrl.replace(/\/+$/, "") : undefined) ??
  (import.meta.env.PROD ? DEFAULT_PROD_SERVER_URL : undefined);

export const socket = io(SERVER_URL, {
  withCredentials: true,
  auth: {
    playerId: getPlayerId(),
  },
});
