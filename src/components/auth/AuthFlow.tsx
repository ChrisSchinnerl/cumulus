import { AppKey, Builder, initSia } from '@siafoundation/sia-storage'
import { useEffect, useRef } from 'react'
import { APP_META } from '../../lib/constants'
import { useAuthStore } from '../../stores/auth'
import { ApproveScreen } from './ApproveScreen'
import { ConnectScreen } from './ConnectScreen'
import { LoadingScreen } from './LoadingScreen'
import { RecoveryScreen } from './RecoveryScreen'

export function AuthFlow() {
  const step = useAuthStore((s) => s.step)
  const error = useAuthStore((s) => s.error)
  const setError = useAuthStore((s) => s.setError)
  const builderRef = useRef<Builder | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      const { storedKeyHex, indexerUrl, setSdk, setStep } =
        useAuthStore.getState()
      try {
        await initSia()

        if (storedKeyHex && indexerUrl) {
          const appKey = new AppKey(Uint8Array.fromHex(storedKeyHex))
          const builder = new Builder(indexerUrl, APP_META)
          const sdk = await builder.connected(appKey)

          if (cancelled) return
          if (sdk) {
            setSdk(sdk)
            return
          }
        }

        if (!cancelled) {
          setStep('connect')
        }
      } catch (e) {
        if (!cancelled) {
          console.error('Init error:', e)
          setStep('connect')
        }
      }
    }

    init()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex-1 flex flex-col">
      {error && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm max-w-md text-center shadow-sm">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 text-red-600 hover:text-red-900"
          >
            Dismiss
          </button>
        </div>
      )}

      {step === 'loading' && <LoadingScreen />}
      {step === 'connect' && <ConnectScreen builder={builderRef} />}
      {step === 'approve' && <ApproveScreen builder={builderRef} />}
      {step === 'recovery' && <RecoveryScreen builder={builderRef} />}
    </div>
  )
}
