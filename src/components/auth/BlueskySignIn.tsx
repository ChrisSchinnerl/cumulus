import { useState } from "react";
import { useAtprotoStore } from "../../stores/atproto";
import { DevNote } from "../DevNote";

/**
 * Sign-in screen for Bluesky/atproto. Prompts for a handle and kicks off
 * the OAuth redirect flow. Rendered after the Sia auth flow completes but
 * before any atproto session exists.
 */
export function BlueskySignIn() {
  const signIn = useAtprotoStore((s) => s.signIn);
  const [handle, setHandle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    if (!handle.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await signIn(handle.trim());
      // signInRedirect navigates the page — never reached on success.
    } catch (e) {
      setLoading(false);
      setError(e instanceof Error ? e.message : "Sign-in failed");
    }
  }

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold text-neutral-900">
            Connect Bluesky
          </h1>
          <p className="text-neutral-600 text-sm">
            Sign in with your atproto handle so your shared files appear in your
            friends&apos; feeds.
          </p>
        </div>

        <DevNote title="Loopback OAuth">
          <p>
            This app runs as a loopback OAuth client — no client metadata is
            hosted, and refresh tokens are short-lived (typically 1 day). The
            library auto-redirects from{" "}
            <code className="text-amber-700">localhost</code> to{" "}
            <code className="text-amber-700">127.0.0.1</code> so the OAuth
            origin matches.
          </p>
        </DevNote>

        {error && (
          <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSignIn();
            }}
            placeholder="alice.bsky.social"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full px-4 py-3 bg-white border border-neutral-300 rounded-lg text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
          />

          <button
            type="button"
            onClick={handleSignIn}
            disabled={loading || !handle.trim()}
            className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white font-medium rounded-lg transition-colors"
          >
            {loading ? "Redirecting..." : "Sign in with Bluesky"}
          </button>
        </div>
      </div>
    </div>
  );
}
