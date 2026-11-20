import { Server } from "socket.io";
import {
  DX,
  DY,
  GameConfig,
  GameEvent,
  SlotConfig,
  TICK_MS,
  createGame,
  isOver,
  queueInput,
  requestSprint,
  step,
} from "@pixel-turf/shared";
import type { Room, RoomMember } from "./Room";

type SessionPhase = "COUNTDOWN" | "PLAYING" | "ENDED";

interface RateBucket {
  count: number;
  resetAt: number;
}

export class GameSession {
  private io: Server;
  private room: Room;

  private phase: SessionPhase = "COUNTDOWN";
  private state: ReturnType<typeof createGame> | null = null;

  private tickCount = 0;
  private startedAt = 0;
  private endsAt = 0;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;
  private nextTickAt = 0;

  private lastCells: Int8Array | null = null;

  private playerIdToIdx = new Map<string, number>();
  private idxToPlayerId = new Map<number, string>();

  private inputRate = new Map<string, RateBucket>();
  private takeoverTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(io: Server, room: Room) {
    this.io = io;
    this.room = room;
  }

  startCountdown() {
    if (this.room.phase !== "LOBBY") return;

    this.room.phase = "COUNTDOWN";
    this.phase = "COUNTDOWN";

    const startsAt = Date.now() + 4000;

    this.io.to(this.room.code).emit("game:countdown", {
      startsAt,
    });

    this.countdownTimer = setTimeout(() => {
      this.startPlaying();
    }, 4000);
  }

  private buildSlots(): SlotConfig[] {
    const slots: SlotConfig[] = [];

    for (const member of this.room.members.values()) {
      slots.push({
        kind: member.isBot ? "bot" : "human",
        userId: member.playerId,
        name: member.name,
        skinId: member.skinId,
        colorId: member.colorId,
        botLevel: member.botLevel,
      });
    }

    return slots;
  }

  private startPlaying() {
    if (this.phase !== "COUNTDOWN") return;

    const slots = this.buildSlots();

    const config: GameConfig = {
      size: this.room.settings.size,
      durationS: this.room.settings.durationS,
      sprint: this.room.settings.sprint,
      powerups: this.room.settings.powerups,
      slots,
      seed: Math.floor(Math.random() * 1_000_000_000),
    };

    this.state = createGame(config);
    this.lastCells = new Int8Array(this.state.cells);

    this.phase = "PLAYING";
    this.room.phase = "PLAYING";

    this.startedAt = Date.now();
    this.endsAt = this.startedAt + this.room.settings.durationS * 1000;

    slots.forEach((slot, idx) => {
      if (slot.userId) {
        this.playerIdToIdx.set(slot.userId, idx);
        this.idxToPlayerId.set(idx, slot.userId);
      }
    });

    for (const member of this.room.members.values()) {
      if (!member.isBot && member.socketId) {
        const selfIdx = this.playerIdToIdx.get(member.playerId) ?? 0;

        this.io.to(member.socketId).emit("game:start", {
          config,
          snapshot: this.makeSnapshot(),
          startedAt: this.startedAt,
          endsAt: this.endsAt,
          selfIdx,
        });
      }
    }

    this.tickCount = 0;
    this.nextTickAt = Date.now() + TICK_MS;

    this.timer = setTimeout(() => this.tick(), TICK_MS);
  }

  private tick() {
    if (!this.state || this.phase !== "PLAYING") return;

    const result = step(this.state);
    this.tickCount++;

    this.emitTick(result.events);

    if (this.tickCount % 60 === 0) {
      this.emitSnapshot();
    }

    if (isOver(this.state) || Date.now() >= this.endsAt) {
      this.end();
      return;
    }

    const now = Date.now();
    this.nextTickAt += TICK_MS;
    const delay = Math.max(0, this.nextTickAt - now);

    this.timer = setTimeout(() => this.tick(), delay);
  }

  private emitTick(events: GameEvent[]) {
    if (!this.state || !this.lastCells) return;

    const delta: number[] = [];

    for (let k = 0; k < this.state.cells.length; k++) {
      if (this.state.cells[k] !== this.lastCells[k]) {
        delta.push(k, this.state.cells[k]);
        this.lastCells[k] = this.state.cells[k];
      }
    }

    const players = this.state.players.map((p) => ({
      i: p.i,
      x: p.x,
      y: p.y,
      dx: p.dx,
      dy: p.dy,
      spr: Math.max(0, p.spr),
      cd: Math.max(0, p.cd),
      sh: p.shield,
      sc: p.score,
    }));

    const rem = Math.max(0, (this.endsAt - Date.now()) / 1000);

    this.io.to(this.room.code).emit("game:tick", {
      t: this.tickCount,
      rem,
      cells: delta,
      players,
      pu: this.state.pu.map((u) => ({
        id: u.id,
        k: u.k,
        type: u.type,
      })),
      ev: events,
    });
  }

