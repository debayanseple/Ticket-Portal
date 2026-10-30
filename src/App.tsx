import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/layout/Layout'
import LoginPage from './pages/auth/LoginPage'
import DashboardPage from './pages/dashboard/DashboardPage'
import TicketsPage from './pages/tickets/TicketsPage'
import TicketDetailPage from './pages/tickets/TicketDetailPage'
import DevicesPage from './pages/devices/DevicesPage'
import AssignSiPage from './pages/assign-si/AssignSiPage'
import UsersPage from './pages/users/UsersPage'
import { ProtectedRoute, RoleRoute } from './components/route-guards/ProtectedRoute'
import { isSupabaseConfigured } from './lib/supabase'
import ThemeToggle from './components/theme/ThemeToggle'

function App() {
  if (!isSupabaseConfigured) {
    return (
      <main className="relative flex min-h-screen items-center justify-center bg-[var(--background)] p-6">
        <div className="absolute right-5 top-5">
          <ThemeToggle compact />
        </div>
        <section className="w-full max-w-lg space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-[var(--accent)]">S-Watch 360 Desk</p>
          <h1 className="text-2xl font-bold">Connect your Supabase project</h1>
          <p className="text-sm leading-6 text-[var(--text-muted)]">
            The app is running, but its backend is not configured yet. Add your project URL and publishable key to a local <code className="rounded bg-[var(--background)] px-1 py-0.5">.env</code> file to load the sign-in page and dashboard.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-[var(--background)] p-4 text-sm"><code>VITE_SUPABASE_URL=https://your-project.supabase.co{'\n'}VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key</code></pre>
          <p className="text-xs text-[var(--text-muted)]">Copy these values from your Supabase project API settings. Restart the dev server after updating the environment file.</p>
        </section>
      </main>
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="tickets" element={<TicketsPage />} />
            <Route path="tickets/:ticketId" element={<TicketDetailPage />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="assign-si">
              <Route index element={<RoleRoute roles={['head_office']}><AssignSiPage /></RoleRoute>} />
            </Route>
            <Route path="insights" element={<Navigate to="/" replace />} />
            <Route path="users" element={<RoleRoute roles={['head_office']}><UsersPage /></RoleRoute>} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
