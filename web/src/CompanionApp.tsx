import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import type { RoomDetail, RoomSummary, V1SessionResponse, V1AuthUser } from "@shared/v1";

import {
  CompanionApiError,
  createFriendRequest,
  createInvite,
  createRoom,
  createRoomMessage,
  getRoomDetail,
  joinRoom,
  leaveRoom,
  listFriends,
  listRooms,
  listUsers,
  sendOtpCode,
  verifyOtpCode,
} from "./companionApi";

const SESSION_KEY = "mercury:v1-session";

function readSession(): V1SessionResponse | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as V1SessionResponse;
  } catch {
    return null;
  }
}

function writeSession(session: V1SessionResponse | null): void {
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }

  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export default function CompanionApp(): JSX.Element {
  const [session, setSession] = useState<V1SessionResponse | null>(() => readSession());
  const [phoneNumber, setPhoneNumber] = useState("+1");
  const [displayName, setDisplayName] = useState("Friend");
  const [code, setCode] = useState("");
  const [lastDebugCode, setLastDebugCode] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready.");
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomTitle, setRoomTitle] = useState("Quick Hangout");
  const [roomPrivacy, setRoomPrivacy] = useState<"private" | "public">("private");
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null);
  const [roomDetail, setRoomDetail] = useState<RoomDetail | null>(null);
  const [messageText, setMessageText] = useState("");
  const [allUsers, setAllUsers] = useState<V1AuthUser[]>([]);
  const [friendUserId, setFriendUserId] = useState("");

  const accessToken = session?.accessToken;

  const loadRooms = useCallback(async () => {
    if (!accessToken) {
      return;
    }

    try {
      const response = await listRooms(accessToken);
      setRooms(response);
    } catch (error) {
      if (error instanceof CompanionApiError) {
        setStatus(error.message);
      }
    }
  }, [accessToken]);

  const loadUsers = useCallback(async () => {
    if (!accessToken) {
      return;
    }

    try {
      const response = await listUsers(accessToken);
      setAllUsers(response);

      if (!friendUserId) {
        const firstOtherUser = response.find((item) => item.userId !== session?.user.userId);
        if (firstOtherUser) {
          setFriendUserId(firstOtherUser.userId);
        }
      }
    } catch {
      // ignore optional user list failures
    }
  }, [accessToken, friendUserId, session?.user.userId]);

  const loadRoomDetail = useCallback(async () => {
    if (!accessToken || !currentRoomId) {
      return;
    }

    try {
      const detail = await getRoomDetail(currentRoomId, accessToken);
      setRoomDetail(detail);
    } catch (error) {
      if (error instanceof CompanionApiError) {
        setStatus(error.message);
      }
    }
  }, [accessToken, currentRoomId]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    void loadRooms();
    void loadUsers();

    const timer = window.setInterval(() => {
      void loadRooms();
      void loadRoomDetail();
    }, 4000);

    return () => {
      window.clearInterval(timer);
    };
  }, [accessToken, loadRoomDetail, loadRooms, loadUsers]);

  const sendCode = useCallback(async () => {
    try {
      const response = await sendOtpCode({ phoneNumber });
      setLastDebugCode(response.debugCode ?? null);
      setStatus(response.debugCode ? `Code sent. Dev code: ${response.debugCode}` : "Code sent.");
    } catch (error) {
      if (error instanceof CompanionApiError) {
        setStatus(error.message);
      }
    }
  }, [phoneNumber]);

  const loginWithCode = useCallback(async () => {
    try {
      const nextSession = await verifyOtpCode({
        phoneNumber,
        code,
        displayName,
      });
      setSession(nextSession);
      writeSession(nextSession);
      setStatus(`Logged in as ${nextSession.user.displayName}.`);
    } catch (error) {
      if (error instanceof CompanionApiError) {
        setStatus(error.message);
      }
    }
  }, [code, displayName, phoneNumber]);

  const logout = useCallback(() => {
    setSession(null);
    writeSession(null);
    setRooms([]);
    setRoomDetail(null);
    setCurrentRoomId(null);
    setStatus("Signed out.");
  }, []);

  const handleCreateRoom = useCallback(async () => {
    if (!accessToken) {
      return;
    }

    try {
      await createRoom(
        {
          title: roomTitle,
          privacy: roomPrivacy,
        },
        accessToken,
      );

      setStatus("Room created.");
      await loadRooms();
    } catch (error) {
      if (error instanceof CompanionApiError) {
        setStatus(error.message);
      }
    }
  }, [accessToken, loadRooms, roomPrivacy, roomTitle]);

  const handleJoinRoom = useCallback(
    async (roomId: string) => {
      if (!accessToken) {
        return;
      }

      try {
        await joinRoom(roomId, accessToken);
        setCurrentRoomId(roomId);
        await loadRoomDetail();
        setStatus("Joined room.");
      } catch (error) {
        if (error instanceof CompanionApiError) {
          setStatus(error.message);
        }
      }
    },
    [accessToken, loadRoomDetail],
  );

  const handleLeaveRoom = useCallback(async () => {
    if (!accessToken || !currentRoomId) {
      return;
    }

    try {
      await leaveRoom(currentRoomId, accessToken);
      setCurrentRoomId(null);
      setRoomDetail(null);
      setStatus("Left room.");
      await loadRooms();
    } catch (error) {
      if (error instanceof CompanionApiError) {
        setStatus(error.message);
      }
    }
  }, [accessToken, currentRoomId, loadRooms]);

  const handleSendMessage = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!accessToken || !currentRoomId) {
        return;
      }

      const text = messageText.trim();
      if (!text) {
        return;
      }

      try {
        await createRoomMessage(currentRoomId, { text, idempotencyKey: crypto.randomUUID() }, accessToken);
        setMessageText("");
        await loadRoomDetail();
      } catch (error) {
        if (error instanceof CompanionApiError) {
          setStatus(error.message);
        }
      }
    },
    [accessToken, currentRoomId, loadRoomDetail, messageText],
  );

  const handleInvite = useCallback(async () => {
    if (!accessToken || !currentRoomId) {
      return;
    }

    try {
      const invite = await createInvite({ roomId: currentRoomId }, accessToken);
      setStatus(`Invite code created: ${invite.code}`);
    } catch (error) {
      if (error instanceof CompanionApiError) {
        setStatus(error.message);
      }
    }
  }, [accessToken, currentRoomId]);

  const handleFriendRequest = useCallback(async () => {
    if (!accessToken || !friendUserId) {
      return;
    }

    try {
      await createFriendRequest({ targetUserId: friendUserId }, accessToken);
      await listFriends(accessToken);
      setStatus("Friend request sent.");
    } catch (error) {
      if (error instanceof CompanionApiError) {
        setStatus(error.message);
      }
    }
  }, [accessToken, friendUserId]);

  const selectableUsers = useMemo(
    () => allUsers.filter((candidate) => candidate.userId !== session?.user.userId),
    [allUsers, session?.user.userId],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Mercury</p>
          <h1>Friend Companion</h1>
          <p className="subtitle">Phone OTP + private rooms + text/voice prep APIs.</p>
        </div>
        <div className="header-actions">
          <p className="status">{status}</p>
          {session ? (
            <button className="button button-ghost" onClick={logout}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>

      {!session ? (
        <section className="panel login-panel">
          <h2>Phone Login</h2>
          <div className="custom-login">
            <label>
              Phone Number
              <input value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} />
            </label>
            <label>
              Display Name
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
            <label>
              OTP Code
              <input value={code} onChange={(event) => setCode(event.target.value)} />
            </label>
            <button className="button button-secondary" onClick={() => void sendCode()}>
              Send Code
            </button>
            <button className="button" onClick={() => void loginWithCode()}>
              Verify & Login
            </button>
            {lastDebugCode ? <p className="muted">Dev mode code: {lastDebugCode}</p> : null}
          </div>
        </section>
      ) : (
        <main className="workspace">
          <section className="panel live-panel">
            <div className="panel-header">
              <h2>Rooms</h2>
              <p>{session.user.displayName}</p>
            </div>

            <div className="orbit-list">
              <article className="orbit-card">
                <label>
                  Title
                  <input value={roomTitle} onChange={(event) => setRoomTitle(event.target.value)} />
                </label>
                <label>
                  Privacy
                  <select value={roomPrivacy} onChange={(event) => setRoomPrivacy(event.target.value as "private" | "public")}> 
                    <option value="private">private</option>
                    <option value="public">public</option>
                  </select>
                </label>
                <button className="button" onClick={() => void handleCreateRoom()}>
                  Create Room
                </button>
              </article>

              {rooms.map((room) => (
                <article key={room.roomId} className="orbit-card">
                  <h3>{room.title}</h3>
                  <p>{room.privacy} - {room.participantCount} online</p>
                  <button className="button button-secondary" onClick={() => void handleJoinRoom(room.roomId)}>
                    Join
                  </button>
                </article>
              ))}
            </div>
          </section>

          <section className="panel orbit-panel">
            {!currentRoomId || !roomDetail ? (
              <div className="orbit-empty-state">
                <h2>Select a Room</h2>
                <p>Join a room to chat and create invite codes.</p>
                <label>
                  Send Friend Request To
                  <select value={friendUserId} onChange={(event) => setFriendUserId(event.target.value)}>
                    <option value="">Select user</option>
                    {selectableUsers.map((candidate) => (
                      <option key={candidate.userId} value={candidate.userId}>
                        {candidate.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="button" onClick={() => void handleFriendRequest()} disabled={!friendUserId}>
                  Send Friend Request
                </button>
              </div>
            ) : (
              <>
                <div className="panel-header orbit-header">
                  <div>
                    <h2>{roomDetail.room.title}</h2>
                    <p>{roomDetail.room.privacy} - {roomDetail.members.length} members</p>
                  </div>
                  <div className="orbit-header-actions">
                    <button className="button button-secondary" onClick={() => void handleInvite()}>
                      Create Invite
                    </button>
                    <button className="button button-ghost" onClick={() => void handleLeaveRoom()}>
                      Leave
                    </button>
                  </div>
                </div>

                <div className="orbit-layout">
                  <aside className="participants">
                    <h3>Members</h3>
                    <ul>
                      {roomDetail.members.map((member) => (
                        <li key={member.roomMemberId}>
                          <span>{member.userId}</span>
                          <span className={`pill ${member.muted ? "off" : "on"}`}>{member.role}</span>
                        </li>
                      ))}
                    </ul>
                  </aside>

                  <section className="chat">
                    <h3>Messages</h3>
                    <div className="messages">
                      {roomDetail.messages.map((message) => (
                        <article key={message.messageId} className="message-item">
                          <div className="message-meta">
                            <strong>{message.userId}</strong>
                            <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
                          </div>
                          <p>{message.text}</p>
                        </article>
                      ))}
                    </div>

                    <form className="composer" onSubmit={(event) => void handleSendMessage(event)}>
                      <input
                        value={messageText}
                        onChange={(event) => setMessageText(event.target.value)}
                        placeholder="Type a message"
                      />
                      <button className="button" type="submit">
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
