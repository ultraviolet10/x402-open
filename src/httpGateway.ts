import type { Router, Request, Response } from "express";
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
} from "./gateway/core.js";

export type HttpGatewayOptions = GatewayOptions;

export function createHttpGatewayAdapter(router: Router, options: HttpGatewayOptions): void {
  const basePath = options.basePath ?? "";
  const sticky = new StickyRouter();
  const registry = new PeerRegistry();

  function normalizePath(path: string): string {
    const p = basePath + path;
    return p || "/";
  }

  function peers(): string[] {
    return registry.getActivePeers(options.httpPeers ?? []);
  }

  // GET /supported — aggregate from peers
  router.get(normalizePath("/supported"), async (_req: Request, res: Response) => {
    const kinds = await aggregateSupportedKinds(peers());
    return res.status(200).json({ kinds });
  });

  // POST /verify — single randomly selected node (stick to this node by payer/header)
  router.post(normalizePath("/verify"), async (req: Request, res: Response) => {
    const activePeers = peers();
    if (!activePeers || activePeers.length === 0) return res.status(503).json({ error: "No peers configured" });

    const forwardBody = normalizeForwardBody(req.body);

    try {
      const primary = pickSelectedPeerForVerify(activePeers);
      const order = rotateToNext(activePeers, primary);
      let lastError: PeerResponse | undefined;
      for (const base of order) {
        const url = normalizeUrl(base) + "/verify";
        try {
          if (options.debug) console.log("[http-gateway] verify via", url);
          const response = await postJson(url, forwardBody, VERIFY_TIMEOUT);
          if (response.status === 200) {
            sticky.recordSelection(base, forwardBody, response.body);
            return res.status(200).json(response.body);
          }
          if (options.debug) console.log("[http-gateway] verify non-200 from", url, response.status, response.body);
          lastError = response;
        } catch (e: unknown) {
          if (options.debug) console.log("[http-gateway] verify network error from", url, e instanceof Error ? e.message : e);
        }
      }
      if (lastError) return res.status(lastError.status).json(lastError.body);
      return res.status(503).json({ error: "Verification unavailable" });
    } catch (err: unknown) {
      return res.status(500).json({ error: "Internal error", message: err instanceof Error ? err.message : "Unknown error" });
    }
  });

  // POST /settle — use the same selected node (sticky by payer/header); fallback to others on failure
  router.post(normalizePath("/settle"), async (req: Request, res: Response) => {
    const activePeers = peers();
    if (!activePeers || activePeers.length === 0) return res.status(503).json({ success: false, error: "No peers configured", txHash: null, networkId: null });

    const forwardBody = normalizeForwardBody(req.body);
    const preferred = sticky.getPreferredPeer(forwardBody) ?? pickSelectedPeerForVerify(activePeers);
    const order = rotateToNext(activePeers, preferred);

    for (const peer of order) {
      const url = normalizeUrl(peer) + "/settle";
      try {
        if (options.debug) console.log("[http-gateway] settling via", url);
        const response = await postJson(url, forwardBody, SETTLE_TIMEOUT);
        if (response.status === 200) return res.status(200).json(response.body);
        if (options.debug) console.log("[http-gateway] settle non-200 from", url, response.status, response.body);
      } catch (err: unknown) {
        if (options.debug) console.log("[http-gateway] settle network error from", url, err instanceof Error ? err.message : err);
      }
    }
    return res.status(503).json({ success: false, error: "Settle unavailable", txHash: null, networkId: null });
  });

  // POST /register — nodes can self-register with the gateway
  router.post(normalizePath("/register"), async (req: Request, res: Response) => {
    try {
      const body = req.body as { url?: string; kinds?: unknown[] };
      const url = String(body?.url || "").trim();
      if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid url" });
      registry.register(url, body?.kinds as Parameters<typeof registry.register>[1]);
      return res.status(200).json({ ok: true });
    } catch (e: unknown) {
      return res.status(400).json({ error: e instanceof Error ? e.message : "Invalid request" });
    }
  });

  // Optional: expose current active peers for external load balancers/diagnostics
  router.get(normalizePath("/peers"), (_req: Request, res: Response) => {
    return res.status(200).json({ peers: peers() });
  });
}
