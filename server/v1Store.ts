import { randomInt, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CreateMessageInput,
  CreateRoomInput,
  DevicePushTokenRecord,
  EventMetricRecord,
  FriendRecord,
  FriendRequestRecord,
  FriendRequestStatus,
  InviteRecord,
  MetricSummaryResponse,
  PlatformType,
  PresenceSnapshot,
  ReliabilityEventName,
  RoomDetail,
  RoomMemberRecord,
  RoomMessageRecord,
  RoomPrivacy,
  RoomRecord,
  RoomReportRecord,
  RoomSessionRecord,
  RoomSummary,
  UserBlockRecord,
  V1AuthUser,
} from "../shared/v1.js";

interface OtpRecord {
  otpId: string;
  phoneNumber: string;
  code: string;
  expiresAt: string;
}

interface RefreshTokenRecord {
  refreshTokenId: string;
  userId: string;
  token: string;
  expiresAt: string;
  revokedAt: string | null;
}

interface UserEntity extends V1AuthUser {
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface V1State {
  users: UserEntity[];
  friendRequests: FriendRequestRecord[];
  friendships: FriendRecord[];
  rooms: RoomRecord[];
  roomMembers: RoomMemberRecord[];
  roomSessions: RoomSessionRecord[];
  messages: RoomMessageRecord[];
  invites: InviteRecord[];
  devicePushTokens: DevicePushTokenRecord[];
  eventMetrics: EventMetricRecord[];
  roomReports: RoomReportRecord[];
  userBlocks: UserBlockRecord[];
  otpCodes: OtpRecord[];
  refreshTokens: RefreshTokenRecord[];
  presence: PresenceSnapshot[];
}

const storeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(storeRoot, "data", "dev");
const statePath = path.join(dataDir, "v1-state.json");

const METRICS: ReliabilityEventName[] = [
  "share_clicked",
  "invite_accepted",
  "nudge_sent",
  "nudge_opened",
  "join_within_2m",
  "voice_join_success",
  "call_drop",
  "reconnect_success",
  "message_delivery_ms",
];

class Mutex {
  private queue = Promise.resolve();

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export class V1StoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sanitizePhone(raw: string): string {
  const candidate = raw.trim();
  if (!/^\+?[1-9]\d{7,14}$/.test(candidate)) {
    throw new V1StoreError(400, "INVALID_PHONE", "phoneNumber must be E.164-like.");
  }

  return candidate.startsWith("+") ? candidate : `+${candidate}`;
}

function makeState(): V1State {
  return {
    users: [],
    friendRequests: [],
    friendships: [],
    rooms: [],
    roomMembers: [],
    roomSessions: [],
    messages: [],
    invites: [],
    devicePushTokens: [],
    eventMetrics: [],
    roomReports: [],
    userBlocks: [],
    otpCodes: [],
    refreshTokens: [],
    presence: [],
  };
}

async function atomicWrite(filePath: string, payload: unknown): Promise<void> {
  const next = `${JSON.stringify(payload, null, 2)}\n`;
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, next, "utf8");
  await fs.rename(temp, filePath);
}

function sameFriendPair(a: string, b: string, record: FriendRecord): boolean {
  return (record.userAId === a && record.userBId === b) || (record.userAId === b && record.userBId === a);
}

function createInviteCode(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function createOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export class V1Store {
  private readonly mutex = new Mutex();
  private state: V1State | null = null;
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.state) {
      return;
    }

    if (!this.initPromise) {
      this.initPromise = (async () => {
        await fs.mkdir(dataDir, { recursive: true });

        try {
          const raw = await fs.readFile(statePath, "utf8");
          this.state = JSON.parse(raw) as V1State;
        } catch {
          this.state = makeState();
          await atomicWrite(statePath, this.state);
        }
      })();
    }

    await this.initPromise;
  }

