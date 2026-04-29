import type { ReactNode } from 'react'

export function DevNote({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="border-l-4 border-amber-500 bg-amber-50 rounded-r-lg p-4 space-y-1">
      <p className="text-amber-700 text-xs font-semibold uppercase tracking-wider">
        Developer Note
      </p>
      <p className="text-amber-900 text-sm font-medium">{title}</p>
      <div className="text-amber-900/80 text-xs leading-relaxed">
        {children}
      </div>
    </div>
  )
}
