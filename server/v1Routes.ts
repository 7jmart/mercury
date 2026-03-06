import { type Express, type NextFunction, type Request, type Response, Router } from "express";

import type {
  CreateInviteInput,
  CreateMessageInput,
  CreateRoomInput,
  FriendRequestInput,
  RecordMetricInput,
  RegisterPushTokenInput,
  SendOtpCodeInput,
  UpdateRoomPrivacyInput,
  VerifyOtpCodeInput,
  V1AuthUser,
  V1SessionResponse,
} from "../shared/v1.js";
import {
  createAccessToken,
  createLiveKitMediaToken,
  getRefreshTtlMs,
  readBearerToken,
  verifyAccessToken,
} from "./v1Auth.js";
import { V1RealtimeHub } from "./v1Realtime.js";
import { V1Store, V1StoreError } from "./v1Store.js";

interface RegisterV1RoutesDeps {
  store: V1Store;
  realtimeHub: V1RealtimeHub;
}

interface AuthedRequest extends Request {
  v1User: V1AuthUser;
}

function sendStoreError(error: unknown, res: Response): void {
  if (error instanceof V1StoreError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }

  console.error(error);
  res.status(500).json({ error: "Internal server error." });
}

function parseBody<T>(value: unknown): T {
  return value as T;
}

function authUser(req: Request): V1AuthUser {
  return (req as unknown as AuthedRequest).v1User;
}
function requireAuthUser(req: Request, res: Response, next: NextFunction): void {
  const token = readBearerToken(req.header("authorization") ?? undefined);
  if (!token) {
    res.status(401).json({ error: "Missing Bearer token." });
    return;
  }

  const user = verifyAccessToken(token);
  if (!user) {
    res.status(401).json({ error: "Invalid access token." });
    return;
  }

  (req as unknown as AuthedRequest).v1User = user;
  next();
}

