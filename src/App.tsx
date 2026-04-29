import { AuthFlow } from './components/auth/AuthFlow'
import { Navbar } from './components/Navbar'
import { Toasts } from './components/Toast'
import { UploadZone } from './components/upload/UploadZone'
import { useAuthStore } from './stores/auth'

export default function App() {
  const step = useAuthStore((s) => s.step)

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <div className="flex-1 flex flex-col">
        {step === 'connected' ? <UploadZone /> : <AuthFlow />}
      </div>
      <Toasts />
    </div>
  )
}
