import { Hono } from "hono";
import {
  type GatewayOptions,
  type PeerResponse,
  postJson,
  normalizeForwardBody,
  normalizeUrl,
  pickSelectedPeerForVerify,
  rotateToNext,
  aggregateSupportedKinds,
  StickyRouter,
  PeerRegistry,
  VERIFY_TIMEOUT,
  SETTLE_TIMEOUT,
} from "../gateway/core.js";

export type HonoGatewayOptions = GatewayOptions;

/**
 * Creates a Hono app that acts as an HTTP gateway, routing verify/settle
 * requests across multiple facilitator nodes with sticky routing.
 *
 * Mount with `parentApp.route("/facilitator", createHonoGatewayAdapter(opts))`.
 *
 * Routes exposed (relative to mount point):
 *   GET  /supported   — aggregated kinds from all peers
 *   POST /verify      — random node, sticky selection recorded
 *   POST /settle      — sticky node from verify, fallback to others
 *   POST /register    — node self-registration
 *   GET  /peers       — diagnostic: list active peers
 */
export function createHonoGatewayAdapter(options: HonoGatewayOptions): Hono {
  const app = new Hono();
  const sticky = new StickyRouter();
  const registry = new PeerRegistry();

  function peers(): string[] {
    return registry.getActivePeers(options.httpPeers ?? []);
  }

  // GET /supported — aggregate from peers
  app.get("/supported", async (c) => {
    const kinds = await aggregateSupportedKinds(peers());
    return c.json({ kinds });
  });

  // POST /verify — single randomly selected node (stick to this node by payer/header)
  app.post("/verify", async (c) => {
    const activePeers = peers();
    if (!activePeers || activePeers.length === 0) return c.json({ error: "No peers configured" }, 503);

    const inbound = await c.req.json();
    const forwardBody = normalizeForwardBody(inbound);

    try {
      const primary = pickSelectedPeerForVerify(activePeers);
      const order = rotateToNext(activePeers, primary);
      let lastError: PeerResponse | undefined;
      for (const base of order) {
        const url = normalizeUrl(base) + "/verify";
        try {
          if (options.debug) console.log("[hono-gateway] verify via", url);
          const response = await postJson(url, forwardBody, VERIFY_TIMEOUT);
          if (response.status === 200) {
            sticky.recordSelection(base, forwardBody, response.body);
            return c.json(response.body);
          }
          if (options.debug) console.log("[hono-gateway] verify non-200 from", url, response.status, response.body);
          lastError = response;
        } catch (e: unknown) {
          if (options.debug) console.log("[hono-gateway] verify network error from", url, e instanceof Error ? e.message : e);
        }
      }
      if (lastError) return c.json(lastError.body, lastError.status as 400);
      return c.json({ error: "Verification unavailable" }, 503);
    } catch (err: unknown) {
      return c.json({ error: "Internal error", message: err instanceof Error ? err.message : "Unknown error" }, 500);
    }
  });

  // POST /settle — use the same selected node (sticky by payer/header); fallback to others on failure
  app.post("/settle", async (c) => {
    const activePeers = peers();
    if (!activePeers || activePeers.length === 0) {
      return c.json({ success: false, error: "No peers configured", txHash: null, networkId: null }, 503);
    }

    const inbound = await c.req.json();
    const forwardBody = normalizeForwardBody(inbound);
    const preferred = sticky.getPreferredPeer(forwardBody) ?? pickSelectedPeerForVerify(activePeers);
    const order = rotateToNext(activePeers, preferred);

    for (const peer of order) {
      const url = normalizeUrl(peer) + "/settle";
      try {
        if (options.debug) console.log("[hono-gateway] settling via", url);
        const response = await postJson(url, forwardBody, SETTLE_TIMEOUT);
        if (response.status === 200) return c.json(response.body);
        if (options.debug) console.log("[hono-gateway] settle non-200 from", url, response.status, response.body);
      } catch (err: unknown) {
        if (options.debug) console.log("[hono-gateway] settle network error from", url, err instanceof Error ? err.message : err);
      }
    }
    return c.json({ success: false, error: "Settle unavailable", txHash: null, networkId: null }, 503);
  });

  // POST /register — nodes can self-register with the gateway
  app.post("/register", async (c) => {
    try {
      const body = (await c.req.json()) as { url?: string; kinds?: unknown[] };
      const url = String(body?.url || "").trim();
      if (!url || !/^https?:\/\//i.test(url)) return c.json({ error: "Invalid url" }, 400);
      registry.register(url, body?.kinds as Parameters<typeof registry.register>[1]);
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Invalid request" }, 400);
    }
  });

  // GET /peers — diagnostic endpoint
  app.get("/peers", (c) => {
    return c.json({ peers: peers() });
  });

  return app;
}
