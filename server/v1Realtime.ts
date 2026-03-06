import { Server, type Socket } from "socket.io";

import type { RealtimeEventName } from "../shared/v1.js";
import { readBearerToken, verifyAccessToken } from "./v1Auth.js";
import { V1Store } from "./v1Store.js";

interface SocketData {
  userId: string;
}

type MercurySocket = Socket<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, SocketData>;

export class V1RealtimeHub {
  constructor(
    private readonly io: Server,
    private readonly store: V1Store,
  ) {
    this.io.use((socket, next) => {
      const authTokenRaw =
        typeof socket.handshake.auth?.token === "string"
          ? socket.handshake.auth.token
          : readBearerToken(socket.handshake.headers.authorization);

      const token = authTokenRaw?.startsWith("Bearer ") ? readBearerToken(authTokenRaw) : authTokenRaw;
      if (!token) {
        next(new Error("Missing realtime token"));
        return;
      }

      const user = verifyAccessToken(token);
      if (!user) {
        next(new Error("Invalid realtime token"));
        return;
      }

      (socket.data as SocketData).userId = user.userId;
      next();
    });

    this.io.on("connection", (socket) => {
      void this.handleConnection(socket as MercurySocket);
    });
  }

  private async handleConnection(socket: MercurySocket): Promise<void> {
    const userId = socket.data.userId;

    socket.join(this.userChannel(userId));
    await this.store.updatePresence(userId, "online");

    socket.on("join_room", async (payload: unknown) => {
      const roomId = typeof (payload as Record<string, unknown>)?.roomId === "string" ? (payload as Record<string, string>).roomId : "";
      if (!roomId) {
        return;
      }

      try {
        await this.store.getRoomDetail(roomId, userId);
        socket.join(this.roomChannel(roomId));
        await this.store.updatePresence(userId, "in_room", roomId);
        this.emitRoomEvent(roomId, "presence_updated", {
          userId,
          status: "in_room",
          roomId,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        (socket.emit as unknown as (event: string, payload: Record<string, unknown>) => void)("reconnect_required", {
          reason: "room_access_denied",
        });
      }
    });

    socket.on("leave_room", async (payload: unknown) => {
      const roomId = typeof (payload as Record<string, unknown>)?.roomId === "string" ? (payload as Record<string, string>).roomId : "";
      if (!roomId) {
        return;
      }

      socket.leave(this.roomChannel(roomId));
      await this.store.updatePresence(userId, "online");
      this.emitRoomEvent(roomId, "presence_updated", {
        userId,
        status: "online",
        roomId: null,
        updatedAt: new Date().toISOString(),
      });
    });

    socket.on("presence_heartbeat", async (payload: unknown) => {
      const roomId = typeof (payload as Record<string, unknown>)?.roomId === "string" ? (payload as Record<string, string>).roomId : undefined;
      const status = roomId ? "in_room" : "online";
      await this.store.updatePresence(userId, status, roomId);
    });

    socket.on("disconnect", async () => {
      await this.store.updatePresence(userId, "offline");
    });
  }

  emitRoomEvent(roomId: string, eventName: RealtimeEventName, payload: Record<string, unknown>): void {
    this.io.to(this.roomChannel(roomId)).emit(eventName, payload);
  }

  emitUserEvent(userId: string, eventName: RealtimeEventName, payload: Record<string, unknown>): void {
    this.io.to(this.userChannel(userId)).emit(eventName, payload);
  }

  private roomChannel(roomId: string): string {
    return `room:${roomId}`;
  }

  private userChannel(userId: string): string {
    return `user:${userId}`;
  }
}
