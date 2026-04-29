import type { Sdk } from '@siafoundation/sia-storage'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { APP_KEY } from '../lib/constants'

export type AuthStep =
  | 'loading'
  | 'connect'
  | 'approve'
  | 'recovery'
  | 'connected'

type AuthState = {
  sdk: Sdk | null
  storedKeyHex: string | null
  indexerUrl: string
  step: AuthStep
  error: string | null
  approvalUrl: string | null
  setSdk: (sdk: Sdk) => void
  setStep: (step: AuthStep) => void
  setError: (error: string | null) => void
  setStoredKeyHex: (hex: string) => void
  setIndexerUrl: (url: string) => void
  setApprovalUrl: (url: string | null) => void
  reset: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      sdk: null,
      storedKeyHex: null,
      indexerUrl: '',
      step: 'loading',
      error: null,
      approvalUrl: null,
      setSdk: (sdk) => set({ sdk, step: 'connected', error: null }),
      setStep: (step) => set({ step, error: null }),
      setError: (error) => set({ error }),
      setStoredKeyHex: (hex) => set({ storedKeyHex: hex }),
      setIndexerUrl: (url) => set({ indexerUrl: url }),
      setApprovalUrl: (url) => set({ approvalUrl: url }),
      reset: () =>
        set({
          sdk: null,
          storedKeyHex: null,
          step: 'loading',
          error: null,
          approvalUrl: null,
        }),
    }),
    {
      name: `sia-auth-${APP_KEY.slice(0, 16)}`,
      partialize: (state) => ({
        storedKeyHex: state.storedKeyHex,
        indexerUrl: state.indexerUrl,
      }),
    },
  ),
)
