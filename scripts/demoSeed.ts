import { initializeStore, seedDemoData } from "../server/store.js";

await initializeStore();
await seedDemoData();

console.log("[Mercury Orbit] Demo seed complete: 5 users, 3 live orbits.");
