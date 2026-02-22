// Shared gateway logic used by both Express and Hono gateway adapters.

import type { SupportedPaymentKind } from "x402/types";
import type {
  ForwardBody,
  StickyEntry,
  RegisteredPeer,
  PeerResponse,
  VerifyResponseBody,
} from "./types.js";

// Re-export types for convenience
export type { PeerResponse } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

export const VERIFY_TIMEOUT = 10_000;
export const SETTLE_TIMEOUT = 30_000;
export const SELECTION_TTL_MS = 1 * 60_000; // sticky selection expires after 1 minute
export const REGISTRY_TTL_MS = 2 * 60_000; // registered peers expire if no heartbeat
export const CLEANUP_INTERVAL_MS = 30_000; // cleanup runs every 30 seconds

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strips trailing slash from a URL for consistent comparison/concatenation.
 */
export function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<PeerResponse<T>> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: T;
    try {
      parsed = text ? JSON.parse(text) : (undefined as T);
    } catch {
      parsed = text as T;
    }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(t);
  }
}

export function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function getHeaderFromBody(body: ForwardBody): string | undefined {
  // Prefer explicit header fields if present (EVM flow)
  if (body?.paymentHeader) return body.paymentHeader;
  // Check for legacy header format in paymentPayload
  const payloadObj = body?.paymentPayload as Record<string, unknown> | undefined;
  if (payloadObj?.header && typeof payloadObj.header === "string") {
    return payloadObj.header;
  }
  // For Solana, we don't have a header; use the raw transaction blob as a sticky key
  const payload = payloadObj?.payload as
    | { transaction?: string }
    | undefined;
  const solanaTx = payload?.transaction;
  if (typeof solanaTx === "string" && solanaTx.length > 0) return solanaTx;
  return undefined;
}

export function getPayerFromBody(body: ForwardBody): string | undefined {
  try {
    const payloadObj = body?.paymentPayload as Record<string, unknown> | undefined;
    const payload = payloadObj?.payload as
      | { authorization?: { from?: string } }
      | undefined;
    return payload?.authorization?.from;
  } catch {
    return undefined;
  }
}

export function getPayerFromVerifyResponse(
  respBody: VerifyResponseBody | unknown
): string | undefined {
  if (respBody && typeof respBody === "object") {
    const p = (respBody as VerifyResponseBody).payer;
    if (typeof p === "string" && p.length > 0) return p;
  }
  return undefined;
}

export function rotateToNext(peers: string[], current: string): string[] {
  if (peers.length <= 1) return peers.slice();
  const rest = peers.filter((p) => p !== current).sort(() => Math.random() - 0.5);
  return [current, ...rest];
}

export function pickSelectedPeerForVerify(peers: string[]): string {
  if (peers.length === 1) return peers[0];
  return pickRandom(peers);
}

/**
 * Normalizes the inbound body to a consistent shape for forwarding.
 * Handles both spec format ({ paymentPayload, paymentRequirements })
 * and legacy format ({ paymentHeader, paymentRequirements }).
 */
export function normalizeForwardBody(inbound: ForwardBody): ForwardBody {
  if (inbound?.paymentPayload && inbound?.paymentRequirements) return inbound;
  if (inbound?.paymentHeader && inbound?.paymentRequirements) {
    return {
      paymentPayload: { header: inbound.paymentHeader },
      paymentRequirements: inbound.paymentRequirements,
    };
  }
  return inbound;
}

// ─── Sticky Router (payer/header → peer mapping with TTL) ────────────────────

export class StickyRouter {
  private byPayer = new Map<string, StickyEntry>();
  private byHeader = new Map<string, StickyEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(autoCleanup = true) {
    if (autoCleanup) this.startCleanup();
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow process to exit even if timer is active
    this.cleanupTimer.unref?.();
  }

