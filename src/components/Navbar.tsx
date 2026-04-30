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
              <>
                <a
                  href={`#/profile/${encodeURIComponent(handle)}`}
                  className="text-xs text-neutral-700 hover:text-neutral-900 hover:underline transition-colors"
                >
                  @{handle}
                </a>
                <a
                  href={`https://bsky.app/profile/${handle}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`@${handle} on Bluesky`}
                  title={`@${handle} on Bluesky`}
                  className="text-neutral-400 hover:text-sky-500 transition-colors"
                >
                  <svg
                    viewBox="0 0 64 57"
                    className="w-4 h-4"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M13.873 3.805C21.21 9.332 29.103 20.537 32 26.55v15.882c0-.338-.13.044-.41.867-1.512 4.456-7.418 21.847-20.923 7.944-7.111-7.32-3.819-14.64 9.125-16.85-7.405 1.264-15.73-.825-18.014-9.015C1.12 23.022 0 8.51 0 6.55 0-3.268 8.579-.182 13.873 3.805ZM50.127 3.805C42.79 9.332 34.897 20.537 32 26.55v15.882c0-.338.13.044.41.867 1.512 4.456 7.418 21.847 20.923 7.944 7.111-7.32 3.819-14.64-9.125-16.85 7.405 1.264 15.73-.825 18.014-9.015C62.88 23.022 64 8.51 64 6.55 64-3.268 55.421-.182 50.127 3.805Z" />
                  </svg>
                </a>
              </>
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
