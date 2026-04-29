import { useToastStore } from '../stores/toast'

export function CopyButton({
  value,
  label = 'Copied to clipboard',
}: {
  value: string
  label?: string
}) {
  const addToast = useToastStore((s) => s.addToast)

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value)
        addToast(label)
      }}
      className="p-1 text-neutral-400 hover:text-neutral-700 transition-colors"
      title="Copy"
    >
      <svg
        className="w-3.5 h-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
      </svg>
    </button>
  )
}