  recordSelection(
    peer: string,
    body: ForwardBody,
    verifyResponseBody: VerifyResponseBody | unknown
  ): void {
    const now = Date.now();
    const payer =
      getPayerFromVerifyResponse(verifyResponseBody) ?? getPayerFromBody(body);
    if (payer)
      this.byPayer.set(payer.toLowerCase(), {
        peer,
        expiresAt: now + SELECTION_TTL_MS,
      });
    const key = getHeaderFromBody(body);
    if (key)
      this.byHeader.set(key, { peer, expiresAt: now + SELECTION_TTL_MS });
  }

  getPreferredPeer(body: ForwardBody): string | undefined {
    const now = Date.now();
    const payer = getPayerFromBody(body)?.toLowerCase();
    const byPayer = payer ? this.byPayer.get(payer) : undefined;
    if (byPayer && byPayer.expiresAt > now) return byPayer.peer;
    const key = getHeaderFromBody(body);
    const byHeader = key ? this.byHeader.get(key) : undefined;
    if (byHeader && byHeader.expiresAt > now) return byHeader.peer;
    return undefined;
  }

  /**
   * Remove expired entries from the cache.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [k, v] of this.byPayer) {
      if (v.expiresAt <= now) this.byPayer.delete(k);
    }
    for (const [k, v] of this.byHeader) {
      if (v.expiresAt <= now) this.byHeader.delete(k);
    }
  }

  /**
   * Stop cleanup timer and clear all state.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.byPayer.clear();
    this.byHeader.clear();
  }

  /**
   * Get current cache sizes for monitoring.
   */
  get size(): { payers: number; headers: number } {
    return { payers: this.byPayer.size, headers: this.byHeader.size };
  }
}

// ─── Peer Registry (static + registered peers with TTL) ──────────────────────

export class PeerRegistry {
  private registered = new Map<string, RegisteredPeer>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(autoCleanup = true) {
    if (autoCleanup) this.startCleanup();
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow process to exit even if timer is active
    this.cleanupTimer.unref?.();
  }

  register(url: string, kinds?: SupportedPaymentKind[]): void {
    this.registered.set(url, { url, kinds, lastSeenMs: Date.now() });
  }

  getActivePeers(staticPeers: string[]): string[] {
    const out = new Set<string>();
    for (const p of staticPeers) out.add(normalizeUrl(p));
    const now = Date.now();
    for (const { url, lastSeenMs } of this.registered.values()) {
      if (now - lastSeenMs <= REGISTRY_TTL_MS) out.add(normalizeUrl(url));
    }
    return Array.from(out);
  }

  /**
   * Remove stale peers that haven't sent a heartbeat within TTL.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [k, v] of this.registered) {
      if (now - v.lastSeenMs > REGISTRY_TTL_MS) this.registered.delete(k);
    }
  }

  /**
   * Stop cleanup timer and clear all state.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.registered.clear();
  }

  /**
   * Get current registry size for monitoring.
   */
  get size(): number {
    return this.registered.size;
  }
}

// ─── Aggregation helper ──────────────────────────────────────────────────────

export async function aggregateSupportedKinds(
  peers: string[]
): Promise<SupportedPaymentKind[]> {
  if (!peers || peers.length === 0) return [];
  const results = await Promise.allSettled(
    peers.map(async (base) => {
      try {
        const url = normalizeUrl(base) + "/supported";
        const r = await fetch(url);
        const j = (await r.json()) as { kinds?: SupportedPaymentKind[] };
        return Array.isArray(j?.kinds) ? j.kinds : [];
      } catch {
        return [] as SupportedPaymentKind[];
      }
    })
  );
  const kinds: SupportedPaymentKind[] = [];
  for (const r of results)
    if (r.status === "fulfilled") kinds.push(...r.value);
  const seen = new Set<string>();
  return kinds.filter((k) => {
    const key = JSON.stringify(k);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Shared gateway options type ─────────────────────────────────────────────

export type GatewayOptions = {
  basePath?: string;
  httpPeers: string[];
  debug?: boolean;
};
