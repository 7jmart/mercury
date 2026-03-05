import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AuthenticatedUser,
  DevLoginResponse,
  GrowthEventInput,
  GrowthEventName,
  MessageRecord,
  OrbitDetail,
  OrbitEventType,
  OrbitSummary,
  PresenceRecord,
  PresenceUpdateInput,
} from "@shared/models";

import { ApiError, apiGet, apiPost } from "./api";

const SESSION_STORAGE_KEY = "mercury:session";

const FALLBACK_DEMO_USERS: AuthenticatedUser[] = [
  { userId: "ada", displayName: "Ada" },
  { userId: "sam", displayName: "Sam" },
  { userId: "rio", displayName: "Rio" },
  { userId: "noa", displayName: "Noa" },
  { userId: "ivy", displayName: "Ivy" },
];

const ORBIT_EVENT_TYPES: OrbitEventType[] = [
  "orbit_opened",
  "orbit_closed",
  "participant_joined",
  "participant_left",
  "presence_updated",
  "message_created",
];

const INVITE_QUERY_PARAM = "orbit";

interface Session {
  token: string;
  user: AuthenticatedUser;
}

function readSession(): Session | null {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Session;
    if (typeof parsed.token !== "string" || !parsed.user?.userId || !parsed.user?.displayName) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function writeSession(session: Session | null): void {
  if (!session) {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function findMyPresence(orbitDetail: OrbitDetail | null, currentUserId: string): PresenceRecord | null {
  if (!orbitDetail) {
    return null;
  }

  return orbitDetail.participants.find((participant) => participant.userId === currentUserId) ?? null;
}

function readInviteOrbitIdFromUrl(): string | null {
  const candidate = new URLSearchParams(window.location.search).get(INVITE_QUERY_PARAM)?.trim() ?? "";
  if (!candidate || !/^[a-z0-9_-]{3,64}$/i.test(candidate)) {
    return null;
  }

  return candidate;
}

function clearInviteOrbitFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(INVITE_QUERY_PARAM)) {
    return;
  }

  url.searchParams.delete(INVITE_QUERY_PARAM);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export default function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(() => readSession());
  const [demoUsers, setDemoUsers] = useState<AuthenticatedUser[]>(FALLBACK_DEMO_USERS);
  const [liveOrbits, setLiveOrbits] = useState<OrbitSummary[]>([]);
  const [currentOrbitId, setCurrentOrbitId] = useState<string | null>(null);
  const [orbitDetail, setOrbitDetail] = useState<OrbitDetail | null>(null);
  const [composerText, setComposerText] = useState("");
  const [statusText, setStatusText] = useState("Ready.");
  const [busy, setBusy] = useState(false);
  const [customUserId, setCustomUserId] = useState("guest");
  const [customDisplayName, setCustomDisplayName] = useState("Guest");
  const [pendingInviteOrbitId, setPendingInviteOrbitId] = useState<string | null>(() => readInviteOrbitIdFromUrl());

  const statusTimer = useRef<number | null>(null);

  const pushStatus = useCallback((nextStatus: string) => {
    if (statusTimer.current) {
      window.clearTimeout(statusTimer.current);
    }

    setStatusText(nextStatus);
    statusTimer.current = window.setTimeout(() => {
      setStatusText("Ready.");
    }, 3500);
  }, []);

  const loadDemoUsers = useCallback(async () => {
    try {
      const users = await apiGet<AuthenticatedUser[]>("/api/dev/users");
      if (users.length > 0) {
        setDemoUsers(users);
      }
    } catch {
      setDemoUsers(FALLBACK_DEMO_USERS);
    }
  }, []);

  const loadLiveOrbits = useCallback(async () => {
    try {
      const response = await apiGet<OrbitSummary[]>("/api/orbits/live");
      setLiveOrbits(response);
    } catch (error) {
      if (error instanceof ApiError) {
        pushStatus(error.message);
      }
    }
  }, [pushStatus]);

  const refreshOrbitDetail = useCallback(
    async (orbitId: string) => {
      const detail = await apiGet<OrbitDetail>(`/api/orbits/${orbitId}`);
      setOrbitDetail(detail);
      return detail;
    },
    [setOrbitDetail],
  );

  const trackGrowthEvent = useCallback(
    async (eventName: GrowthEventName, orbitId: string) => {
      if (!session) {
        return;
      }

      const payload: GrowthEventInput = { eventName, orbitId };

      try {
        await apiPost<{ ok: boolean }>("/api/growth/events", payload, session.token);
      } catch {
        // Growth telemetry should never block core user actions.
      }
    },
    [session],
  );

  const loginAs = useCallback(
    async (candidate: AuthenticatedUser) => {
      setBusy(true);
      try {
        const response = await apiPost<DevLoginResponse>("/api/auth/dev-login", {
          userId: candidate.userId,
          displayName: candidate.displayName,
        });

        const nextSession: Session = {
          token: response.token,
          user: response.user,
        };

        setSession(nextSession);
        writeSession(nextSession);
        pushStatus(`Logged in as ${response.user.displayName}.`);
      } catch (error) {
        if (error instanceof ApiError) {
          pushStatus(error.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [pushStatus],
  );

  const logout = useCallback(() => {
    setSession(null);
    writeSession(null);
    setCurrentOrbitId(null);
    setOrbitDetail(null);
    pushStatus("Signed out.");
  }, [pushStatus]);

  const openOrbit = useCallback(async () => {
    if (!session) {
      return;
    }

    setBusy(true);
    try {
      const detail = await apiPost<OrbitDetail>("/api/orbits/open", {}, session.token);
      setCurrentOrbitId(detail.orbit.orbitId);
      setOrbitDetail(detail);
      await loadLiveOrbits();
      pushStatus("Orbit opened and you are now live.");
    } catch (error) {
      if (error instanceof ApiError) {
        pushStatus(error.message);
      }
    } finally {
      setBusy(false);
    }
  }, [loadLiveOrbits, pushStatus, session]);

  const joinOrbitById = useCallback(
    async (orbitId: string, options?: { source: "invite" }) => {
      if (!session) {
        return;
      }

      setBusy(true);
      try {
        const detail = await apiPost<OrbitDetail>(`/api/orbits/${orbitId}/join`, {}, session.token);
        setCurrentOrbitId(orbitId);
        setOrbitDetail(detail);

        if (options?.source === "invite") {
          setPendingInviteOrbitId(null);
          clearInviteOrbitFromUrl();
          void trackGrowthEvent("invite_accepted", orbitId);
          pushStatus(`Invite accepted. You joined ${detail.host.displayName}'s Orbit.`);
        } else {
          pushStatus(`Joined ${detail.host.displayName}'s Orbit.`);
        }
      } catch (error) {
        if (error instanceof ApiError) {
          pushStatus(error.message);
        }

        if (options?.source === "invite") {
          setPendingInviteOrbitId(null);
          clearInviteOrbitFromUrl();
        }
      } finally {
        setBusy(false);
      }
    },
    [pushStatus, session, trackGrowthEvent],
  );

  const shareCurrentOrbit = useCallback(async () => {
    if (!session || !currentOrbitId) {
      return;
    }

    const inviteUrl = new URL(window.location.href);
    inviteUrl.searchParams.set(INVITE_QUERY_PARAM, currentOrbitId);
    const inviteLink = inviteUrl.toString();

    try {
      await navigator.clipboard.writeText(inviteLink);
      void trackGrowthEvent("share_clicked", currentOrbitId);
      pushStatus("Invite link copied. Share it to bring people into this Orbit.");
    } catch {
      pushStatus(`Copy failed. Share this invite manually: ${inviteLink}`);
    }
  }, [currentOrbitId, pushStatus, session, trackGrowthEvent]);

  const leaveCurrentOrbit = useCallback(async () => {
    if (!session || !currentOrbitId) {
      return;
    }

    setBusy(true);
    try {
      const response = await apiPost<{ ok: boolean; orbitClosed: boolean }>(
        `/api/orbits/${currentOrbitId}/leave`,
        {},
        session.token,
      );

      setCurrentOrbitId(null);
      setOrbitDetail(null);
      await loadLiveOrbits();
      if (response.orbitClosed) {
        pushStatus("Your Orbit is now offline.");
      } else {
        pushStatus("You left the Orbit.");
      }
    } catch (error) {
      if (error instanceof ApiError) {
        pushStatus(error.message);
      }
    } finally {
      setBusy(false);
    }
  }, [currentOrbitId, loadLiveOrbits, pushStatus, session]);

  const updatePresence = useCallback(
    async (update: PresenceUpdateInput) => {
      if (!session || !currentOrbitId) {
        return;
      }

      setBusy(true);
      try {
        await apiPost<PresenceRecord>(`/api/orbits/${currentOrbitId}/presence`, update, session.token);
        await refreshOrbitDetail(currentOrbitId);
      } catch (error) {
        if (error instanceof ApiError) {
          pushStatus(error.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [currentOrbitId, pushStatus, refreshOrbitDetail, session],
  );

  const sendMessage = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!session || !currentOrbitId) {
        return;
      }

      const text = composerText.trim();
      if (!text) {
        return;
      }

      setBusy(true);
      try {
        await apiPost<MessageRecord>(`/api/orbits/${currentOrbitId}/messages`, { text }, session.token);
        setComposerText("");
        await refreshOrbitDetail(currentOrbitId);
      } catch (error) {
        if (error instanceof ApiError) {
          pushStatus(error.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [composerText, currentOrbitId, pushStatus, refreshOrbitDetail, session],
  );

  useEffect(() => {
    void loadDemoUsers();
    void loadLiveOrbits();

    const pollTimer = window.setInterval(() => {
      void loadLiveOrbits();
    }, 4000);

    return () => {
      window.clearInterval(pollTimer);
      if (statusTimer.current) {
        window.clearTimeout(statusTimer.current);
      }
    };
  }, [loadDemoUsers, loadLiveOrbits]);

  useEffect(() => {
    if (!session || !pendingInviteOrbitId || busy) {
      return;
    }

    if (currentOrbitId === pendingInviteOrbitId) {
      setPendingInviteOrbitId(null);
      clearInviteOrbitFromUrl();
      return;
    }

    void joinOrbitById(pendingInviteOrbitId, { source: "invite" });
  }, [busy, currentOrbitId, joinOrbitById, pendingInviteOrbitId, session]);

  useEffect(() => {
    if (!currentOrbitId) {
      return;
    }

    let cancelled = false;

    const refreshFromEvent = async () => {
      if (cancelled) {
        return;
      }

      try {
        await refreshOrbitDetail(currentOrbitId);
        await loadLiveOrbits();
      } catch {
        // Event stream should be resilient to transient fetch errors.
      }
    };

    void refreshFromEvent();

    const eventSource = new EventSource(`/api/orbits/${currentOrbitId}/events`);

    for (const eventType of ORBIT_EVENT_TYPES) {
      eventSource.addEventListener(eventType, () => {
        void refreshFromEvent();
      });
    }

    eventSource.onerror = () => {
      // Browser reconnects EventSource automatically.
    };

    return () => {
      cancelled = true;
      eventSource.close();
    };
  }, [currentOrbitId, loadLiveOrbits, refreshOrbitDetail]);

  const myPresence = useMemo(() => {
    if (!session) {
      return null;
    }

    return findMyPresence(orbitDetail, session.user.userId);
  }, [orbitDetail, session]);

  const handleCustomLogin = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const userId = customUserId.trim().toLowerCase();
      const displayName = customDisplayName.trim();

      if (!userId || !displayName) {
        pushStatus("Custom user requires both userId and display name.");
        return;
      }

      await loginAs({ userId, displayName });
    },
    [customDisplayName, customUserId, loginAs, pushStatus],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Mercury</p>
          <h1>Orbit</h1>
          <p className="subtitle">Live presence rooms you can enter in one tap.</p>
        </div>
        <div className="header-actions">
          <p className="status">{statusText}</p>
          {session ? (
            <>
              <button className="button button-secondary" onClick={openOrbit} disabled={busy}>
                Open Orbit
              </button>
              <button className="button button-ghost" onClick={logout} disabled={busy}>
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>

      {!session ? (
        <section className="panel login-panel">
          <h2>Dev Login Selector</h2>
          <p>Open multiple tabs and choose different users to test join/chat/presence quickly.</p>
          {pendingInviteOrbitId ? (
            <p className="invite-hint">This invite will auto-join Orbit <strong>{pendingInviteOrbitId}</strong> after login.</p>
          ) : null}

          <div className="login-grid">
            {demoUsers.map((user) => (
              <button
                key={user.userId}
                className="button button-pill"
                onClick={() => void loginAs(user)}
                disabled={busy}
              >
                {user.displayName}
              </button>
            ))}
          </div>

          <form className="custom-login" onSubmit={(event) => void handleCustomLogin(event)}>
            <label>
              userId
              <input value={customUserId} onChange={(event) => setCustomUserId(event.target.value)} />
            </label>
            <label>
              displayName
              <input value={customDisplayName} onChange={(event) => setCustomDisplayName(event.target.value)} />
            </label>
            <button className="button" type="submit" disabled={busy}>
              Login as Custom User
            </button>
          </form>
        </section>
      ) : (
        <main className="workspace">
          <section className="panel live-panel">
            <div className="panel-header">
              <h2>Live Orbits</h2>
              <p>{session.user.displayName} is online in this tab.</p>
            </div>

            <div className="orbit-list">
              {liveOrbits.length === 0 ? (
                <article className="orbit-card empty">No one is live yet. Open your Orbit to start.</article>
              ) : (
                liveOrbits.map((orbit) => {
                  const isMyOrbit = orbit.host.userId === session.user.userId;

                  return (
                    <article className="orbit-card" key={orbit.orbitId}>
                      <div className="orbit-card-top">
                        <h3>{orbit.host.displayName}</h3>
                        <span className="live-dot">Live</span>
                      </div>
                      <p>
                        {orbit.participantCount} participants - {orbit.messageCount} messages
                      </p>
                      <p className="muted">Opened at {formatClock(orbit.openedAt)}</p>
                      <button className="button button-secondary" onClick={() => void joinOrbitById(orbit.orbitId)} disabled={busy}>
                        {isMyOrbit ? "Enter My Orbit" : "Join Orbit"}
                      </button>
                    </article>
                  );
                })
              )}
            </div>
          </section>

          <section className="panel orbit-panel">
            {!currentOrbitId || !orbitDetail ? (
              <div className="orbit-empty-state">
                <h2>Select an Orbit</h2>
                <p>Join a live room from the feed, or open your own Orbit.</p>
              </div>
            ) : (
              <>
                <div className="panel-header orbit-header">
                  <div>
                    <h2>{orbitDetail.host.displayName}'s Orbit</h2>
                    <p>{orbitDetail.orbit.isLive ? "Live now" : "Offline"}</p>
                  </div>
                  <div className="orbit-header-actions">
                    <button className="button button-secondary" onClick={shareCurrentOrbit} disabled={busy}>
                      Copy Invite Link
                    </button>
                    <button className="button button-ghost" onClick={leaveCurrentOrbit} disabled={busy}>
                      Leave Orbit
                    </button>
                  </div>
                </div>

                {myPresence ? (
                  <div className="presence-controls">
                    <button
                      className={`toggle ${myPresence.micOn ? "active" : ""}`}
                      onClick={() => void updatePresence({ micOn: !myPresence.micOn })}
                      disabled={busy}
                    >
                      Mic {myPresence.micOn ? "On" : "Off"}
                    </button>
                    <button
                      className={`toggle ${myPresence.camOn ? "active" : ""}`}
                      onClick={() => void updatePresence({ camOn: !myPresence.camOn })}
                      disabled={busy}
                    >
                      Cam {myPresence.camOn ? "On" : "Off"}
                    </button>
                    <button
                      className={`toggle ${myPresence.textOnly ? "active" : ""}`}
                      onClick={() => void updatePresence({ textOnly: !myPresence.textOnly })}
                      disabled={busy}
                    >
                      Text Only {myPresence.textOnly ? "On" : "Off"}
                    </button>
                  </div>
                ) : (
                  <div className="presence-controls">
                    <button className="button" onClick={() => void joinOrbitById(currentOrbitId)} disabled={busy}>
                      Join this Orbit to enable controls
                    </button>
                  </div>
                )}

                <div className="orbit-layout">
                  <aside className="participants">
                    <h3>Participants ({orbitDetail.participants.length})</h3>
                    <ul>
                      {orbitDetail.participants.map((participant) => (
                        <li key={participant.userId}>
                          <span>{participant.displayName}</span>
                          <div className="presence-pills">
                            <span className={`pill ${participant.micOn ? "on" : "off"}`}>mic</span>
                            <span className={`pill ${participant.camOn ? "on" : "off"}`}>cam</span>
                            <span className={`pill ${participant.textOnly ? "on" : "off"}`}>text</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </aside>

                  <section className="chat">
                    <h3>Chat</h3>
                    <div className="messages">
                      {orbitDetail.messages.length === 0 ? (
                        <p className="muted">No messages yet.</p>
                      ) : (
                        orbitDetail.messages.map((message) => (
                          <article key={message.messageId} className="message-item">
                            <div className="message-meta">
                              <strong>{message.displayName}</strong>
                              <span>{formatClock(message.createdAt)}</span>
                            </div>
                            <p>{message.text}</p>
                          </article>
                        ))
                      )}
                    </div>

                    <form className="composer" onSubmit={(event) => void sendMessage(event)}>
                      <input
                        value={composerText}
                        onChange={(event) => setComposerText(event.target.value)}
                        placeholder="Say something in orbit..."
                        maxLength={1000}
                      />
                      <button className="button" type="submit" disabled={busy || !myPresence}>
                        Send
                      </button>
                    </form>
                  </section>
                </div>
              </>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
