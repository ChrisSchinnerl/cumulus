import { isSharePost, NSID_SHARE_POST, type SharePost } from "./lexicons";

/**
 * Public Jetstream endpoint. Bluesky operates a few mirrors; this one's in
 * the US east. We only filter server-side by NSID — collection traffic is
 * extremely low for `app.cumulus.share.post`, so client-side follow
 * filtering at the subscriber site stays cheap.
 */
const JETSTREAM_URL = "wss://jetstream2.us-east.bsky.network/subscribe";

/** Backoff between reconnect attempts when the socket drops. */
const RECONNECT_DELAY_MS = 2000;

/** A normalized create event we hand to subscribers. */
export type CumulusEvent = {
  /** Author DID. */
  did: string;
  /** Reconstructed at-uri of the new record. */
  uri: string;
  /** Record key in the author's repo. */
  rkey: string;
  /** Validated `app.cumulus.share.post` payload. */
  record: SharePost;
  /** Microseconds since epoch — Jetstream's monotonic ordering field. */
  timeUs: number;
};

type Handler = (event: CumulusEvent) => void;

let ws: WebSocket | null = null;
/**
 * Last-seen Jetstream cursor (microseconds since epoch). Persisted across
 * reconnects so we resume from where we dropped off and don't miss creates
 * during transient disconnects.
 */
let cursor: number | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<Handler>();

function buildUrl(): string {
  const url = new URL(JETSTREAM_URL);
  url.searchParams.set("wantedCollections", NSID_SHARE_POST);
  if (cursor !== null) url.searchParams.set("cursor", String(cursor));
  return url.toString();
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  ws = new WebSocket(buildUrl());
  ws.onmessage = (msg) => {
    let data: unknown;
    try {
      data = JSON.parse(typeof msg.data === "string" ? msg.data : "");
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    const d = data as {
      kind?: string;
      did?: string;
      time_us?: number;
      commit?: {
        collection?: string;
        operation?: string;
        rkey?: string;
        record?: unknown;
      };
    };
    if (d.kind !== "commit") return;
    const c = d.commit;
    if (!c || c.collection !== NSID_SHARE_POST || c.operation !== "create") {
      return;
    }
    if (!isSharePost(c.record)) return;
    if (!d.did || !c.rkey) return;
    if (typeof d.time_us === "number") cursor = d.time_us;

    const event: CumulusEvent = {
      did: d.did,
      uri: `at://${d.did}/${c.collection}/${c.rkey}`,
      rkey: c.rkey,
      record: c.record,
      timeUs: d.time_us ?? 0,
    };
    for (const h of subscribers) {
      try {
        h(event);
      } catch (err) {
        console.warn("[jetstream] subscriber threw", err);
      }
    }
  };
  ws.onclose = () => {
    if (subscribers.size === 0) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  };
  ws.onerror = (err) => {
    console.warn("[jetstream] socket error", err);
  };
}

/**
 * Subscribe to live `app.cumulus.share.post` create events from anywhere on
 * the atproto network. Returns an unsubscribe function. The websocket is
 * shared across all subscribers and lazily opened/closed.
 *
 * Filtering by author/follow set is the caller's responsibility — Jetstream
 * filters server-side by NSID only.
 */
export function subscribeJetstream(handler: Handler): () => void {
  subscribers.add(handler);
  if (subscribers.size === 1) connect();
  return () => {
    subscribers.delete(handler);
    if (subscribers.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
      ws = null;
    }
  };
}