  private makeSnapshot() {
    if (!this.state) {
      throw new Error("No game state");
    }

    const cellsB64 = Buffer.from(this.state.cells).toString("base64");

    return {
      t: this.tickCount,
      cellsB64,
      players: this.state.players.map((p) => ({
        i: p.i,
        x: p.x,
        y: p.y,
        dx: p.dx,
        dy: p.dy,
        spr: Math.max(0, p.spr),
        cd: Math.max(0, p.cd),
        sh: p.shield,
        sc: p.score,
      })),
      pu: this.state.pu.map((u) => ({
        id: u.id,
        k: u.k,
        type: u.type,
      })),
    };
  }

  private emitSnapshot() {
    this.io.to(this.room.code).emit("game:snapshot", this.makeSnapshot());
  }

  handleInput(playerId: string, dir: number) {
    if (!this.state || this.phase !== "PLAYING") return;

    const idx = this.playerIdToIdx.get(playerId);
    if (idx === undefined) return;

    const p = this.state.players[idx];
    if (!p) return;

    queueInput(this.state, idx, DX[dir as 0 | 1 | 2 | 3], DY[dir as 0 | 1 | 2 | 3]);
  }

  handleSprint(playerId: string) {
    if (!this.state || this.phase !== "PLAYING") return;

    const idx = this.playerIdToIdx.get(playerId);
    if (idx === undefined) return;

    requestSprint(this.state, idx);
  }

  rateLimitSocket(socketId: string): boolean {
    const now = Date.now();
    const bucket = this.inputRate.get(socketId) || {
      count: 0,
      resetAt: now + 1000,
    };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + 1000;
    }

    bucket.count++;
    this.inputRate.set(socketId, bucket);

    return bucket.count <= 30;
  }

  handleDisconnect(playerId: string) {
    const member = this.room.members.get(playerId);
    if (!member) return;

    member.connected = false;

    if (this.phase !== "PLAYING") return;

    const idx = this.playerIdToIdx.get(playerId);
    if (idx === undefined) return;

    this.io.to(this.room.code).emit("player:status", {
      idx,
      status: "disconnected",
    });

    const timer = setTimeout(() => {
      if (!this.state || this.phase !== "PLAYING") return;

      const m = this.room.members.get(playerId);
      if (!m || m.connected) return;

      const p = this.state.players[idx];
      if (!p) return;

      p.bot = true;

      this.io.to(this.room.code).emit("player:status", {
        idx,
        status: "botTakeover",
      });
    }, 5000);

    this.takeoverTimers.set(playerId, timer);
  }

  handleReconnect(playerId: string, socketId: string) {
    const member = this.room.members.get(playerId);
    if (!member) return;

    member.connected = true;
    member.socketId = socketId;

    const existing = this.takeoverTimers.get(playerId);
    if (existing) {
      clearTimeout(existing);
      this.takeoverTimers.delete(playerId);
    }

    if (this.phase !== "PLAYING" || !this.state) return;

    const idx = this.playerIdToIdx.get(playerId);
    if (idx === undefined) return;

    const p = this.state.players[idx];
    if (p) {
      p.bot = false;
    }

    this.io.to(socketId).emit("game:snapshot", this.makeSnapshot());

    this.io.to(this.room.code).emit("player:status", {
      idx,
      status: "reconnected",
    });
  }

  private end() {
    if (!this.state || this.phase === "ENDED") return;

    this.phase = "ENDED";
    this.room.phase = "RESULTS";

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const total = this.state.size * this.state.size;

    const results = [...this.state.players]
      .sort((a, b) => b.score - a.score)
      .map((p) => ({
        idx: p.i,
        name: p.name,
        cells: p.score,
        pct: (p.score / total) * 100,
        steals: 0,
      }));

    this.io.to(this.room.code).emit("game:end", {
      results,
      matchId: null,
    });

    setTimeout(() => {
      if (this.room.phase === "RESULTS") {
        this.room.phase = "LOBBY";
        this.room.session = undefined;
        this.io.to(this.room.code).emit("room:state", {
          code: this.room.code,
          phase: this.room.phase,
          settings: this.room.settings,
          hostId: this.room.hostId,
          players: [...this.room.members.values()].map((m) => ({
            playerId: m.playerId,
            name: m.name,
            skinId: m.skinId,
            colorId: m.colorId,
            ready: m.ready,
            isHost: m.playerId === this.room.hostId,
            isBot: m.isBot,
            botLevel: m.botLevel,
            connected: m.connected,
          })),
        });
      }
    }, 8000);
  }
}
