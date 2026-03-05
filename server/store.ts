import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AuthenticatedUser,
  MessageRecord,
  OrbitDetail,
  OrbitRecord,
  OrbitSummary,
  PresenceRecord,
  PresenceUpdateInput,
  UserRecord,
} from "../shared/models.js";

interface DevState {
  users: UserRecord[];
  orbits: OrbitRecord[];
  presence: PresenceRecord[];
  messages: MessageRecord[];
}

type PersistedCollection = keyof DevState;

const FILE_NAMES: Record<PersistedCollection, string> = {
  users: "users.json",
  orbits: "orbits.json",
  presence: "presence.json",
  messages: "messages.json",
};

const storeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(storeRoot, "data", "dev");

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

export class OrbitStoreError extends Error {
  constructor(
    public readonly code: "ORBIT_NOT_FOUND" | "ORBIT_NOT_LIVE" | "PARTICIPANT_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

const storeMutex = new Mutex();
let state: DevState | null = null;
let initPromise: Promise<void> | null = null;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeOrbitId(userId: string): string {
  return `orbit_${userId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;
}

function normalizeDisplayName(raw: string): string {
  return raw.trim().slice(0, 64);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const nextJson = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, nextJson, "utf8");
  await fs.rename(tempPath, filePath);
}

async function ensureDataFiles(): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });

  await Promise.all(
    Object.entries(FILE_NAMES).map(async ([collection, fileName]) => {
      const filePath = path.join(dataDir, fileName);
      try {
        await fs.access(filePath);
      } catch {
        const initialValue = Array.isArray(({} as DevState)[collection as PersistedCollection]) ? [] : [];
        await atomicWriteJson(filePath, initialValue);
      }
    }),
  );
}

async function readCollection<T>(collection: PersistedCollection): Promise<T> {
  const filePath = path.join(dataDir, FILE_NAMES[collection]);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as T;
  return parsed;
}

async function loadStateFromDisk(): Promise<DevState> {
  const [users, orbits, presence, messages] = await Promise.all([
    readCollection<UserRecord[]>("users"),
    readCollection<OrbitRecord[]>("orbits"),
    readCollection<PresenceRecord[]>("presence"),
    readCollection<MessageRecord[]>("messages"),
  ]);

  return {
    users,
    orbits,
    presence,
    messages,
  };
}

async function persistState(nextState: DevState): Promise<void> {
  await Promise.all(
    (Object.keys(FILE_NAMES) as PersistedCollection[]).map(async (collection) => {
      const filePath = path.join(dataDir, FILE_NAMES[collection]);
      await atomicWriteJson(filePath, nextState[collection]);
    }),
  );
}

function findOrbit(activeState: DevState, orbitId: string): OrbitRecord {
  const orbit = activeState.orbits.find((item) => item.orbitId === orbitId);
  if (!orbit) {
    throw new OrbitStoreError("ORBIT_NOT_FOUND", `Orbit ${orbitId} was not found.`);
  }

  return orbit;
}

function ensureLiveOrbit(activeState: DevState, orbitId: string): OrbitRecord {
  const orbit = findOrbit(activeState, orbitId);
  if (!orbit.isLive) {
    throw new OrbitStoreError("ORBIT_NOT_LIVE", `Orbit ${orbitId} is currently offline.`);
  }

  return orbit;
}

function ensureUserRecord(activeState: DevState, user: AuthenticatedUser): UserRecord {
  const now = new Date().toISOString();
  const userId = user.userId.trim();
  const displayName = normalizeDisplayName(user.displayName);

  let existing = activeState.users.find((item) => item.userId === userId);
  if (!existing) {
    existing = {
      userId,
      displayName,
      createdAt: now,
    };
    activeState.users.push(existing);
  } else if (existing.displayName !== displayName) {
    existing.displayName = displayName;
  }

  return existing;
}

function createPresence(orbitId: string, user: AuthenticatedUser, now: string): PresenceRecord {
  return {
    orbitId,
    userId: user.userId,
    displayName: normalizeDisplayName(user.displayName),
    micOn: false,
    camOn: false,
    textOnly: true,
    joinedAt: now,
    updatedAt: now,
  };
}

function buildOrbitDetail(activeState: DevState, orbitId: string, messageLimit = 50): OrbitDetail {
  const orbit = findOrbit(activeState, orbitId);

  const hostRecord =
    activeState.users.find((item) => item.userId === orbit.hostUserId) ??
    ({ userId: orbit.hostUserId, displayName: orbit.hostDisplayName } as AuthenticatedUser);

  const participants = activeState.presence
    .filter((item) => item.orbitId === orbit.orbitId)
    .sort((left, right) => left.joinedAt.localeCompare(right.joinedAt));

  const messages = activeState.messages
    .filter((item) => item.orbitId === orbit.orbitId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  return {
    orbit: clone(orbit),
    host: {
      userId: hostRecord.userId,
      displayName: hostRecord.displayName,
    },
    participants: clone(participants),
    messages: clone(messages.slice(-messageLimit)),
  };
}

async function withStore<T>(task: (activeState: DevState) => Promise<T> | T, shouldPersist = false): Promise<T> {
  await initializeStore();

  return storeMutex.runExclusive(async () => {
    if (!state) {
      throw new Error("Store is unavailable.");
    }

    const result = await task(state);

    if (shouldPersist) {
      await persistState(state);
    }

    return result;
  });
}

export async function initializeStore(): Promise<void> {
  if (state) {
    return;
  }

  if (!initPromise) {
    initPromise = (async () => {
      await ensureDataFiles();
      state = await loadStateFromDisk();
    })();
  }

  await initPromise;
}

export async function getDevUsers(): Promise<AuthenticatedUser[]> {
  return withStore((activeState) =>
    clone(
      activeState.users
        .map((user) => ({
          userId: user.userId,
          displayName: user.displayName,
        }))
        .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    ),
  );
}

export async function upsertUser(user: AuthenticatedUser): Promise<UserRecord> {
  return withStore((activeState) => clone(ensureUserRecord(activeState, user)), true);
}

export async function getLiveOrbitSummaries(): Promise<OrbitSummary[]> {
  return withStore((activeState) => {
    const summaries = activeState.orbits
      .filter((orbit) => orbit.isLive)
      .map((orbit) => {
        const host =
          activeState.users.find((item) => item.userId === orbit.hostUserId) ??
          ({ userId: orbit.hostUserId, displayName: orbit.hostDisplayName } as AuthenticatedUser);

        const participantCount = activeState.presence.filter((item) => item.orbitId === orbit.orbitId).length;
        const messageCount = activeState.messages.filter((item) => item.orbitId === orbit.orbitId).length;

        return {
          orbitId: orbit.orbitId,
          openedAt: orbit.openedAt,
          host: {
            userId: host.userId,
            displayName: host.displayName,
          },
          participantCount,
          messageCount,
        } satisfies OrbitSummary;
      })
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt));

    return clone(summaries);
  });
}

export async function openOrbitForHost(hostUser: AuthenticatedUser): Promise<OrbitDetail> {
  return withStore((activeState) => {
    const host = ensureUserRecord(activeState, hostUser);
    const now = new Date().toISOString();

    let orbit = activeState.orbits.find((item) => item.hostUserId === host.userId);
    if (!orbit) {
      orbit = {
        orbitId: makeOrbitId(host.userId),
        hostUserId: host.userId,
        hostDisplayName: host.displayName,
        isLive: true,
        openedAt: now,
        closedAt: null,
      };
      activeState.orbits.push(orbit);
    } else {
      orbit.hostDisplayName = host.displayName;
      orbit.isLive = true;
      orbit.openedAt = now;
      orbit.closedAt = null;
    }

    const hostPresenceIndex = activeState.presence.findIndex(
      (item) => item.orbitId === orbit.orbitId && item.userId === host.userId,
    );

    if (hostPresenceIndex === -1) {
      activeState.presence.push(createPresence(orbit.orbitId, host, now));
    } else {
      const existing = activeState.presence[hostPresenceIndex];
      existing.displayName = host.displayName;
      existing.updatedAt = now;
    }

    return buildOrbitDetail(activeState, orbit.orbitId);
  }, true);
}

export async function joinOrbit(
  orbitId: string,
  participantUser: AuthenticatedUser,
): Promise<{ joined: boolean; participant: PresenceRecord; detail: OrbitDetail }> {
  return withStore((activeState) => {
    const orbit = ensureLiveOrbit(activeState, orbitId);
    const participant = ensureUserRecord(activeState, participantUser);
    const now = new Date().toISOString();

    const existing = activeState.presence.find((item) => item.orbitId === orbit.orbitId && item.userId === participant.userId);

    let joined = false;
    let currentPresence: PresenceRecord;

    if (!existing) {
      currentPresence = createPresence(orbit.orbitId, participant, now);
      activeState.presence.push(currentPresence);
      joined = true;
    } else {
      existing.displayName = participant.displayName;
      existing.updatedAt = now;
      currentPresence = existing;
    }

    const detail = buildOrbitDetail(activeState, orbit.orbitId);

    return {
      joined,
      participant: clone(currentPresence),
      detail,
    };
  }, true);
}

export async function leaveOrbit(
  orbitId: string,
  participantUser: AuthenticatedUser,
): Promise<{ orbitClosed: boolean; left: boolean }> {
  return withStore((activeState) => {
    const orbit = findOrbit(activeState, orbitId);
    const participant = ensureUserRecord(activeState, participantUser);

    if (participant.userId === orbit.hostUserId) {
      orbit.isLive = false;
      orbit.closedAt = new Date().toISOString();
      activeState.presence = activeState.presence.filter((item) => item.orbitId !== orbit.orbitId);
      return {
        orbitClosed: true,
        left: true,
      };
    }

    const beforeCount = activeState.presence.length;
    activeState.presence = activeState.presence.filter(
      (item) => !(item.orbitId === orbit.orbitId && item.userId === participant.userId),
    );

    if (beforeCount === activeState.presence.length) {
      throw new OrbitStoreError("PARTICIPANT_NOT_FOUND", `Participant ${participant.userId} is not in ${orbitId}.`);
    }

    return {
      orbitClosed: false,
      left: true,
    };
  }, true);
}

export async function updateOrbitPresence(
  orbitId: string,
  user: AuthenticatedUser,
  update: PresenceUpdateInput,
): Promise<PresenceRecord> {
  return withStore((activeState) => {
    const orbit = ensureLiveOrbit(activeState, orbitId);
    const participant = ensureUserRecord(activeState, user);

    const presence = activeState.presence.find(
      (item) => item.orbitId === orbit.orbitId && item.userId === participant.userId,
    );

    if (!presence) {
      throw new OrbitStoreError("PARTICIPANT_NOT_FOUND", `Participant ${participant.userId} is not in ${orbitId}.`);
    }

    if (typeof update.textOnly === "boolean") {
      presence.textOnly = update.textOnly;
      if (update.textOnly) {
        presence.micOn = false;
        presence.camOn = false;
      }
    }

    if (typeof update.micOn === "boolean") {
      presence.micOn = update.micOn;
      if (update.micOn) {
        presence.textOnly = false;
      }
    }

    if (typeof update.camOn === "boolean") {
      presence.camOn = update.camOn;
      if (update.camOn) {
        presence.textOnly = false;
      }
    }

    if (!presence.micOn && !presence.camOn && update.textOnly === undefined) {
      presence.textOnly = true;
    }

    presence.updatedAt = new Date().toISOString();

    return clone(presence);
  }, true);
}

export async function getOrbitDetail(orbitId: string, messageLimit = 50): Promise<OrbitDetail> {
  return withStore((activeState) => clone(buildOrbitDetail(activeState, orbitId, messageLimit)));
}

export async function addOrbitMessage(
  orbitId: string,
  user: AuthenticatedUser,
  text: string,
): Promise<MessageRecord> {
  return withStore((activeState) => {
    const orbit = ensureLiveOrbit(activeState, orbitId);
    const participant = ensureUserRecord(activeState, user);

    const activePresence = activeState.presence.find(
      (item) => item.orbitId === orbit.orbitId && item.userId === participant.userId,
    );

    if (!activePresence) {
      throw new OrbitStoreError("PARTICIPANT_NOT_FOUND", `Participant ${participant.userId} is not in ${orbitId}.`);
    }

    const message: MessageRecord = {
      messageId: randomUUID(),
      orbitId: orbit.orbitId,
      userId: participant.userId,
      displayName: participant.displayName,
      text,
      createdAt: new Date().toISOString(),
    };

    activeState.messages.push(message);
    return clone(message);
  }, true);
}

export async function seedDemoData(): Promise<void> {
  await withStore((activeState) => {
    const now = Date.now();
    const iso = (offsetMinutes: number) => new Date(now - offsetMinutes * 60_000).toISOString();

    const users: UserRecord[] = [
      { userId: "ada", displayName: "Ada", createdAt: iso(180) },
      { userId: "sam", displayName: "Sam", createdAt: iso(178) },
      { userId: "rio", displayName: "Rio", createdAt: iso(176) },
      { userId: "noa", displayName: "Noa", createdAt: iso(174) },
      { userId: "ivy", displayName: "Ivy", createdAt: iso(172) },
    ];

    const orbits: OrbitRecord[] = [
      {
        orbitId: "orbit_ada",
        hostUserId: "ada",
        hostDisplayName: "Ada",
        isLive: true,
        openedAt: iso(14),
        closedAt: null,
      },
      {
        orbitId: "orbit_sam",
        hostUserId: "sam",
        hostDisplayName: "Sam",
        isLive: true,
        openedAt: iso(10),
        closedAt: null,
      },
      {
        orbitId: "orbit_rio",
        hostUserId: "rio",
        hostDisplayName: "Rio",
        isLive: true,
        openedAt: iso(7),
        closedAt: null,
      },
    ];

    const presence: PresenceRecord[] = [
      {
        orbitId: "orbit_ada",
        userId: "ada",
        displayName: "Ada",
        micOn: true,
        camOn: false,
        textOnly: false,
        joinedAt: iso(14),
        updatedAt: iso(2),
      },
      {
        orbitId: "orbit_ada",
        userId: "ivy",
        displayName: "Ivy",
        micOn: false,
        camOn: false,
        textOnly: true,
        joinedAt: iso(8),
        updatedAt: iso(3),
      },
      {
        orbitId: "orbit_sam",
        userId: "sam",
        displayName: "Sam",
        micOn: false,
        camOn: true,
        textOnly: false,
        joinedAt: iso(10),
        updatedAt: iso(1),
      },
      {
        orbitId: "orbit_sam",
        userId: "noa",
        displayName: "Noa",
        micOn: true,
        camOn: false,
        textOnly: false,
        joinedAt: iso(5),
        updatedAt: iso(1),
      },
      {
        orbitId: "orbit_rio",
        userId: "rio",
        displayName: "Rio",
        micOn: false,
        camOn: false,
        textOnly: true,
        joinedAt: iso(7),
        updatedAt: iso(1),
      },
    ];

    const messages: MessageRecord[] = [
      {
        messageId: randomUUID(),
        orbitId: "orbit_ada",
        userId: "ada",
        displayName: "Ada",
        text: "Orbit is open. Pull up and say hello.",
        createdAt: iso(13),
      },
      {
        messageId: randomUUID(),
        orbitId: "orbit_ada",
        userId: "ivy",
        displayName: "Ivy",
        text: "Listening in from text mode.",
        createdAt: iso(7),
      },
      {
        messageId: randomUUID(),
        orbitId: "orbit_sam",
        userId: "sam",
        displayName: "Sam",
        text: "Working session starts now.",
        createdAt: iso(9),
      },
      {
        messageId: randomUUID(),
        orbitId: "orbit_rio",
        userId: "rio",
        displayName: "Rio",
        text: "Chill room for quick intros.",
        createdAt: iso(6),
      },
    ];

    activeState.users = users;
    activeState.orbits = orbits;
    activeState.presence = presence;
    activeState.messages = messages;
  }, true);
}

export async function resetDemoData(): Promise<void> {
  await withStore((activeState) => {
    activeState.users = [];
    activeState.orbits = [];
    activeState.presence = [];
    activeState.messages = [];
  }, true);
}
