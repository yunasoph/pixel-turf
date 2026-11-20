import { Server, Socket } from "socket.io";
import {
  QueueJoinSchema,
  RoomBotSchema,
  RoomCreateSchema,
  RoomJoinSchema,
  RoomSettingsSchema,
  RoomStateDTO,
} from "@pixel-turf/shared";
import {
  Room,
  RoomMember,
  addBot,
  createRoom,
  freeColor,
  removeBotById,
  removeLastBot,
  roomState,
  sanitizeName,
  setBotLevel,
  syncBotCount,
  totalBots,
  totalHumans,
} from "./Room";
import { GameSession } from "./GameSession";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export class RoomManager {
  private io: Server;
  private rooms = new Map<string, Room>();

  constructor(io: Server) {
    this.io = io;
  }

  /* ---------------- room codes ---------------- */

  private generateCode(): string {
    let code = "";

    for (let i = 0; i < 3; i++) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }

    code += "-";

    for (let i = 0; i < 3; i++) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }

    return code;
  }

  private ensureUniqueCode(): string {
    let code = this.generateCode();

    while (this.rooms.has(code)) {
      code = this.generateCode();
    }

    return code;
  }

  /* ---------------- lookup ---------------- */

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  getRoomBySocket(socket: Socket): Room | undefined {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return undefined;
    return this.rooms.get(code);
  }

  /* ---------------- create / join ---------------- */

  createRoom(socket: Socket, rawPayload: unknown): RoomStateDTO {
    const payload = RoomCreateSchema.parse(rawPayload);

    const playerId = payload.playerId;
    socket.data.playerId = playerId;

    const member: RoomMember = {
      playerId,
      socketId: socket.id,
      name: sanitizeName(payload.name),
      skinId: "classic",
      colorId: payload.colorId ?? 0,
      ready: true,
      isBot: false,
      connected: true,
    };

    const code = this.ensureUniqueCode();
    const room = createRoom(code, member, payload.settings);

    member.colorId = freeColor(room, payload.colorId);
    room.members.set(playerId, member);

    this.rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;

    return roomState(room, playerId);
  }

  joinRoom(socket: Socket, rawPayload: unknown): RoomStateDTO {
    const payload = RoomJoinSchema.parse(rawPayload);

    const room = this.rooms.get(payload.code.toUpperCase());
    if (!room) {
      throw new Error("Room not found");
    }

    const playerId = payload.playerId;
    socket.data.playerId = playerId;
    socket.data.roomCode = room.code;

    const existing = room.members.get(playerId);

    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;

      socket.join(room.code);

      if (room.phase === "PLAYING" && room.session) {
        room.session.handleReconnect(playerId, socket.id);
      }

      return roomState(room, playerId);
    }

    if (room.members.size >= room.settings.maxPlayers) {
      throw new Error("Room is full");
    }

    const member: RoomMember = {
      playerId,
      socketId: socket.id,
      name: sanitizeName(payload.name),
      skinId: "classic",
      colorId: freeColor(room, payload.colorId),
      ready: true,
      isBot: false,
      connected: true,
    };

    room.members.set(playerId, member);

    socket.join(room.code);

    if (room.quickPlayTimer && totalHumans(room) >= 2) {
      clearTimeout(room.quickPlayTimer);
      room.quickPlayTimer = undefined;
    }

    this.broadcastRoomState(room);

    return roomState(room, playerId);
  }

  /* ---------------- quick play ---------------- */

  quickPlay(socket: Socket, rawPayload: unknown): RoomStateDTO {
    const payload = QueueJoinSchema.parse(rawPayload || {});

    const current = this.getRoomBySocket(socket);
    if (current) {
      return roomState(current, socket.data.playerId as string);
    }

    for (const room of this.rooms.values()) {
      if (
        room.phase === "LOBBY" &&
        room.settings.isPublic &&
        room.members.size < room.settings.maxPlayers
      ) {
        return this.joinRoom(socket, {
          playerId: socket.data.playerId as string,
          name: payload.name,
          colorId: payload.colorId,
          code: room.code,
        });
      }
    }

    const state = this.createRoom(socket, {
      playerId: socket.data.playerId as string,
      name: payload.name,
      colorId: payload.colorId,
      settings: {
        isPublic: true,
        maxPlayers: 4,
        fillWithBots: true,
      },
    });

    const room = this.rooms.get(state.code);
    if (room) {
      room.quickPlayTimer = setTimeout(() => {
        this.fillQuickPlayRoom(room);
      }, 8000);
    }

    return state;
  }

  private fillQuickPlayRoom(room: Room) {
    if (room.phase !== "LOBBY") return;

    const humans = totalHumans(room);

    if (humans === 0) {
      if (room.quickPlayTimer) {
        clearTimeout(room.quickPlayTimer);
        room.quickPlayTimer = undefined;
      }

      this.rooms.delete(room.code);
      return;
    }

    if (humans === 1 && room.settings.fillWithBots) {
      syncBotCount(room, room.settings.maxPlayers - humans);
      this.broadcastRoomState(room);

      // Do NOT auto-start while we are debugging rooms.
      // Host can press Start manually.
    }
  }

  /* ---------------- leave / disconnect ---------------- */

  leaveRoom(socket: Socket) {
    const room = this.getRoomBySocket(socket);
    if (!room) return;

    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return;

    if (room.phase === "PLAYING") {
      room.session?.handleDisconnect(playerId);
      return;
    }

    room.members.delete(playerId);

    if (room.hostId === playerId) {
      const nextHost = [...room.members.values()].find((m) => !m.isBot);
      if (nextHost) {
        room.hostId = nextHost.playerId;
      }
    }

    socket.leave(room.code);
    socket.data.roomCode = undefined;

    if (totalHumans(room) === 0) {
      if (room.quickPlayTimer) {
        clearTimeout(room.quickPlayTimer);
        room.quickPlayTimer = undefined;
      }

      this.rooms.delete(room.code);
      return;
    }

    this.broadcastRoomState(room);
  }

  handleDisconnect(socket: Socket) {
    const room = this.getRoomBySocket(socket);
    if (!room) return;

    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return;

    const member = room.members.get(playerId);
    if (!member) return;

    if (room.phase === "PLAYING") {
      room.session?.handleDisconnect(playerId);
      this.broadcastRoomState(room);
      return;
    }

    if (room.phase === "LOBBY") {
      room.members.delete(playerId);

      if (room.hostId === playerId) {
        const nextHost = [...room.members.values()].find((m) => !m.isBot);
        if (nextHost) {
          room.hostId = nextHost.playerId;
        }
      }

      if (totalHumans(room) === 0) {
        if (room.quickPlayTimer) {
          clearTimeout(room.quickPlayTimer);
          room.quickPlayTimer = undefined;
        }

        this.rooms.delete(room.code);
        return;
      }

      this.broadcastRoomState(room);
    }
  }

  /* ---------------- settings ---------------- */

  updateSettings(socket: Socket, rawPayload: unknown) {
    const room = this.getRoomBySocket(socket);
    if (!room) return;

    const playerId = socket.data.playerId as string;
    if (room.hostId !== playerId) return;

    if (room.phase !== "LOBBY") return;

    const patch = RoomSettingsSchema.parse(rawPayload);

    if (patch.maxPlayers !== undefined) {
      const minAllowed = Math.max(2, totalHumans(room));

      const clamped = Math.max(minAllowed, Math.min(6, patch.maxPlayers));

      patch.maxPlayers = clamped as any;

      while (room.members.size > clamped) {
        if (!removeLastBot(room)) break;
      }
    }

    room.settings = {
      ...room.settings,
      ...patch,
    };

    const humans = totalHumans(room);
    const maxBots = room.settings.maxPlayers - humans;

    if (totalBots(room) > maxBots) {
      syncBotCount(room, maxBots);
    }

    this.broadcastRoomState(room);
  }

  /* ---------------- bots ---------------- */

  handleBot(socket: Socket, rawPayload: unknown) {
    const room = this.getRoomBySocket(socket);
    if (!room) return;

    const playerId = socket.data.playerId as string;
    if (room.hostId !== playerId) return;

    if (room.phase !== "LOBBY") return;

    const data = RoomBotSchema.parse(rawPayload);

    switch (data.action) {
      case "add": {
        addBot(room, data.level);
        break;
      }

      case "remove": {
        if (data.playerId) {
          removeBotById(room, data.playerId);
        } else {
          removeLastBot(room);
        }
        break;
      }

      case "set": {
        if (data.playerId && data.level) {
          setBotLevel(room, data.playerId, data.level);
        }
        break;
      }

      case "preset": {
        syncBotCount(room, data.count ?? 0, data.level);
        break;
      }
    }

    this.broadcastRoomState(room);
  }

  /* ---------------- start ---------------- */

  startGame(socket: Socket) {
    const room = this.getRoomBySocket(socket);
    if (!room) return;

    const playerId = socket.data.playerId as string;
    if (room.hostId !== playerId) return;

    this.startGameForRoom(room);
  }

  startGameForRoom(room: Room) {
    if (room.phase !== "LOBBY") return;

    if (room.members.size < 2) {
      throw new Error("Need at least 2 players");
    }

    if (room.quickPlayTimer) {
      clearTimeout(room.quickPlayTimer);
      room.quickPlayTimer = undefined;
    }

    const session = new GameSession(this.io, room);
    room.session = session;

    session.startCountdown();
    this.broadcastRoomState(room);
  }

  /* ---------------- broadcast ---------------- */

  broadcastRoomState(room: Room) {
    this.io.to(room.code).emit("room:state", roomState(room));
  }
}