function createRateLimiter(maxHits: number, windowMs: number) {
  const hits = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.ip ?? "unknown"}:${req.path}`;
    const now = Date.now();
    const keepAfter = now - windowMs;
    const current = (hits.get(key) ?? []).filter((timestamp) => timestamp > keepAfter);

    if (current.length >= maxHits) {
      res.status(429).json({ error: "Too many requests." });
      return;
    }

    current.push(now);
    hits.set(key, current);
    next();
  };
}

function buildSessionResponse(user: V1AuthUser, refreshToken: string, refreshTokenExpiresAt: string): V1SessionResponse {
  const access = createAccessToken(user);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken,
    refreshTokenExpiresAt,
    user,
  };
}

export function registerV1Routes(app: Express, deps: RegisterV1RoutesDeps): void {
  const { store, realtimeHub } = deps;
  const router = Router();

  const standardRateLimit = createRateLimiter(120, 60_000);
  const authRateLimit = createRateLimiter(20, 60_000);

  router.use(standardRateLimit);

  router.post("/auth/phone/send-code", authRateLimit, async (req, res) => {
    const input = parseBody<SendOtpCodeInput>(req.body);

    try {
      const result = await store.sendOtpCode(input.phoneNumber);
      res.json({
        sent: true,
        expiresAt: result.expiresAt,
        debugCode: process.env.NODE_ENV === "production" ? undefined : result.debugCode,
      });
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/auth/phone/verify", authRateLimit, async (req, res) => {
    const input = parseBody<VerifyOtpCodeInput>(req.body);

    try {
      const user = await store.verifyOtpCode(input.phoneNumber, input.code, input.displayName);
      const refresh = await store.issueRefreshToken(user.userId, getRefreshTtlMs());
      res.json(buildSessionResponse(user, refresh.token, refresh.expiresAt));
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/auth/refresh", authRateLimit, async (req, res) => {
    const rawToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : "";

    try {
      const rotated = await store.rotateRefreshToken(rawToken, getRefreshTtlMs());
      res.json(buildSessionResponse(rotated.user, rotated.token, rotated.expiresAt));
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.use(requireAuthUser);

  router.post("/auth/logout", async (req, res) => {
    const refreshToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : "";

    try {
      if (refreshToken) {
        await store.revokeRefreshToken(refreshToken);
      }

      res.json({ ok: true });
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.get("/users", async (_req, res) => {
    try {
      const users = await store.listUsers();
      res.json(users);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.get("/friends", async (req, res) => {
    const user = authUser(req);

    try {
      const [friends, requests] = await Promise.all([store.listFriends(user.userId), store.listFriendRequests(user.userId)]);
      res.json({
        friends,
        requests,
      });
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/friends/request", async (req, res) => {
    const user = authUser(req);
    const input = parseBody<FriendRequestInput>(req.body);

    try {
      const requestRecord = await store.createFriendRequest(user.userId, input.targetUserId);
      res.status(201).json(requestRecord);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/friends/request/:requestId/accept", async (req, res) => {
    const user = authUser(req);

    try {
      const requestRecord = await store.respondToFriendRequest(req.params.requestId, user.userId, "accept");
      res.json(requestRecord);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/friends/request/:requestId/decline", async (req, res) => {
    const user = authUser(req);

    try {
      const requestRecord = await store.respondToFriendRequest(req.params.requestId, user.userId, "decline");
      res.json(requestRecord);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.get("/blocks", async (req, res) => {
    const user = authUser(req);

    try {
      const blocks = await store.listBlockedUsers(user.userId);
      res.json(blocks);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/blocks/:blockedUserId", async (req, res) => {
    const user = authUser(req);

    try {
      const block = await store.blockUser(user.userId, req.params.blockedUserId);
      res.status(201).json(block);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.delete("/blocks/:blockedUserId", async (req, res) => {
    const user = authUser(req);

    try {
      await store.unblockUser(user.userId, req.params.blockedUserId);
      res.json({ ok: true });
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/rooms", async (req, res) => {
    const user = authUser(req);
    const input = parseBody<CreateRoomInput>(req.body);

    try {
      const room = await store.createRoom(user.userId, input);
      realtimeHub.emitUserEvent(user.userId, "room_updated", { room });
      res.status(201).json(room);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.get("/rooms", async (req, res) => {
    const user = authUser(req);

    try {
      const rooms = await store.listRoomsForUser(user.userId);
      res.json(rooms);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.get("/rooms/:roomId", async (req, res) => {
    const user = authUser(req);

    try {
      const detail = await store.getRoomDetail(req.params.roomId, user.userId);
      res.json(detail);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/rooms/:roomId/join", async (req, res) => {
    const user = authUser(req);

    try {
      const result = await store.joinRoom(req.params.roomId, user.userId);
      await store.recordMetric("voice_join_success", user.userId, req.params.roomId);
      realtimeHub.emitRoomEvent(req.params.roomId, "member_joined", {
        roomId: req.params.roomId,
        member: result.member,
      });
      res.json(result);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/rooms/:roomId/leave", async (req, res) => {
    const user = authUser(req);

    try {
      const result = await store.leaveRoom(req.params.roomId, user.userId);
      realtimeHub.emitRoomEvent(req.params.roomId, result.roomEnded ? "room_ended" : "member_left", {
        roomId: req.params.roomId,
        userId: user.userId,
      });
      res.json({ ok: true, roomEnded: result.roomEnded });
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/rooms/:roomId/end", async (req, res) => {
    const user = authUser(req);

    try {
      const room = await store.endRoom(req.params.roomId, user.userId);
      realtimeHub.emitRoomEvent(req.params.roomId, "room_ended", {
        roomId: req.params.roomId,
        room,
      });
      res.json(room);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.patch("/rooms/:roomId/privacy", async (req, res) => {
    const user = authUser(req);
    const input = parseBody<UpdateRoomPrivacyInput>(req.body);

    try {
      const room = await store.setRoomPrivacy(req.params.roomId, user.userId, input.privacy);
      realtimeHub.emitRoomEvent(req.params.roomId, "room_updated", {
        roomId: req.params.roomId,
        room,
      });
      res.json(room);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/rooms/:roomId/media-token", async (req, res) => {
    const user = authUser(req);

    try {
      await store.getRoomDetail(req.params.roomId, user.userId);
      const mediaToken = createLiveKitMediaToken({
        roomId: req.params.roomId,
        userId: user.userId,
        displayName: user.displayName,
      });

      res.json({
        roomId: req.params.roomId,
        userId: user.userId,
        provider: mediaToken.provider,
        token: mediaToken.token,
        expiresAt: mediaToken.expiresAt,
      });
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.get("/rooms/:roomId/messages", async (req, res) => {
    const user = authUser(req);

    try {
      const messages = await store.listMessages(req.params.roomId, user.userId);
      res.json(messages);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/rooms/:roomId/messages", async (req, res) => {
    const user = authUser(req);
    const body = parseBody<CreateMessageInput>(req.body);
    const idempotencyHeader = req.header("Idempotency-Key");
    const startAt = Date.now();

    try {
      const created = await store.createMessage(req.params.roomId, user.userId, {
        ...body,
        idempotencyKey: body.idempotencyKey ?? idempotencyHeader ?? undefined,
      });

      const deliveryMs = Date.now() - startAt;
      await store.recordMetric("message_delivery_ms", user.userId, req.params.roomId, deliveryMs);
      realtimeHub.emitRoomEvent(req.params.roomId, "message_created", {
        roomId: req.params.roomId,
        message: created.message,
      });

      res.status(created.duplicate ? 200 : 201).json(created.message);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/invites", async (req, res) => {
    const user = authUser(req);
    const input = parseBody<CreateInviteInput>(req.body);

    try {
      const invite = await store.createInvite(input.roomId, user.userId, input.targetUserId);
      await store.recordMetric("nudge_sent", user.userId, input.roomId);
      if (input.targetUserId) {
        realtimeHub.emitUserEvent(input.targetUserId, "room_updated", {
          roomId: input.roomId,
          inviteCode: invite.code,
        });
      }
      res.status(201).json(invite);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/invites/:code/accept", async (req, res) => {
    const user = authUser(req);

    try {
      const accepted = await store.acceptInvite(req.params.code, user.userId);
      await store.recordMetric("invite_accepted", user.userId, accepted.room.roomId);
      realtimeHub.emitRoomEvent(accepted.room.roomId, "member_joined", {
        roomId: accepted.room.roomId,
        member: accepted.member,
      });
      res.json(accepted);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/push/register", async (req, res) => {
    const user = authUser(req);
    const input = parseBody<RegisterPushTokenInput>(req.body);

    try {
      const record = await store.registerPushToken(user.userId, input.token, input.platform);
      res.status(201).json(record);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/push/unregister", async (req, res) => {
    const user = authUser(req);
    const token = typeof req.body?.token === "string" ? req.body.token : "";

    try {
      await store.unregisterPushToken(user.userId, token);
      res.json({ ok: true });
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/rooms/:roomId/moderation/mute", async (req, res) => {
    const user = authUser(req);
    const targetUserId = typeof req.body?.userId === "string" ? req.body.userId : "";
    const muted = req.body?.muted === undefined ? true : Boolean(req.body?.muted);

    try {
      const member = await store.muteRoomMember(req.params.roomId, user.userId, targetUserId, muted);
      realtimeHub.emitRoomEvent(req.params.roomId, "room_updated", {
        roomId: req.params.roomId,
        member,
      });
      res.json(member);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/rooms/:roomId/moderation/remove", async (req, res) => {
    const user = authUser(req);
    const targetUserId = typeof req.body?.userId === "string" ? req.body.userId : "";

    try {
      await store.removeRoomMember(req.params.roomId, user.userId, targetUserId);
      realtimeHub.emitRoomEvent(req.params.roomId, "member_left", {
        roomId: req.params.roomId,
        userId: targetUserId,
      });
      res.json({ ok: true });
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/rooms/:roomId/report", async (req, res) => {
    const user = authUser(req);
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";

    try {
      const report = await store.createRoomReport(req.params.roomId, user.userId, reason);
      res.status(201).json(report);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.post("/events", async (req, res) => {
    const user = authUser(req);
    const input = parseBody<RecordMetricInput>(req.body);

    try {
      const metric = await store.recordMetric(input.eventName, user.userId, input.roomId, input.value);
      res.status(201).json(metric);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.get("/events/summary", async (_req, res) => {
    try {
      const summary = await store.getMetricSummary();
      res.json(summary);
    } catch (error) {
      sendStoreError(error, res);
    }
  });

  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "mercury-v1",
      now: new Date().toISOString(),
    });
  });

  app.use("/api/v1", router);
}
