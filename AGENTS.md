# AGENTS.md

## Mercury Orbit Workstation Workflow

### Commands

- `npm install` installs all dependencies.
- `npm run demo:seed` creates demo users and live Orbit data in `data/dev`.
- `npm run demo:reset` clears local persisted state in `data/dev`.
- `npm run dev` starts API + web together.
- `npm run dev:api` starts only the API server on port `4000`.
- `npm run dev:web` starts only the Vite app on port `5183`.
- `npm run typecheck` runs TypeScript checks for API and web.

### Environment Variables

- `API_PORT` (default `4000`) controls the API server port.
- `WEB_PORT` (default `5183`) is used by API startup logs to display expected web URL.

### Folder Structure

- `server/`
  - `index.ts`: Express API and Orbit routes.
  - `store.ts`: file-backed persistence, mutex, Orbit state operations.
  - `realtime.ts`: SSE realtime hub for Orbit events.
  - `auth.ts`: dev token encode/decode helpers.
- `web/`
  - `src/App.tsx`: Orbit UI (feed, room, chat, presence toggles, dev login).
  - `src/api.ts`: fetch helpers with Bearer token support.
  - `vite.config.ts`: API proxy and shared alias setup.
- `shared/`
  - `models.ts`: shared TypeScript interfaces for API and web.
- `scripts/`
  - `demoSeed.ts`: seeds 5 demo users + 3 live Orbits.
  - `demoReset.ts`: wipes persisted data.
- `data/dev/`
  - `users.json`
  - `orbits.json`
  - `presence.json`
  - `messages.json`

### Multi-Tab Simulation

1. Run `npm run demo:seed`.
2. Run `npm run dev`.
3. Open `http://localhost:5183` in tab 1 and login as one demo user.
4. Open one or more additional tabs and login as different users.
5. Join the same Orbit from each tab to test realtime participant and message updates.

### Orbit MVP Local Test Flow

1. User A opens an Orbit from the home feed.
2. User B joins User A's Orbit.
3. User B sends text messages and verify they appear in all tabs.
4. Toggle mic/cam/text-only states and verify participant badges update live.
5. User B leaves and verify participant list updates.
6. User A leaves and verify Orbit closes from live feed.
