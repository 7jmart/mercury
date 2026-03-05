import type { Response } from "express";

import type { OrbitEvent } from "../shared/models.js";

interface OrbitClient {
  res: Response;
  keepAliveTimer: NodeJS.Timeout;
}

export class OrbitRealtimeHub {
  private readonly channels = new Map<string, Set<OrbitClient>>();

  subscribe(orbitId: string, res: Response): void {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    res.write("retry: 2500\n\n");

    const keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`: keepalive ${Date.now()}\n\n`);
      }
    }, 15000);

    const client: OrbitClient = {
      res,
      keepAliveTimer,
    };

    const existing = this.channels.get(orbitId);
    if (existing) {
      existing.add(client);
    } else {
      this.channels.set(orbitId, new Set([client]));
    }

    res.on("close", () => {
      clearInterval(keepAliveTimer);
      const subscribers = this.channels.get(orbitId);
      if (!subscribers) {
        return;
      }

      subscribers.delete(client);
      if (subscribers.size === 0) {
        this.channels.delete(orbitId);
      }
    });
  }

  publish(event: OrbitEvent): void {
    const subscribers = this.channels.get(event.orbitId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

    for (const client of subscribers) {
      if (client.res.writableEnded) {
        continue;
      }

      try {
        client.res.write(frame);
      } catch {
        // Ignore write errors; the close handler prunes stale clients.
      }
    }
  }
}

export const orbitRealtimeHub = new OrbitRealtimeHub();
