import type {
  CreateInviteInput,
  CreateMessageInput,
  CreateRoomInput,
  CreateRoomInput as CreateRoomBody,
  FriendRequestInput,
  RoomDetail,
  RoomSummary,
  SendOtpCodeInput,
  SendOtpCodeResponse,
  VerifyOtpCodeInput,
  V1AuthUser,
  V1SessionResponse,
} from "@shared/v1";

export class CompanionApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, accessToken?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  const response = await fetch(path, {
    ...init,
    headers,
  });

  const raw = await response.text();
  const parsed = raw ? (JSON.parse(raw) as unknown) : undefined;

  if (!response.ok) {
    const message = (parsed as { error?: string } | undefined)?.error ?? `Request failed (${response.status})`;
    throw new CompanionApiError(message, response.status);
  }

  return parsed as T;
}

export function sendOtpCode(input: SendOtpCodeInput): Promise<SendOtpCodeResponse> {
  return request<SendOtpCodeResponse>("/api/v1/auth/phone/send-code", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function verifyOtpCode(input: VerifyOtpCodeInput): Promise<V1SessionResponse> {
  return request<V1SessionResponse>("/api/v1/auth/phone/verify", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function refreshSession(refreshToken: string): Promise<V1SessionResponse> {
  return request<V1SessionResponse>("/api/v1/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
}

export function listUsers(accessToken: string): Promise<V1AuthUser[]> {
  return request<V1AuthUser[]>("/api/v1/users", { method: "GET" }, accessToken);
}

export function listFriends(accessToken: string): Promise<{ friends: V1AuthUser[]; requests: unknown[] }> {
  return request<{ friends: V1AuthUser[]; requests: unknown[] }>("/api/v1/friends", { method: "GET" }, accessToken);
}

export function createFriendRequest(input: FriendRequestInput, accessToken: string): Promise<unknown> {
  return request<unknown>("/api/v1/friends/request", {
    method: "POST",
    body: JSON.stringify(input),
  }, accessToken);
}

export function listRooms(accessToken: string): Promise<RoomSummary[]> {
  return request<RoomSummary[]>("/api/v1/rooms", { method: "GET" }, accessToken);
}

export function createRoom(input: CreateRoomBody, accessToken: string): Promise<RoomSummary> {
  return request<RoomSummary>("/api/v1/rooms", {
    method: "POST",
    body: JSON.stringify(input),
  }, accessToken);
}

export function joinRoom(roomId: string, accessToken: string): Promise<unknown> {
  return request<unknown>(`/api/v1/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({}),
  }, accessToken);
}

export function leaveRoom(roomId: string, accessToken: string): Promise<unknown> {
  return request<unknown>(`/api/v1/rooms/${roomId}/leave`, {
    method: "POST",
    body: JSON.stringify({}),
  }, accessToken);
}

export function getRoomDetail(roomId: string, accessToken: string): Promise<RoomDetail> {
  return request<RoomDetail>(`/api/v1/rooms/${roomId}`, { method: "GET" }, accessToken);
}

export function createRoomMessage(roomId: string, input: CreateMessageInput, accessToken: string): Promise<unknown> {
  return request<unknown>(`/api/v1/rooms/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
  }, accessToken);
}

export function createInvite(input: CreateInviteInput, accessToken: string): Promise<{ code: string }> {
  return request<{ code: string }>("/api/v1/invites", {
    method: "POST",
    body: JSON.stringify(input),
  }, accessToken);
}
