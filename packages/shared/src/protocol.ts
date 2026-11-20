// packages/shared/src/protocol.ts
import { z } from 'zod';

export const DirEnum = z.enum(['0', '1', '2', '3']);
export type Dir = 0 | 1 | 2 | 3; // 0:up, 1:right, 2:down, 3:left
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

export type PowerUpType = 'bomb' | 'turbo' | 'shield';

export interface GameConfig {
  size: 30 | 40 | 50;
  durationS: 60 | 90 | 120;
  sprint: boolean;
  powerups: boolean;
  slots: SlotConfig[];
  seed: number;
}

export interface SlotConfig {
  kind: 'human' | 'bot';
  userId?: string;
  name: string;
  skinId: string;
  colorId: number;
  botLevel?: 'easy' | 'normal' | 'hard';
}

export interface Player {
  i: number;
  name: string;
  bot: boolean;
  lv?: 'easy' | 'normal' | 'hard';
  x: number; y: number;
  px: number; py: number;
  dx: number; dy: number;
  q: { dx: number, dy: number }[];
  score: number;
  streak: number;
  spr: number;
  sprMax: number;
  cd: number;
  shield: number;
}

export interface PowerUp {
  id: number;
  k: number; // index
  type: PowerUpType;
}

export interface GameState {
  config: GameConfig;
  size: number;
  cells: Int8Array; // -1 for empty, else player index
  players: Player[];
  pu: PowerUp[];
  puT: number; // timer for next spawn
  puNextId: number;
  rand: () => number;
  ticks: number;
}

// Events emitted by the engine for VFX/SFX
export type GameEvent =
  | { type: 'claim', k: number, owner: number, prevOwner: number, quiet: boolean }
  | { type: 'blocked', k: number, attacker: number, defender: number }
  | { type: 'grab', pIdx: number, puType: PowerUpType }
  | { type: 'sprintStart', pIdx: number }
  | { type: 'sprintEnd', pIdx: number }
  | { type: 'puSpawn', k: number, puType: PowerUpType }
  | { type: 'streak', pIdx: number, streak: number }
  | { type: 'bomb', pIdx: number, cx: number, cy: number };

export interface TickResult {
  events: GameEvent[];
}

/* ------------------------------------------------------------------ */
/* M3: realtime protocol                                               */
/* ------------------------------------------------------------------ */

export const SocketEvents = {
  ROOM_CREATE: "room:create",
  ROOM_JOIN: "room:join",
  ROOM_LEAVE: "room:leave",
  ROOM_SETTINGS: "room:settings",
  ROOM_BOT: "room:bot",
  ROOM_READY: "room:ready",
  ROOM_SKIN: "room:skin",
  ROOM_START: "room:start",

  QUEUE_JOIN: "queue:join",
  QUEUE_LEAVE: "queue:leave",

  ROOM_STATE: "room:state",

  GAME_COUNTDOWN: "game:countdown",
  GAME_START: "game:start",
  GAME_TICK: "game:tick",
  GAME_SNAPSHOT: "game:snapshot",
  GAME_END: "game:end",

  GAME_INPUT: "game:input",
  GAME_SPRINT: "game:sprint",
  GAME_RESYNC: "game:resync",

  SYNC_PING: "sync:ping",
  SYNC_PONG: "sync:pong",

  PLAYER_STATUS: "player:status",
  ERROR: "error",
} as const;

export type BotLevel = "easy" | "normal" | "hard";

export interface RoomSettings {
  size: 30 | 40 | 50;
  durationS: 60 | 90 | 120;
  sprint: boolean;
  powerups: boolean;
  maxPlayers: number;
  isPublic: boolean;
  botDifficulty: BotLevel;
  fillWithBots: boolean;
}

export const RoomSettingsSchema = z.object({
  size: z.union([z.literal(30), z.literal(40), z.literal(50)]).optional(),
  durationS: z
    .union([z.literal(60), z.literal(90), z.literal(120)])
    .optional(),
  sprint: z.boolean().optional(),
  powerups: z.boolean().optional(),
  maxPlayers: z.number().int().min(2).max(6).optional(),
  isPublic: z.boolean().optional(),
  botDifficulty: z.enum(["easy", "normal", "hard"]).optional(),
  fillWithBots: z.boolean().optional(),
});

export type RoomSettingsInput = z.infer<typeof RoomSettingsSchema>;

export const RoomCreateSchema = z.object({
  playerId: z.string().min(8).max(64),
  name: z.string().min(2).max(12).optional(),
  colorId: z.number().int().min(0).max(5).optional(),
  settings: RoomSettingsSchema.optional(),
});

export const RoomJoinSchema = RoomCreateSchema.extend({
  code: z.string().length(7),
});

export const RoomBotSchema = z.object({
  action: z.enum(["add", "remove", "set", "preset"]),
  playerId: z.string().optional(),
  level: z.enum(["easy", "normal", "hard"]).optional(),
  count: z.number().int().min(0).max(5).optional(),
});

export const QueueJoinSchema = z.object({
  name: z.string().min(2).max(12).optional(),
  colorId: z.number().int().min(0).max(5).optional(),
});

export const GameInputSchema = z.object({
  seq: z.number().int().min(0),
  dir: z.number().int().min(0).max(3),
});

export const GameSprintSchema = z.object({
  seq: z.number().int().min(0).optional(),
});

export interface LobbyPlayerDTO {
  playerId: string;
  name: string;
  skinId: string;
  colorId: number;
  ready: boolean;
  isHost: boolean;
  isBot: boolean;
  botLevel?: BotLevel;
  connected: boolean;
}

export interface RoomStateDTO {
  code: string;
  phase: "LOBBY" | "COUNTDOWN" | "PLAYING" | "RESULTS";
  settings: RoomSettings;
  players: LobbyPlayerDTO[];
  hostId: string;
  you?: string;
}

export interface TickPlayerDTO {
  i: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  spr: number;
  cd: number;
  sh: number;
  sc: number;
}

export interface TickPayload {
  t: number;
  rem: number;
  cells: number[]; // flat pairs: [idx, owner, idx, owner]
  players: TickPlayerDTO[];
  pu: { id: number; k: number; type: PowerUpType }[];
  ev: GameEvent[];
}

export interface SnapshotPayload {
  t: number;
  cellsB64: string;
  players: TickPlayerDTO[];
  pu: { id: number; k: number; type: PowerUpType }[];
}

export interface GameStartPayload {
  config: GameConfig;
  snapshot: SnapshotPayload;
  startedAt: number;
  endsAt: number;
  selfIdx: number;
}

export interface GameEndResult {
  idx: number;
  name: string;
  cells: number;
  pct: number;
  steals: number;
}

export interface GameEndPayload {
  results: GameEndResult[];
  matchId: string | null;
}