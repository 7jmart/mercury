import cors from "cors";
import express, { type Request, type Response } from "express";

import type {
  AuthenticatedUser,
  DevLoginResponse,
  OrbitEvent,
  OrbitEventType,
  PresenceUpdateInput,
} from "../shared/models.js";
import { createDevToken, readAuthUserFromHeader } from "./auth.js";
import { orbitRealtimeHub } from "./realtime.js";
import {
  OrbitStoreError,
  addOrbitMessage,
  getDevUsers,
  getLiveOrbitSummaries,
  getOrbitDetail,
  initializeStore,
  joinOrbit,
  leaveOrbit,
  openOrbitForHost,
  updateOrbitPresence,
  upsertUser,
} from "./store.js";

const app = express();

const API_PORT = Number(process.env.API_PORT ?? 4000);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

function sendStoreError(error: unknown, res: Response): void {
  if (error instanceof OrbitStoreError) {
    if (error.code === "ORBIT_NOT_FOUND") {
      res.status(404).json({ error: error.message });
      return;
    }

    if (error.code === "ORBIT_NOT_LIVE") {
      res.status(409).json({ error: error.message });
      return;
    }

    if (error.code === "PARTICIPANT_NOT_FOUND") {
      res.status(404).json({ error: error.message });
      return;
    }
  }

  console.error(error);
  res.status(500).json({ error: "Internal server error." });
}

function authUserFromRequest(req: Request, res: Response): AuthenticatedUser | null {
  const user = readAuthUserFromHeader(req.header("authorization") ?? undefined);
  if (!user) {
    res.status(401).json({ error: "Missing or invalid Bearer token." });
    return null;
  }

  return user;
}

function emitOrbitEvent<TPayload extends Record<string, unknown>>(
  type: OrbitEventType,
  orbitId: string,
  payload: TPayload,
): void {
  const event: OrbitEvent<TPayload> = {
    type,
    orbitId,
    payload,
    emittedAt: new Date().toISOString(),
  };
  orbitRealtimeHub.publish(event);
}

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "mercury-orbit-api",
    now: new Date().toISOString(),
  });
});

app.get("/api/dev/users", async (_req, res) => {
  try {
    const users = await getDevUsers();
    res.json(users);
  } catch (error) {
    sendStoreError(error, res);
  }
});

app.post("/api/auth/dev-login", async (req, res) => {
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";

  if (!userId || !displayName) {
    res.status(400).json({ error: "userId and displayName are required." });
    return;
  }

  try {
    const user = await upsertUser({ userId, displayName });
    const authUser: AuthenticatedUser = {
      userId: user.userId,
      displayName: user.displayName,
    };

    const response: DevLoginResponse = {
      token: createDevToken(authUser),
      user: authUser,
    };

    res.json(response);
  } catch (error) {
    sendStoreError(error, res);
  }
});

app.get("/api/orbits/live", async (_req, res) => {
  try {
    const liveOrbits = await getLiveOrbitSummaries();
    res.json(liveOrbits);
  } catch (error) {
    sendStoreError(error, res);
  }
});

app.post("/api/orbits/open", async (req, res) => {
  const hostUser = authUserFromRequest(req, res);
  if (!hostUser) {
    return;
  }

  try {
    const detail = await openOrbitForHost(hostUser);

    emitOrbitEvent("orbit_opened", detail.orbit.orbitId, {
      hostUserId: detail.host.userId,
      hostDisplayName: detail.host.displayName,
      participantCount: detail.participants.length,
    });

    res.json(detail);
  } catch (error) {
    sendStoreError(error, res);
  }
});

app.post("/api/orbits/:orbitId/join", async (req, res) => {
  const user = authUserFromRequest(req, res);
  if (!user) {
    return;
  }

  try {
    const { orbitId } = req.params;
    const result = await joinOrbit(orbitId, user);

    if (result.joined) {
      emitOrbitEvent("participant_joined", orbitId, {
        userId: result.participant.userId,
        displayName: result.participant.displayName,
      });
    }

    res.json(result.detail);
  } catch (error) {
    sendStoreError(error, res);
  }
});

