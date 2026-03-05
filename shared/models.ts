export type OrbitEventType =
  | "orbit_opened"
  | "orbit_closed"
  | "participant_joined"
  | "participant_left"
  | "presence_updated"
  | "message_created";

export interface AuthenticatedUser {
  userId: string;
  displayName: string;
}

export interface UserRecord extends AuthenticatedUser {
  createdAt: string;
}

export interface OrbitRecord {
  orbitId: string;
  hostUserId: string;
  hostDisplayName: string;
  isLive: boolean;
  openedAt: string;
  closedAt: string | null;
}

export interface PresenceRecord extends AuthenticatedUser {
  orbitId: string;
  micOn: boolean;
  camOn: boolean;
  textOnly: boolean;
  joinedAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  messageId: string;
  orbitId: string;
  userId: string;
  displayName: string;
  text: string;
  createdAt: string;
}

export interface OrbitSummary {
  orbitId: string;
  openedAt: string;
  host: AuthenticatedUser;
  participantCount: number;
  messageCount: number;
}

export interface OrbitDetail {
  orbit: OrbitRecord;
  host: AuthenticatedUser;
  participants: PresenceRecord[];
  messages: MessageRecord[];
}

export interface DevLoginResponse {
  token: string;
  user: AuthenticatedUser;
}

export interface PresenceUpdateInput {
  micOn?: boolean;
  camOn?: boolean;
  textOnly?: boolean;
}

export interface OrbitEvent<TPayload = Record<string, unknown>> {
  type: OrbitEventType;
  orbitId: string;
  emittedAt: string;
  payload: TPayload;
}
