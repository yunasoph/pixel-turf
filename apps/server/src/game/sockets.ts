import { Server, Socket } from "socket.io";
import {
  GameInputSchema,
  GameSprintSchema,
  SocketEvents,
} from "@pixel-turf/shared";
import { RoomManager } from "./RoomManager";

export function registerGameSockets(io: Server) {
  const manager = new RoomManager(io);

  io.on("connection", (socket: Socket) => {
    const handshakePlayerId = socket.handshake.auth?.playerId;

    if (handshakePlayerId) {
      socket.data.playerId = handshakePlayerId;
    }

    socket.on(SocketEvents.ROOM_CREATE, (payload, ack) => {
      try {
        const state = manager.createRoom(socket, payload);
        ack?.({ ok: true, state });
      } catch (err: any) {
        ack?.({
          ok: false,
          message: err.message || "Failed to create room",
        });
      }
    });

    socket.on(SocketEvents.ROOM_JOIN, (payload, ack) => {
      try {
        const state = manager.joinRoom(socket, payload);
        ack?.({ ok: true, state });
      } catch (err: any) {
        ack?.({
          ok: false,
          message: err.message || "Failed to join room",
        });
      }
    });

    socket.on(SocketEvents.QUEUE_JOIN, (payload, ack) => {
      try {
        const state = manager.quickPlay(socket, payload);
        ack?.({ ok: true, state });
      } catch (err: any) {
        ack?.({
          ok: false,
          message: err.message || "Failed to join queue",
        });
      }
    });

    socket.on(SocketEvents.ROOM_LEAVE, () => {
      manager.leaveRoom(socket);
    });

    socket.on(SocketEvents.ROOM_SETTINGS, (payload) => {
      try {
        manager.updateSettings(socket, payload);
      } catch {}
    });

    socket.on(SocketEvents.ROOM_BOT, (payload) => {
      try {
        manager.handleBot(socket, payload);
      } catch {}
    });

    socket.on(SocketEvents.ROOM_START, () => {
      try {
        manager.startGame(socket);
      } catch {}
    });

    socket.on(SocketEvents.GAME_INPUT, (payload) => {
      try {
        const room = manager.getRoomBySocket(socket);
        if (!room || !room.session) return;

        const playerId = socket.data.playerId as string;
        if (!playerId) return;

        if (!room.session.rateLimitSocket(socket.id)) return;

        const data = GameInputSchema.parse(payload);
        room.session.handleInput(playerId, data.dir);
      } catch {}
    });

    socket.on(SocketEvents.GAME_SPRINT, (payload) => {
      try {
        const room = manager.getRoomBySocket(socket);
        if (!room || !room.session) return;

        const playerId = socket.data.playerId as string;
        if (!playerId) return;

        if (!room.session.rateLimitSocket(socket.id)) return;

        GameSprintSchema.parse(payload || {});
        room.session.handleSprint(playerId);
      } catch {}
    });

    socket.on(SocketEvents.GAME_RESYNC, () => {
      // handled later with explicit snapshot request if needed
    });

    socket.on(SocketEvents.SYNC_PING, (payload, ack) => {
      ack?.({
        t0: payload?.t0 ?? Date.now(),
        ts: Date.now(),
      });
    });

    socket.on("disconnect", () => {
      manager.handleDisconnect(socket);
    });
  });
}