  private async withState<T>(task: (state: V1State) => T | Promise<T>, persist = false): Promise<T> {
    await this.initialize();

    return this.mutex.runExclusive(async () => {
      if (!this.state) {
        throw new Error("v1 store unavailable");
      }

      this.prune(this.state);
      const result = await task(this.state);

      if (persist) {
        await atomicWrite(statePath, this.state);
      }

      return result;
    });
  }

  private prune(state: V1State): void {
    const now = Date.now();
    state.otpCodes = state.otpCodes.filter((item) => new Date(item.expiresAt).getTime() > now);
    state.refreshTokens = state.refreshTokens.filter(
      (item) => item.revokedAt === null || new Date(item.expiresAt).getTime() > now,
    );
    state.invites = state.invites.filter((item) => item.acceptedAt !== null || new Date(item.expiresAt).getTime() > now);
  }

  private requireUser(state: V1State, userId: string): UserEntity {
    const user = state.users.find((item) => item.userId === userId && item.deletedAt === null);
    if (!user) {
      throw new V1StoreError(404, "USER_NOT_FOUND", `User ${userId} was not found.`);
    }

    return user;
  }

  private requireRoom(state: V1State, roomId: string): RoomRecord {
    const room = state.rooms.find((item) => item.roomId === roomId);
    if (!room) {
      throw new V1StoreError(404, "ROOM_NOT_FOUND", `Room ${roomId} was not found.`);
    }

    return room;
  }

  private getActiveMember(state: V1State, roomId: string, userId: string): RoomMemberRecord | null {
    return state.roomMembers.find((item) => item.roomId === roomId && item.userId === userId && item.leftAt === null) ?? null;
  }

  private areFriends(state: V1State, a: string, b: string): boolean {
    return state.friendships.some((item) => sameFriendPair(a, b, item));
  }

  private hasBlock(state: V1State, a: string, b: string): boolean {
    return state.userBlocks.some(
      (item) => (item.blockerUserId === a && item.blockedUserId === b) || (item.blockerUserId === b && item.blockedUserId === a),
    );
  }

  private canAccessRoom(state: V1State, userId: string, room: RoomRecord): boolean {
    if (room.privacy === "public") {
      return true;
    }

    if (this.getActiveMember(state, room.roomId, userId)) {
      return true;
    }

    if (this.areFriends(state, userId, room.hostUserId)) {
      return true;
    }

    return state.invites.some((item) => item.roomId === room.roomId && item.acceptedByUserId === userId);
  }

  async sendOtpCode(rawPhoneNumber: string): Promise<{ expiresAt: string; debugCode: string }> {
    return this.withState((state) => {
      const phoneNumber = sanitizePhone(rawPhoneNumber);
      const debugCode = createOtpCode();
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

      state.otpCodes = state.otpCodes.filter((item) => item.phoneNumber !== phoneNumber);
      state.otpCodes.push({
        otpId: randomUUID(),
        phoneNumber,
        code: debugCode,
        expiresAt,
      });

      return { expiresAt, debugCode };
    }, true);
  }

