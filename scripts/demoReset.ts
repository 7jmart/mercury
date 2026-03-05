import { initializeStore, resetDemoData } from "../server/store.js";

await initializeStore();
await resetDemoData();

console.log("[Mercury Orbit] Demo reset complete: dev state cleared.");