app.post("/api/orbits/:orbitId/leave", async (req, res) => {
  const user = authUserFromRequest(req, res);
  if (!user) {
    return;
  }

  try {
    const { orbitId } = req.params;
    const result = await leaveOrbit(orbitId, user);

    if (result.orbitClosed) {
      emitOrbitEvent("orbit_closed", orbitId, {
        hostUserId: user.userId,
        hostDisplayName: user.displayName,
      });
    } else {
      emitOrbitEvent("participant_left", orbitId, {
        userId: user.userId,
        displayName: user.displayName,
      });
    }

    res.json({ ok: true, orbitClosed: result.orbitClosed });
  } catch (error) {
    sendStoreError(error, res);
  }
});

app.post("/api/orbits/:orbitId/presence", async (req, res) => {
  const user = authUserFromRequest(req, res);
  if (!user) {
    return;
  }

  const incoming = req.body as PresenceUpdateInput;
  const update: PresenceUpdateInput = {};

  if (incoming && Object.prototype.hasOwnProperty.call(incoming, "micOn")) {
    if (typeof incoming.micOn !== "boolean") {
      res.status(400).json({ error: "micOn must be a boolean." });
      return;
    }
    update.micOn = incoming.micOn;
  }

  if (incoming && Object.prototype.hasOwnProperty.call(incoming, "camOn")) {
    if (typeof incoming.camOn !== "boolean") {
      res.status(400).json({ error: "camOn must be a boolean." });
      return;
    }
    update.camOn = incoming.camOn;
  }

  if (incoming && Object.prototype.hasOwnProperty.call(incoming, "textOnly")) {
    if (typeof incoming.textOnly !== "boolean") {
      res.status(400).json({ error: "textOnly must be a boolean." });
      return;
    }
    update.textOnly = incoming.textOnly;
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "At least one of micOn, camOn, or textOnly is required." });
    return;
  }

  try {
    const { orbitId } = req.params;
    const updatedPresence = await updateOrbitPresence(orbitId, user, update);

    emitOrbitEvent("presence_updated", orbitId, {
      userId: updatedPresence.userId,
      displayName: updatedPresence.displayName,
      micOn: updatedPresence.micOn,
      camOn: updatedPresence.camOn,
      textOnly: updatedPresence.textOnly,
    });

    res.json(updatedPresence);
  } catch (error) {
    sendStoreError(error, res);
  }
});

app.get("/api/orbits/:orbitId", async (req, res) => {
  try {
    const detail = await getOrbitDetail(req.params.orbitId);
    res.json(detail);
  } catch (error) {
    sendStoreError(error, res);
  }
});

app.post("/api/orbits/:orbitId/messages", async (req, res) => {
  const user = authUserFromRequest(req, res);
  if (!user) {
    return;
  }

  const rawText = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!rawText) {
    res.status(400).json({ error: "text is required." });
    return;
  }

  if (rawText.length > 1000) {
    res.status(400).json({ error: "text is limited to 1000 characters." });
    return;
  }

  try {
    const message = await addOrbitMessage(req.params.orbitId, user, rawText);

    emitOrbitEvent("message_created", req.params.orbitId, {
      messageId: message.messageId,
      userId: message.userId,
      displayName: message.displayName,
      text: message.text,
      createdAt: message.createdAt,
    });

    res.status(201).json(message);
  } catch (error) {
    sendStoreError(error, res);
  }
});

app.get("/api/orbits/:orbitId/events", async (req, res) => {
  try {
    await getOrbitDetail(req.params.orbitId, 1);
    orbitRealtimeHub.subscribe(req.params.orbitId, res);
  } catch (error) {
    sendStoreError(error, res);
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

await initializeStore();

app.listen(API_PORT, () => {
  console.log("[Mercury Orbit] API online");
  console.log(`  UI URL:        http://localhost:${WEB_PORT}`);
  console.log(`  API URL:       http://localhost:${API_PORT}`);
  console.log(`  Realtime URL:  http://localhost:${API_PORT}/api/orbits/:orbitId/events`);
});
