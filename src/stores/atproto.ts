import type { Agent } from "@atproto/api";
import type { OAuthSession } from "@atproto/oauth-client-browser";
import { create } from "zustand";
import { getOAuthClient, makeAgent, OAUTH_SCOPE } from "../lib/atproto";

/**
 * In-memory atproto session state. Persistence lives inside the OAuth
 * client's IndexedDB store — this Zustand store is rehydrated on page load
 * by calling {@link useAtprotoStore.getState().init}.
 */
type AtprotoState = {
  session: OAuthSession | null;
  agent: Agent | null;
  did: string | null;
  handle: string | null;
  avatar: string | null;
  initialized: boolean;
  /**
   * True for the entire duration of {@link AtprotoState.init} — set
   * synchronously at the start, cleared atomically with `initialized` and
   * the rest of the state at the end. Lets callers (e.g. App's render
   * gate) keep showing the loading screen across the full async OAuth
   * callback round-trip, without flashing the sign-in screen between
   * "init done" and "session populated."
   */
  initializing: boolean;
  error: string | null;

  /**
   * Restore an existing session or process an OAuth callback in the URL.
   * Idempotent — safe to call multiple times. Sets `initialized = true` once
   * complete so callers can wait on the initial hydration.
   */
  init: () => Promise<void>;
  /** Begin OAuth sign-in for the given handle/DID/PDS — redirects the page. */
  signIn: (handle: string) => Promise<never>;
  /** Revoke the current session and clear in-memory state. */
  signOut: () => Promise<void>;
};

/** Look up the user's profile (handle, avatar) by DID. */
async function fetchProfile(
  agent: Agent,
  did: string,
): Promise<{
  handle: string;
  avatar: string | null;
}> {
  const res = await agent.app.bsky.actor.getProfile({ actor: did });
  return {
    handle: res.data.handle,
    avatar: res.data.avatar ?? null,
  };
}

export const useAtprotoStore = create<AtprotoState>((set, get) => ({
  session: null,
  agent: null,
  did: null,
  handle: null,
  avatar: null,
  initialized: false,
  initializing: false,
  error: null,

  init: async () => {
    if (get().initialized || get().initializing) return;
    set({ initializing: true });
    try {
      const client = await getOAuthClient();
      const result = await client.init();
      if (result?.session) {
        const agent = makeAgent(result.session);
        const did = result.session.did;
        const profile = await fetchProfile(agent, did).catch(() => null);
        set({
          session: result.session,
          agent,
          did,
          handle: profile?.handle ?? null,
          avatar: profile?.avatar ?? null,
          initialized: true,
          initializing: false,
          error: null,
        });
      } else {
        set({ initialized: true, initializing: false });
      }
    } catch (e) {
      console.error("atproto init error:", e);
      set({
        initialized: true,
        initializing: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  signIn: async (handle: string) => {
    const client = await getOAuthClient();
    return client.signInRedirect(handle, { scope: OAUTH_SCOPE });
  },

  signOut: async () => {
    const session = get().session;
    if (session) {
      await session.signOut().catch(() => undefined);
    }
    set({
      session: null,
      agent: null,
      did: null,
      handle: null,
      avatar: null,
      error: null,
    });
  },
}));
