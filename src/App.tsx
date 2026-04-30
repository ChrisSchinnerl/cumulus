import { useEffect, useState } from "react";

import { AuthFlow } from "./components/auth/AuthFlow";
import { BlueskySignIn } from "./components/auth/BlueskySignIn";
import { LoadingScreen } from "./components/auth/LoadingScreen";
import { Feed } from "./components/feed/Feed";
import { Navbar } from "./components/Navbar";
import { ProfileView } from "./components/profile/ProfileView";
import { Toasts } from "./components/Toast";
import { UploadZone } from "./components/upload/UploadZone";
import { initStreaming } from "./lib/streaming";
import { useAtprotoStore } from "./stores/atproto";
import { useAuthStore } from "./stores/auth";

/** Route shape parsed from `window.location.hash`. */
type Route = { type: "home" } | { type: "profile"; handle: string };

/**
 * Parse the current hash into a route. Recognized:
 * - `#/profile/<handle>` → profile view for that user
 * - anything else → home (feed + composer)
 */
function parseRoute(hash: string): Route {
  const match = /^#\/profile\/(.+)$/.exec(hash);
  if (match) return { type: "profile", handle: decodeURIComponent(match[1]) };
  return { type: "home" };
}

/**
 * Root component. Gates the main app UI on having both a Sia SDK session
 * and a Bluesky/atproto session. The atproto store self-hydrates on mount
 * (restoring an existing session or processing an OAuth callback).
 *
 * Uses lightweight hash-based routing: `#/profile/<handle>` swaps the home
 * feed for a single-user profile view; the empty hash returns to the feed.
 */
export default function App() {
  const siaStep = useAuthStore((s) => s.step);
  const atprotoInit = useAtprotoStore((s) => s.init);
  const atprotoInitialized = useAtprotoStore((s) => s.initialized);
  const atprotoInitializing = useAtprotoStore((s) => s.initializing);
  const atprotoSession = useAtprotoStore((s) => s.session);
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.hash),
  );

  useEffect(() => {
    atprotoInit();
    initStreaming().catch((e) => {
      console.warn("Streaming Service Worker setup failed:", e);
    });
  }, [atprotoInit]);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  let body: React.ReactNode;
  if (siaStep !== "connected") {
    body = <AuthFlow />;
  } else if (!atprotoInitialized || atprotoInitializing) {
    body = <LoadingScreen />;
  } else if (!atprotoSession) {
    body = <BlueskySignIn />;
  } else if (route.type === "profile") {
    body = <ProfileView handle={route.handle} />;
  } else {
    body = (
      <div className="flex-1 p-6 max-w-3xl mx-auto w-full space-y-6">
        <UploadZone />
        <Feed />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <div className="flex-1 flex flex-col">{body}</div>
      <Toasts />
    </div>
  );
}
