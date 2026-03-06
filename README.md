# Mercury

Mercury is a live presence network where people open personal rooms called **Orbits** and others can join instantly.

## Mercury Orbit (Local Dev)

1. Install dependencies: `npm install`
2. Seed demo state: `npm run demo:seed`
3. Start API + web together: `npm run dev`
4. Open `http://localhost:5183`, choose a demo user in the login selector, and open an Orbit.
5. Open more browser tabs with different users to test join, chat, and presence toggles in real time.

### Helpful Commands

- API only: `npm run dev:api`
- Web only: `npm run dev:web`
- Reset local state: `npm run demo:reset`
- Type check: `npm run typecheck`

### API URLs

- Health: `GET http://localhost:4000/api/health`
- SSE stream: `GET http://localhost:4000/api/orbits/:orbitId/events`

## Mercury V1 (Friend Communication)

Mercury now includes a production-style `v1` API surface for phone OTP auth, friend graph, private/public rooms, messaging, invites, and Socket.IO realtime events.

### Quick Start (V1)

1. Install root dependencies: `npm install`
2. (Optional) Start Postgres + Redis: `npm run infra:up`
3. Start API + web: `npm run dev`
4. Open web companion mode: `http://localhost:5183/?mode=companion`
5. In dev mode, OTP endpoint returns `debugCode` for login verification.

### Mobile Scaffold

- Mobile app source is in `mobile/` (Expo).
- Install mobile dependencies: `npm --prefix mobile install`
- Start mobile app: `npm run dev:mobile`

### V1 Endpoints

- Auth: `/api/v1/auth/phone/send-code`, `/api/v1/auth/phone/verify`, `/api/v1/auth/refresh`, `/api/v1/auth/logout`
- Friends: `/api/v1/friends`, `/api/v1/friends/request`, `/api/v1/friends/request/:requestId/accept`, `/api/v1/friends/request/:requestId/decline`
- Rooms: `/api/v1/rooms`, `/api/v1/rooms/:roomId`, `/api/v1/rooms/:roomId/join`, `/api/v1/rooms/:roomId/leave`, `/api/v1/rooms/:roomId/end`, `/api/v1/rooms/:roomId/privacy`
- Media token: `/api/v1/rooms/:roomId/media-token`
- Messaging: `/api/v1/rooms/:roomId/messages`
- Invites: `/api/v1/invites`, `/api/v1/invites/:code/accept`
- Push: `/api/v1/push/register`, `/api/v1/push/unregister`
- Safety + telemetry: `/api/v1/rooms/:roomId/report`, `/api/v1/events`, `/api/v1/events/summary`

### Key Environment Variables

- `JWT_SECRET` for access token signing
- `ACCESS_TOKEN_TTL_SECONDS` access token TTL (default `900`)
- `REFRESH_TOKEN_TTL_MS` refresh token TTL (default 30 days)
- `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` for real LiveKit tokens
- If LiveKit env vars are missing, media endpoint returns a signed mock token for local development
