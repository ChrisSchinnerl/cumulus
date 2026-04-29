import { APP_NAME } from "../lib/constants";
import { useAtprotoStore } from "../stores/atproto";
import { useAuthStore } from "../stores/auth";

/**
 * Top app bar. Shows the Bluesky handle/avatar (when fully connected) and a
 * single sign-out button that clears both the Sia and atproto sessions.
 */
export function Navbar() {
  const siaStep = useAuthStore((s) => s.step);
  const resetSia = useAuthStore((s) => s.reset);
  const handle = useAtprotoStore((s) => s.handle);
  const avatar = useAtprotoStore((s) => s.avatar);
  const session = useAtprotoStore((s) => s.session);
  const atprotoSignOut = useAtprotoStore((s) => s.signOut);
  const isConnected = siaStep === "connected" && session !== null;

  async function handleSignOut() {
    await atprotoSignOut();
    resetSia();
    window.location.reload();
  }

  return (
    <header className="border-b border-neutral-200/80">
      <div className="flex items-center justify-between px-6 py-3 max-w-5xl mx-auto">
        <h1 className="text-sm font-semibold text-neutral-900 tracking-tight">
          {APP_NAME}
        </h1>
        {isConnected && (
          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-600" />
            </span>
            {avatar && (
              <img
                src={avatar}
                alt=""
                className="w-6 h-6 rounded-full bg-neutral-200"
              />
            )}
            {handle && (
              <a
                href={`https://bsky.app/profile/${handle}`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs text-neutral-700 hover:text-neutral-900 hover:underline transition-colors"
              >
                @{handle}
              </a>
            )}
            <button
              type="button"
              onClick={handleSignOut}
              className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors ml-1"
            >
              Sign Out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
