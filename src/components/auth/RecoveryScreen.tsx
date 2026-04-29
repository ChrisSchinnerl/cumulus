import {
  type Builder,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
} from '@siafoundation/sia-storage'
import { useState } from 'react'
import { useAuthStore } from '../../stores/auth'
import { CopyButton } from '../CopyButton'
import { DevNote } from '../DevNote'

export function RecoveryScreen({
  builder,
}: {
  builder: React.RefObject<Builder | null>
}) {
  const { setSdk, setStoredKeyHex, setError } = useAuthStore()
  const [mode, setMode] = useState<'choose' | 'generate' | 'import'>('choose')
  const [phrase, setPhrase] = useState('')
  const [generatedPhrase, setGeneratedPhrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [phraseError, setPhraseError] = useState<string | null>(null)

  function handleGenerate() {
    const mnemonic = generateRecoveryPhrase()
    setGeneratedPhrase(mnemonic)
    setPhrase(mnemonic)
    setMode('generate')
  }

  function handleValidatePhrase(value: string) {
    setPhrase(value)
    setPhraseError(null)
    if (value.trim()) {
      try {
        validateRecoveryPhrase(value.trim())
      } catch {
        setPhraseError('Invalid recovery phrase')
      }
    }
  }

  async function handleRegister() {
    const b = builder.current
    if (!b) {
      setError('No builder instance')
      return
    }

    const mnemonic = phrase.trim()
    try {
      validateRecoveryPhrase(mnemonic)
    } catch {
      setPhraseError('Invalid recovery phrase')
      return
    }

    setLoading(true)
    try {
      const sdk = await b.register(mnemonic)
      setStoredKeyHex(sdk.appKey().export().toHex())
      setSdk(sdk)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  if (mode === 'choose') {
    return (
      <div className="flex flex-col items-center justify-center flex-1 px-4">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-semibold text-neutral-900">
              Recovery Phrase
            </h1>
            <p className="text-neutral-600 text-sm">
              Generate a new recovery phrase or enter an existing one.
            </p>
          </div>

          <DevNote title="Recovery Phrases & Key Derivation">
            <p>
              The 12-word BIP-39 recovery phrase deterministically derives the
              user&apos;s cryptographic keys. The same phrase always produces
              the same keys, enabling account recovery. The derived app key is
              exported and stored in localStorage (via Zustand persist) so users
              don&apos;t need to re-enter it.
            </p>
          </DevNote>

          <div className="space-y-3">
            <button
              type="button"
              onClick={handleGenerate}
              className="w-full py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors"
            >
              Generate New Phrase
            </button>
            <button
              type="button"
              onClick={() => setMode('import')}
              className="w-full py-3 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 font-medium rounded-lg transition-colors"
            >
              Enter Existing Phrase
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold text-neutral-900">
            {mode === 'generate'
              ? 'Save Your Recovery Phrase'
              : 'Enter Recovery Phrase'}
          </h1>
          <p className="text-neutral-600 text-sm">
            {mode === 'generate'
              ? 'Write down these 12 words in order. You will need them to recover your account.'
              : 'Enter your 12-word recovery phrase.'}
          </p>
        </div>

        {mode === 'generate' ? (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2 p-4 bg-white rounded-lg border border-neutral-300">
              {generatedPhrase.split(' ').map((word, i) => (
                <div
                  key={`${word}-${i}`}
                  className="text-center py-2 bg-neutral-100 rounded text-sm"
                >
                  <span className="text-neutral-400 mr-1">{i + 1}.</span>
                  <span className="text-neutral-900">{word}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <CopyButton
                value={generatedPhrase}
                label="Recovery phrase copied"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={phrase}
              onChange={(e) => handleValidatePhrase(e.target.value)}
              placeholder="Enter your 12-word recovery phrase..."
              rows={3}
              className="w-full px-4 py-3 bg-white border border-neutral-300 rounded-lg text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
            />
            {phraseError && (
              <p className="text-red-600 text-sm">{phraseError}</p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={handleRegister}
          disabled={loading || !phrase.trim()}
          className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white font-medium rounded-lg transition-colors"
        >
          {loading ? 'Registering...' : 'Complete Setup'}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode('choose')
            setPhrase('')
            setGeneratedPhrase('')
            setPhraseError(null)
          }}
          className="w-full py-2 text-neutral-500 hover:text-neutral-900 text-sm transition-colors"
        >
          Back
        </button>
      </div>
    </div>
  )
}
