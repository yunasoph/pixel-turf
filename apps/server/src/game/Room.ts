import {
  BotLevel,
  RoomSettings,
  RoomStateDTO,
} from "@pixel-turf/shared";
import type { GameSession } from "./GameSession";

export interface RoomMember {
  playerId: string;
  socketId?: string;
  name: string;
  skinId: string;
  colorId: number;
  ready: boolean;
  isBot: boolean;
  botLevel?: BotLevel;
  connected: boolean;
}

export interface Room {
  code: string;
  hostId: string;
  phase: "LOBBY" | "COUNTDOWN" | "PLAYING" | "RESULTS";
  settings: RoomSettings;
  members: Map<string, RoomMember>;
  session?: GameSession;
  createdAt: number;
  quickPlayTimer?: ReturnType<typeof setTimeout>;
}

export const BOT_NAMES = [
  "Nova",
  "Blip",
  "Zed",
  "Pixel",
  "Glitch",
  "Turbo",
  "Byte",
  "Echo",
];

const BAD_WORDS = ["fuck", "shit", "bitch", "asshole"];

export function sanitizeName(input?: string): string {
  let name = (input || "").trim().replace(/[^\p{L}\p{N}_\- ]/gu, "");

  if (!name) name = "Guest";
  if (name.length < 2) name = "Guest";
  if (name.length > 12) name = name.slice(0, 12);

  const lower = name.toLowerCase();
  if (BAD_WORDS.some((w) => lower.includes(w))) {
    name = "Player";
  }

  return name;
}

export function defaultSettings(): RoomSettings {
  return {
    size: 40,
    durationS: 90,
    sprint: true,
    powerups: true,
    maxPlayers: 4,
    isPublic: false,
    botDifficulty: "easy",
    fillWithBots: false,
  };
}

export function createRoom(
  code: string,
  host: RoomMember,
  settings?: Partial<RoomSettings>
): Room {
  return {
    code,
    hostId: host.playerId,
    phase: "LOBBY",
    settings: {
      ...defaultSettings(),
      ...settings,
    },
    members: new Map([[host.playerId, host]]),
    createdAt: Date.now(),
  };
}

export function totalPlayers(room: Room): number {
  return room.members.size;
}

export function totalHumans(room: Room): number {
  return [...room.members.values()].filter((m) => !m.isBot).length;
}

export function freeColor(room: Room, preferred?: number): number {
  const used = new Set(
    [...room.members.values()].map((m) => m.colorId)
  );

  if (
    preferred !== undefined &&
    preferred >= 0 &&
    preferred <= 5 &&
    !used.has(preferred)
  ) {
    return preferred;
  }

  for (let i = 0; i < 6; i++) {
    if (!used.has(i)) return i;
  }

  return Math.floor(Math.random() * 6);
}

export function addBot(
  room: Room,
  level?: BotLevel
): RoomMember | null {
  if (room.members.size >= room.settings.maxPlayers) return null;

  const usedNames = new Set(
    [...room.members.values()].map((m) => m.name)
  );

  const name =
    BOT_NAMES.find((n) => !usedNames.has(n)) ||
    `Bot${room.members.size + 1}`;

  const bot: RoomMember = {
    playerId: `bot:${Math.random().toString(36).slice(2, 10)}`,
    name,
    skinId: "classic",
    colorId: freeColor(room),
    ready: true,
    isBot: true,
    botLevel: level || room.settings.botDifficulty,
    connected: true,
  };

  room.members.set(bot.playerId, bot);
  return bot;
}

export function removeLastBot(room: Room): boolean {
  const bots = [...room.members.values()].filter((m) => m.isBot);
  const bot = bots[bots.length - 1];

  if (!bot) return false;

  room.members.delete(bot.playerId);
  return true;
}

export function roomState(
  room: Room,
  you?: string
): RoomStateDTO {
  return {
    code: room.code,
    phase: room.phase,
    settings: room.settings,
    hostId: room.hostId,
    you,
    players: [...room.members.values()].map((m) => ({
      playerId: m.playerId,
      name: m.name,
      skinId: m.skinId,
      colorId: m.colorId,
      ready: m.ready,
      isHost: m.playerId === room.hostId,
      isBot: m.isBot,
      botLevel: m.botLevel,
      connected: m.connected,
    })),
  };
}

export function totalBots(room: Room): number {
  return [...room.members.values()].filter((m) => m.isBot).length;
}

export function removeBotById(room: Room, playerId: string): boolean {
  const member = room.members.get(playerId);

  if (!member || !member.isBot) return false;

  room.members.delete(playerId);
  return true;
}

export function setBotLevel(
  room: Room,
  playerId: string,
  level: BotLevel
): void {
  const member = room.members.get(playerId);

  if (!member || !member.isBot) return;

  member.botLevel = level;
}

export function syncBotCount(
  room: Room,
  desiredBots: number,
  level?: BotLevel
): void {
  const humans = totalHumans(room);

  desiredBots = Math.max(0, Math.min(desiredBots, 6 - humans));

  if (humans + desiredBots > room.settings.maxPlayers) {
    room.settings.maxPlayers = Math.min(6, humans + desiredBots) as any;
  }

  while (totalBots(room) > desiredBots) {
    if (!removeLastBot(room)) break;
  }

  while (totalBots(room) < desiredBots) {
    if (!addBot(room, level)) break;
  }
}