  async verifyOtpCode(rawPhoneNumber: string, rawCode: string, displayName?: string): Promise<V1AuthUser> {
    return this.withState((state) => {
      const phoneNumber = sanitizePhone(rawPhoneNumber);
      const code = rawCode.trim();

      const otp = state.otpCodes.find((item) => item.phoneNumber === phoneNumber && item.code === code);
      if (!otp) {
        throw new V1StoreError(400, "OTP_INVALID", "Code is invalid or expired.");
      }

      state.otpCodes = state.otpCodes.filter((item) => item.otpId !== otp.otpId);

      let user = state.users.find((item) => item.phoneNumber === phoneNumber && item.deletedAt === null);
      if (!user) {
        const fallback = `Friend ${phoneNumber.slice(-4)}`;
        user = {
          userId: `user_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          phoneNumber,
          displayName: (displayName?.trim() || fallback).slice(0, 60),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          deletedAt: null,
        };
        state.users.push(user);
      }

      return {
        userId: user.userId,
        phoneNumber: user.phoneNumber,
        displayName: user.displayName,
      };
    }, true);
  }

  async issueRefreshToken(userId: string, ttlMs: number): Promise<{ token: string; expiresAt: string }> {
    return this.withState((state) => {
      this.requireUser(state, userId);
      const token = randomUUID();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();

      state.refreshTokens.push({
        refreshTokenId: randomUUID(),
        userId,
        token,
        expiresAt,
        revokedAt: null,
      });

      return { token, expiresAt };
    }, true);
  }

  async rotateRefreshToken(token: string, ttlMs: number): Promise<{ user: V1AuthUser; token: string; expiresAt: string }> {
    return this.withState((state) => {
      const current = state.refreshTokens.find((item) => item.token === token && item.revokedAt === null);
      if (!current || new Date(current.expiresAt).getTime() <= Date.now()) {
        throw new V1StoreError(401, "REFRESH_INVALID", "Refresh token invalid or expired.");
      }

      current.revokedAt = nowIso();
      const user = this.requireUser(state, current.userId);
      const nextToken = randomUUID();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();

      state.refreshTokens.push({
        refreshTokenId: randomUUID(),
        userId: user.userId,
        token: nextToken,
        expiresAt,
        revokedAt: null,
      });

      return {
        user: {
          userId: user.userId,
          phoneNumber: user.phoneNumber,
          displayName: user.displayName,
        },
        token: nextToken,
        expiresAt,
      };
    }, true);
  }

  async revokeRefreshToken(token: string): Promise<void> {
    await this.withState((state) => {
      const record = state.refreshTokens.find((item) => item.token === token && item.revokedAt === null);
      if (record) {
        record.revokedAt = nowIso();
      }
    }, true);
  }

  async getUser(userId: string): Promise<V1AuthUser> {
    return this.withState((state) => {
      const user = this.requireUser(state, userId);
      return {
        userId: user.userId,
        phoneNumber: user.phoneNumber,
        displayName: user.displayName,
      };
    });
  }

  async listUsers(): Promise<V1AuthUser[]> {
    return this.withState((state) =>
      state.users
        .filter((item) => item.deletedAt === null)
        .map((item) => ({ userId: item.userId, phoneNumber: item.phoneNumber, displayName: item.displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    );
  }

  async listFriends(userId: string): Promise<V1AuthUser[]> {
    return this.withState((state) => {
      this.requireUser(state, userId);

      const ids = state.friendships
        .filter((item) => item.userAId === userId || item.userBId === userId)
        .map((item) => (item.userAId === userId ? item.userBId : item.userAId));

      return ids.map((id) => {
        const user = this.requireUser(state, id);
        return {
          userId: user.userId,
          phoneNumber: user.phoneNumber,
          displayName: user.displayName,
        };
      });
    });
  }

  async listFriendRequests(userId: string): Promise<FriendRequestRecord[]> {
    return this.withState((state) => {
      this.requireUser(state, userId);
      return clone(
        state.friendRequests
          .filter((item) => item.fromUserId === userId || item.toUserId === userId)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      );
    });
  }

  async createFriendRequest(fromUserId: string, toUserId: string): Promise<FriendRequestRecord> {
    return this.withState((state) => {
      if (fromUserId === toUserId) {
        throw new V1StoreError(400, "FRIEND_SELF", "Cannot friend yourself.");
      }

      this.requireUser(state, fromUserId);
      this.requireUser(state, toUserId);

      if (this.hasBlock(state, fromUserId, toUserId)) {
        throw new V1StoreError(403, "FRIEND_BLOCKED", "Cannot send request because user is blocked.");
      }

      if (this.areFriends(state, fromUserId, toUserId)) {
        throw new V1StoreError(409, "ALREADY_FRIENDS", "Users are already friends.");
      }

      const existing = state.friendRequests.find(
        (item) =>
          item.status === "pending" &&
          ((item.fromUserId === fromUserId && item.toUserId === toUserId) ||
            (item.fromUserId === toUserId && item.toUserId === fromUserId)),
      );

      if (existing) {
        if (existing.fromUserId === toUserId) {
          existing.status = "accepted";
          existing.respondedAt = nowIso();
          state.friendships.push({
            friendshipId: randomUUID(),
            userAId: fromUserId,
            userBId: toUserId,
            createdAt: nowIso(),
          });
          return clone(existing);
        }

        throw new V1StoreError(409, "FRIEND_REQUEST_EXISTS", "Request already pending.");
      }

      const created: FriendRequestRecord = {
        requestId: randomUUID(),
        fromUserId,
        toUserId,
        status: "pending",
        createdAt: nowIso(),
        respondedAt: null,
      };
      state.friendRequests.push(created);

      return clone(created);
    }, true);
  }

  async respondToFriendRequest(requestId: string, actorUserId: string, action: "accept" | "decline"): Promise<FriendRequestRecord> {
    return this.withState((state) => {
      const request = state.friendRequests.find((item) => item.requestId === requestId);
      if (!request) {
        throw new V1StoreError(404, "FRIEND_REQUEST_NOT_FOUND", "Friend request not found.");
      }

      if (request.toUserId !== actorUserId) {
        throw new V1StoreError(403, "FRIEND_REQUEST_FORBIDDEN", "Cannot respond to this request.");
      }

      if (request.status !== "pending") {
        return clone(request);
      }

      request.status = action === "accept" ? "accepted" : "declined";
      request.respondedAt = nowIso();

      if (action === "accept" && !this.areFriends(state, request.fromUserId, request.toUserId)) {
        state.friendships.push({
          friendshipId: randomUUID(),
          userAId: request.fromUserId,
          userBId: request.toUserId,
          createdAt: nowIso(),
        });
      }

      return clone(request);
    }, true);
  }

  async blockUser(blockerUserId: string, blockedUserId: string): Promise<UserBlockRecord> {
    return this.withState((state) => {
      this.requireUser(state, blockerUserId);
      this.requireUser(state, blockedUserId);

      const existing = state.userBlocks.find(
        (item) => item.blockerUserId === blockerUserId && item.blockedUserId === blockedUserId,
      );
      if (existing) {
        return clone(existing);
      }

      state.friendships = state.friendships.filter((item) => !sameFriendPair(blockerUserId, blockedUserId, item));

      const block: UserBlockRecord = {
        blockId: randomUUID(),
        blockerUserId,
        blockedUserId,
        createdAt: nowIso(),
      };
      state.userBlocks.push(block);

      return clone(block);
    }, true);
  }

  async unblockUser(blockerUserId: string, blockedUserId: string): Promise<void> {
    await this.withState((state) => {
      state.userBlocks = state.userBlocks.filter(
        (item) => !(item.blockerUserId === blockerUserId && item.blockedUserId === blockedUserId),
      );
    }, true);
  }

  async listBlockedUsers(blockerUserId: string): Promise<UserBlockRecord[]> {
    return this.withState((state) => clone(state.userBlocks.filter((item) => item.blockerUserId === blockerUserId)));
  }

  async createRoom(hostUserId: string, input: CreateRoomInput): Promise<RoomRecord> {
    return this.withState((state) => {
      this.requireUser(state, hostUserId);

      const title = input.title.trim();
      if (!title) {
        throw new V1StoreError(400, "ROOM_TITLE_REQUIRED", "title is required.");
      }

      const now = nowIso();
      const room: RoomRecord = {
        roomId: `room_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        hostUserId,
        title: title.slice(0, 120),
        privacy: input.privacy ?? "private",
        isActive: true,
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      };

      state.rooms.push(room);
      state.roomMembers.push({
        roomMemberId: randomUUID(),
        roomId: room.roomId,
        userId: hostUserId,
        role: "host",
        muted: false,
        unreadCount: 0,
        lastReadAt: now,
        joinedAt: now,
        updatedAt: now,
        leftAt: null,
      });

      return clone(room);
    }, true);
  }

  async listRoomsForUser(userId: string): Promise<RoomSummary[]> {
    return this.withState((state) => {
      this.requireUser(state, userId);

      return clone(
        state.rooms
          .filter((room) => room.isActive)
          .filter((room) => this.canAccessRoom(state, userId, room))
          .map((room) => ({
            roomId: room.roomId,
            title: room.title,
            privacy: room.privacy,
            isActive: room.isActive,
            hostUserId: room.hostUserId,
            participantCount: state.roomMembers.filter((member) => member.roomId === room.roomId && member.leftAt === null).length,
            createdAt: room.createdAt,
            updatedAt: room.updatedAt,
          }))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      );
    });
  }

  async getRoomDetail(roomId: string, userId: string): Promise<RoomDetail> {
    return this.withState((state) => {
      const room = this.requireRoom(state, roomId);
      if (!this.canAccessRoom(state, userId, room)) {
        throw new V1StoreError(403, "ROOM_FORBIDDEN", "Room access denied.");
      }

      const me = this.getActiveMember(state, roomId, userId);
      if (me) {
        me.unreadCount = 0;
        me.lastReadAt = nowIso();
        me.updatedAt = nowIso();
      }

      return {
        room: clone(room),
        members: clone(state.roomMembers.filter((member) => member.roomId === roomId && member.leftAt === null)),
        messages: clone(
          state.messages
            .filter((message) => message.roomId === roomId)
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
            .slice(-100),
        ),
      };
    }, true);
  }

  async joinRoom(roomId: string, userId: string): Promise<{ room: RoomRecord; member: RoomMemberRecord }> {
    return this.withState((state) => {
      const room = this.requireRoom(state, roomId);
      this.requireUser(state, userId);

      if (!room.isActive) {
        throw new V1StoreError(409, "ROOM_ENDED", "Room is offline.");
      }

      if (this.hasBlock(state, room.hostUserId, userId)) {
        throw new V1StoreError(403, "ROOM_BLOCKED", "Room access denied.");
      }

      if (!this.canAccessRoom(state, userId, room)) {
        throw new V1StoreError(403, "ROOM_PRIVATE", "Private room requires invite/friend access.");
      }

      const now = nowIso();
      let member = state.roomMembers.find((item) => item.roomId === roomId && item.userId === userId);
      if (!member) {
        member = {
          roomMemberId: randomUUID(),
          roomId,
          userId,
          role: room.hostUserId === userId ? "host" : "member",
          muted: false,
          unreadCount: 0,
          lastReadAt: now,
          joinedAt: now,
          updatedAt: now,
          leftAt: null,
        };
        state.roomMembers.push(member);
      } else {
        member.leftAt = null;
        member.updatedAt = now;
      }

      state.roomSessions.push({
        roomSessionId: randomUUID(),
        roomId,
        userId,
        joinedAt: now,
        leftAt: null,
      });

      room.updatedAt = now;

      return {
        room: clone(room),
        member: clone(member),
      };
    }, true);
  }

  async leaveRoom(roomId: string, userId: string): Promise<{ roomEnded: boolean }> {
    return this.withState((state) => {
      const room = this.requireRoom(state, roomId);
      const member = this.getActiveMember(state, roomId, userId);
      if (!member) {
        throw new V1StoreError(404, "MEMBER_NOT_FOUND", "You are not currently in this room.");
      }

      const now = nowIso();
      let roomEnded = false;

      if (room.hostUserId === userId) {
        roomEnded = true;
        room.isActive = false;
        room.endedAt = now;
      }

      for (const item of state.roomMembers) {
        if (item.roomId !== roomId || item.leftAt !== null) {
          continue;
        }

        if (roomEnded || item.userId === userId) {
          item.leftAt = now;
          item.updatedAt = now;
        }
      }

      for (const session of state.roomSessions) {
        if (session.roomId === roomId && session.userId === userId && session.leftAt === null) {
          session.leftAt = now;
        }
      }

      room.updatedAt = now;
      return { roomEnded };
    }, true);
  }

  async endRoom(roomId: string, hostUserId: string): Promise<RoomRecord> {
    const result = await this.leaveRoom(roomId, hostUserId);
    if (!result.roomEnded) {
      throw new V1StoreError(403, "ROOM_HOST_ONLY", "Only host can end room.");
    }

    return this.withState((state) => clone(this.requireRoom(state, roomId)));
  }

  async setRoomPrivacy(roomId: string, hostUserId: string, privacy: RoomPrivacy): Promise<RoomRecord> {
    return this.withState((state) => {
      const room = this.requireRoom(state, roomId);
      if (room.hostUserId !== hostUserId) {
        throw new V1StoreError(403, "ROOM_HOST_ONLY", "Only host can change privacy.");
      }

      room.privacy = privacy;
      room.updatedAt = nowIso();
      return clone(room);
    }, true);
  }

  async muteRoomMember(roomId: string, hostUserId: string, targetUserId: string, muted: boolean): Promise<RoomMemberRecord> {
    return this.withState((state) => {
      const room = this.requireRoom(state, roomId);
      if (room.hostUserId !== hostUserId) {
        throw new V1StoreError(403, "ROOM_HOST_ONLY", "Only host can mute members.");
      }

      const member = this.getActiveMember(state, roomId, targetUserId);
      if (!member) {
        throw new V1StoreError(404, "MEMBER_NOT_FOUND", "Member not found in room.");
      }

      member.muted = muted;
      member.updatedAt = nowIso();
      return clone(member);
    }, true);
  }

  async removeRoomMember(roomId: string, hostUserId: string, targetUserId: string): Promise<void> {
    await this.withState((state) => {
      const room = this.requireRoom(state, roomId);
      if (room.hostUserId !== hostUserId) {
        throw new V1StoreError(403, "ROOM_HOST_ONLY", "Only host can remove members.");
      }

      if (targetUserId === hostUserId) {
        throw new V1StoreError(400, "HOST_REMOVE_INVALID", "Host cannot remove self.");
      }

      const member = this.getActiveMember(state, roomId, targetUserId);
      if (!member) {
        throw new V1StoreError(404, "MEMBER_NOT_FOUND", "Member not found in room.");
      }

      member.leftAt = nowIso();
      member.updatedAt = nowIso();
    }, true);
  }

  async listMessages(roomId: string, userId: string): Promise<RoomMessageRecord[]> {
    return this.withState((state) => {
      const room = this.requireRoom(state, roomId);
      if (!this.canAccessRoom(state, userId, room)) {
        throw new V1StoreError(403, "ROOM_FORBIDDEN", "Room access denied.");
      }

      return clone(
        state.messages
          .filter((item) => item.roomId === roomId)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .slice(-250),
      );
    });
  }

  async createMessage(roomId: string, userId: string, input: CreateMessageInput): Promise<{ message: RoomMessageRecord; duplicate: boolean }> {
    return this.withState((state) => {
      const room = this.requireRoom(state, roomId);
      if (!this.canAccessRoom(state, userId, room)) {
        throw new V1StoreError(403, "ROOM_FORBIDDEN", "Room access denied.");
      }

      const member = this.getActiveMember(state, roomId, userId);
      if (!member) {
        throw new V1StoreError(403, "MESSAGE_JOIN_REQUIRED", "Join room before sending messages.");
      }

      if (member.muted) {
        throw new V1StoreError(403, "MESSAGE_MUTED", "Muted users cannot send messages.");
      }

      const text = input.text.trim();
      if (!text) {
        throw new V1StoreError(400, "MESSAGE_REQUIRED", "text is required.");
      }

      const idempotencyKey = input.idempotencyKey?.trim() || null;
      if (idempotencyKey) {
        const existing = state.messages.find(
          (item) => item.roomId === roomId && item.userId === userId && item.idempotencyKey === idempotencyKey,
        );
        if (existing) {
          return { message: clone(existing), duplicate: true };
        }
      }

      const message: RoomMessageRecord = {
        messageId: randomUUID(),
        roomId,
        userId,
        text: text.slice(0, 1000),
        idempotencyKey,
        createdAt: nowIso(),
      };
      state.messages.push(message);
      room.updatedAt = message.createdAt;

      for (const roomMember of state.roomMembers) {
        if (roomMember.roomId !== roomId || roomMember.leftAt !== null) {
          continue;
        }

        if (roomMember.userId === userId) {
          roomMember.unreadCount = 0;
          roomMember.lastReadAt = message.createdAt;
        } else {
          roomMember.unreadCount += 1;
        }
        roomMember.updatedAt = message.createdAt;
      }

      return { message: clone(message), duplicate: false };
    }, true);
  }

  async createInvite(roomId: string, createdByUserId: string, targetUserId?: string): Promise<InviteRecord> {
    return this.withState((state) => {
      const room = this.requireRoom(state, roomId);
      if (!this.canAccessRoom(state, createdByUserId, room)) {
        throw new V1StoreError(403, "ROOM_FORBIDDEN", "Room access denied.");
      }

      if (targetUserId) {
        this.requireUser(state, targetUserId);
      }

      const invite: InviteRecord = {
        inviteId: randomUUID(),
        code: createInviteCode(),
        roomId,
        createdByUserId,
        targetUserId: targetUserId ?? null,
        acceptedByUserId: null,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        acceptedAt: null,
      };

      state.invites.push(invite);
      return clone(invite);
    }, true);
  }

  async acceptInvite(code: string, userId: string): Promise<{ invite: InviteRecord; room: RoomRecord; member: RoomMemberRecord }> {
    return this.withState((state) => {
      const invite = state.invites.find((item) => item.code === code);
      if (!invite) {
        throw new V1StoreError(404, "INVITE_NOT_FOUND", "Invite not found.");
      }

      if (new Date(invite.expiresAt).getTime() <= Date.now()) {
        throw new V1StoreError(410, "INVITE_EXPIRED", "Invite has expired.");
      }

      if (invite.targetUserId && invite.targetUserId !== userId) {
        throw new V1StoreError(403, "INVITE_FORBIDDEN", "Invite is restricted to another user.");
      }

      invite.acceptedByUserId = userId;
      invite.acceptedAt = nowIso();

      const join = this.joinRoomInline(state, invite.roomId, userId);
      return {
        invite: clone(invite),
        room: clone(join.room),
        member: clone(join.member),
      };
    }, true);
  }

  private joinRoomInline(state: V1State, roomId: string, userId: string): { room: RoomRecord; member: RoomMemberRecord } {
    const room = this.requireRoom(state, roomId);
    if (!this.canAccessRoom(state, userId, room)) {
      throw new V1StoreError(403, "ROOM_FORBIDDEN", "Room access denied.");
    }

    const now = nowIso();
    let member = state.roomMembers.find((item) => item.roomId === roomId && item.userId === userId);
    if (!member) {
      member = {
        roomMemberId: randomUUID(),
        roomId,
        userId,
        role: room.hostUserId === userId ? "host" : "member",
        muted: false,
        unreadCount: 0,
        lastReadAt: now,
        joinedAt: now,
        updatedAt: now,
        leftAt: null,
      };
      state.roomMembers.push(member);
    } else {
      member.leftAt = null;
      member.updatedAt = now;
    }

    state.roomSessions.push({
      roomSessionId: randomUUID(),
      roomId,
      userId,
      joinedAt: now,
      leftAt: null,
    });

    room.updatedAt = now;
    return { room, member };
  }

  async registerPushToken(userId: string, token: string, platform: PlatformType): Promise<DevicePushTokenRecord> {
    return this.withState((state) => {
      this.requireUser(state, userId);
      const trimmed = token.trim();
      if (!trimmed) {
        throw new V1StoreError(400, "PUSH_TOKEN_REQUIRED", "Push token is required.");
      }

      const existing = state.devicePushTokens.find((item) => item.userId === userId && item.token === trimmed);
      if (existing) {
        existing.platform = platform;
        existing.updatedAt = nowIso();
        return clone(existing);
      }

      const created: DevicePushTokenRecord = {
        devicePushTokenId: randomUUID(),
        userId,
        platform,
        token: trimmed,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.devicePushTokens.push(created);
      return clone(created);
    }, true);
  }

  async unregisterPushToken(userId: string, token: string): Promise<void> {
    await this.withState((state) => {
      state.devicePushTokens = state.devicePushTokens.filter((item) => !(item.userId === userId && item.token === token));
    }, true);
  }

  async recordMetric(eventName: ReliabilityEventName, userId: string, roomId?: string, value?: number): Promise<EventMetricRecord> {
    return this.withState((state) => {
      this.requireUser(state, userId);
      if (!METRICS.includes(eventName)) {
        throw new V1StoreError(400, "METRIC_EVENT_INVALID", "Unsupported eventName.");
      }

      if (roomId) {
        this.requireRoom(state, roomId);
      }

      const record: EventMetricRecord = {
        metricId: randomUUID(),
        eventName,
        userId,
        roomId: roomId ?? null,
        value: typeof value === "number" ? value : null,
        createdAt: nowIso(),
      };
      state.eventMetrics.push(record);
      return clone(record);
    }, true);
  }

  async getMetricSummary(): Promise<MetricSummaryResponse> {
    return this.withState((state) => ({
      metrics: METRICS.map((eventName) => {
        const matching = state.eventMetrics.filter((item) => item.eventName === eventName);
        const values = matching.map((item) => item.value).filter((item): item is number => typeof item === "number");

        return {
          eventName,
          count: matching.length,
          averageValue: values.length > 0 ? values.reduce((sum, item) => sum + item, 0) / values.length : null,
        };
      }),
    }));
  }

  async createRoomReport(roomId: string, reporterUserId: string, reason: string): Promise<RoomReportRecord> {
    return this.withState((state) => {
      this.requireRoom(state, roomId);
      this.requireUser(state, reporterUserId);

      const trimmed = reason.trim();
      if (!trimmed) {
        throw new V1StoreError(400, "REPORT_REASON_REQUIRED", "reason is required.");
      }

      const report: RoomReportRecord = {
        reportId: randomUUID(),
        roomId,
        reporterUserId,
        reason: trimmed.slice(0, 800),
        createdAt: nowIso(),
      };

      state.roomReports.push(report);
      return clone(report);
    }, true);
  }

  async updatePresence(userId: string, status: PresenceSnapshot["status"], roomId?: string): Promise<PresenceSnapshot> {
    return this.withState((state) => {
      this.requireUser(state, userId);
      const existing = state.presence.find((item) => item.userId === userId);

      const snapshot: PresenceSnapshot = {
        userId,
        status,
        roomId: roomId ?? null,
        updatedAt: nowIso(),
      };

      if (!existing) {
        state.presence.push(snapshot);
        return clone(snapshot);
      }

      existing.status = status;
      existing.roomId = roomId ?? null;
      existing.updatedAt = snapshot.updatedAt;
      return clone(existing);
    }, true);
  }

  async getRoomMembers(roomId: string): Promise<RoomMemberRecord[]> {
    return this.withState((state) => clone(state.roomMembers.filter((item) => item.roomId === roomId && item.leftAt === null)));
  }
}

let v1Store: V1Store | null = null;

export function getV1Store(): V1Store {
  if (!v1Store) {
    v1Store = new V1Store();
  }

  return v1Store;
}
