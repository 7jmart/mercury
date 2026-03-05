# Mercury

Mercury is a live presence network where people open personal rooms called **Orbits** and others can join instantly.

## Mercury Orbit (Local Dev)

1. Install dependencies: `npm install`
2. Seed demo state: `npm run demo:seed`
3. Start API + web together: `npm run dev`
4. Open `http://localhost:5173`, choose a demo user in the login selector, and open an Orbit.
5. Open more browser tabs with different users to test join, chat, and presence toggles in real time.

### Helpful Commands

- API only: `npm run dev:api`
- Web only: `npm run dev:web`
- Reset local state: `npm run demo:reset`
- Type check: `npm run typecheck`

### API URLs

- Health: `GET http://localhost:4000/api/health`
- SSE stream: `GET http://localhost:4000/api/orbits/:orbitId/events`
