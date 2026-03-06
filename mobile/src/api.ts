const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: {
    userId: string;
    phoneNumber: string;
    displayName: string;
  };
}

export interface RoomSummary {
  roomId: string;
  title: string;
  privacy: "private" | "public";
  participantCount: number;
}

export interface RoomDetail {
  room: {
    roomId: string;
    title: string;
  };
  messages: Array<{
    messageId: string;
    userId: string;
    text: string;
    createdAt: string;
  }>;
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  const raw = await response.text();
  const parsed = raw ? (JSON.parse(raw) as unknown) : undefined;

  if (!response.ok) {
    const message = (parsed as { error?: string } | undefined)?.error ?? `Request failed (${response.status})`;
    throw new Error(message);
  }

  return parsed as T;
}

export function sendCode(phoneNumber: string): Promise<{ sent: true; debugCode?: string }> {
  return request("/api/v1/auth/phone/send-code", {
    method: "POST",
    body: JSON.stringify({ phoneNumber }),
  });
}

export function verifyCode(phoneNumber: string, code: string, displayName: string): Promise<Session> {
  return request("/api/v1/auth/phone/verify", {
    method: "POST",
    body: JSON.stringify({ phoneNumber, code, displayName }),
  });
}

export function listRooms(token: string): Promise<RoomSummary[]> {
  return request("/api/v1/rooms", { method: "GET" }, token);
}

export function createRoom(token: string, title: string): Promise<RoomSummary> {
  return request("/api/v1/rooms", {
    method: "POST",
    body: JSON.stringify({ title, privacy: "private" }),
  }, token);
}

export function joinRoom(token: string, roomId: string): Promise<void> {
  return request(`/api/v1/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({}),
  }, token);
}

export function leaveRoom(token: string, roomId: string): Promise<void> {
  return request(`/api/v1/rooms/${roomId}/leave`, {
    method: "POST",
    body: JSON.stringify({}),
  }, token);
}

export function getRoom(token: string, roomId: string): Promise<RoomDetail> {
  return request(`/api/v1/rooms/${roomId}`, { method: "GET" }, token);
}

export function sendMessage(token: string, roomId: string, text: string): Promise<void> {
  return request(`/api/v1/rooms/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, idempotencyKey: `${Date.now()}-${Math.random()}` }),
  }, token);
}
