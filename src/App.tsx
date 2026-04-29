import { useEffect, useState } from 'react'
import { AuthFlow } from './components/auth/AuthFlow'
import { BlueskySignIn } from './components/auth/BlueskySignIn'
import { LoadingScreen } from './components/auth/LoadingScreen'
import { Feed } from './components/feed/Feed'
import { Navbar } from './components/Navbar'
import { Toasts } from './components/Toast'
import { UploadZone } from './components/upload/UploadZone'
import { useAtprotoStore } from './stores/atproto'
import { useAuthStore } from './stores/auth'

/**
 * Root component. Gates the main app UI on having both a Sia SDK session
 * and a Bluesky/atproto session. The atproto store self-hydrates on mount
 * (restoring an existing session or processing an OAuth callback).
 */
export default function App() {
  const siaStep = useAuthStore((s) => s.step)
  const atprotoInit = useAtprotoStore((s) => s.init)
  const atprotoInitialized = useAtprotoStore((s) => s.initialized)
  const atprotoSession = useAtprotoStore((s) => s.session)
  const [feedKey, setFeedKey] = useState(0)

  useEffect(() => {
    atprotoInit()
  }, [atprotoInit])

  let body: React.ReactNode
  if (siaStep !== 'connected') {
    body = <AuthFlow />
  } else if (!atprotoInitialized) {
    body = <LoadingScreen />
  } else if (!atprotoSession) {
    body = <BlueskySignIn />
  } else {
    body = (
      <div className="flex-1 p-6 max-w-3xl mx-auto w-full space-y-6">
        <UploadZone onUploaded={() => setFeedKey((k) => k + 1)} />
        <Feed key={feedKey} />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <div className="flex-1 flex flex-col">{body}</div>
      <Toasts />
    </div>
  )
}
