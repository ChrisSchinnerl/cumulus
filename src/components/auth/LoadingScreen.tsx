export function LoadingScreen({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4">
      <div className="w-8 h-8 border-2 border-neutral-300 border-t-green-600 rounded-full animate-spin" />
      <p className="text-neutral-500 text-sm">{message || 'Initializing...'}</p>
    </div>
  )
}
