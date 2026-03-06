export type RoomPrivacy = "private" | "public";
export type PlatformType = "ios" | "android" | "web";
export type RoomRole = "host" | "member";
export type FriendRequestStatus = "pending" | "accepted" | "declined" | "cancelled";
export type PresenceStatus = "offline" | "online" | "in_room";

export type ReliabilityEventName =
  | "share_clicked"
  | "invite_accepted"
  | "nudge_sent"
  | "nudge_opened"
  | "join_within_2m"
  | "voice_join_success"
  | "call_drop"
  | "reconnect_success"
  | "message_delivery_ms";

export interface V1AuthUser {
  userId: string;
  phoneNumber: string;
  displayName: string;
}

export interface V1SessionResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  user: V1AuthUser;
}

export interface SendOtpCodeInput {
  phoneNumber: string;
}

export interface SendOtpCodeResponse {
  sent: true;
  expiresAt: string;
  debugCode?: string;
}

export interface VerifyOtpCodeInput {
  phoneNumber: string;
  code: string;
  displayName?: string;
}

export interface RefreshSessionInput {
  refreshToken: string;
}

export interface FriendRequestRecord {
  requestId: string;
  fromUserId: string;
  toUserId: string;
  status: FriendRequestStatus;
  createdAt: string;
  respondedAt: string | null;
}

export interface FriendRecord {
  friendshipId: string;
  userAId: string;
  userBId: string;
  createdAt: string;
}

export interface RoomRecord {
  roomId: string;
  hostUserId: string;
  title: string;
  privacy: RoomPrivacy;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface RoomMemberRecord {
  roomMemberId: string;
  roomId: string;
  userId: string;
  role: RoomRole;
  muted: boolean;
  unreadCount: number;
  lastReadAt: string | null;
  joinedAt: string;
  updatedAt: string;
  leftAt: string | null;
}

export interface RoomSessionRecord {
  roomSessionId: string;
  roomId: string;
  userId: string;
  joinedAt: string;
  leftAt: string | null;
}

export interface RoomMessageRecord {
  messageId: string;
  roomId: string;
  userId: string;
  text: string;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface InviteRecord {
  inviteId: string;
  code: string;
  roomId: string;
  createdByUserId: string;
  targetUserId: string | null;
  acceptedByUserId: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

export interface DevicePushTokenRecord {
  devicePushTokenId: string;
  userId: string;
  platform: PlatformType;
  token: string;
  createdAt: string;
  updatedAt: string;
}

export interface EventMetricRecord {
  metricId: string;
  eventName: ReliabilityEventName;
  userId: string;
  roomId: string | null;
  value: number | null;
  createdAt: string;
}

export interface RoomReportRecord {
  reportId: string;
  roomId: string;
  reporterUserId: string;
  reason: string;
  createdAt: string;
}

export interface UserBlockRecord {
  blockId: string;
  blockerUserId: string;
  blockedUserId: string;
  createdAt: string;
}

export interface RoomSummary {
  roomId: string;
  title: string;
  privacy: RoomPrivacy;
  isActive: boolean;
  hostUserId: string;
  participantCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoomDetail {
  room: RoomRecord;
  members: RoomMemberRecord[];
  messages: RoomMessageRecord[];
}

export interface CreateRoomInput {
  title: string;
  privacy?: RoomPrivacy;
}

export interface JoinRoomResponse {
  room: RoomRecord;
  member: RoomMemberRecord;
}

export interface LeaveRoomResponse {
  ok: true;
  roomEnded: boolean;
}

export interface UpdateRoomPrivacyInput {
  privacy: RoomPrivacy;
}

export interface CreateMessageInput {
  text: string;
  idempotencyKey?: string;
}

export interface CreateInviteInput {
  roomId: string;
  targetUserId?: string;
}

export interface RegisterPushTokenInput {
  token: string;
  platform: PlatformType;
}

export interface FriendRequestInput {
  targetUserId: string;
}

export interface MediaTokenResponse {
  roomId: string;
  userId: string;
  provider: "livekit" | "mock";
  token: string;
  expiresAt: string;
}

export interface PresenceSnapshot {
  userId: string;
  status: PresenceStatus;
  roomId: string | null;
  updatedAt: string;
}

export interface MetricSummaryItem {
  eventName: ReliabilityEventName;
  count: number;
  averageValue: number | null;
}

export interface MetricSummaryResponse {
  metrics: MetricSummaryItem[];
}

export interface RecordMetricInput {
  eventName: ReliabilityEventName;
  roomId?: string;
  value?: number;
}

export type RealtimeEventName =
  | "room_updated"
  | "member_joined"
  | "member_left"
  | "presence_updated"
  | "message_created"
  | "room_ended"
  | "reconnect_required";
