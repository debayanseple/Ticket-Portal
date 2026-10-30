import { Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { LogOut, LayoutDashboard, FileText, HardDrive, ShieldAlert, Users } from 'lucide-react'
import ThemeToggle from '../theme/ThemeToggle'

const SIDEBAR_ITEMS = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/tickets', label: 'Tickets', icon: FileText },
  { path: '/devices', label: 'Devices', icon: HardDrive },
]

const HO_ONLY_ITEMS = [
  { path: '/assign-si', label: 'Assign SI', icon: ShieldAlert },
  { path: '/users', label: 'Users', icon: Users },
]

export default function Layout() {
  const { profile, signOut, loading } = useAuth()
  const location = useLocation()

  if (loading) return null

  const isActive = (path: string) => location.pathname === path || (path !== '/' && location.pathname.startsWith(path))

  const items =
    profile?.role === 'head_office' ? [...SIDEBAR_ITEMS, ...HO_ONLY_ITEMS] : SIDEBAR_ITEMS

  return (
    <div className="flex h-screen bg-[var(--background)]">
      <aside className="no-print w-64 border-r border-[var(--border)] bg-[var(--surface)] flex flex-col">
        <div className="p-6">
          <h1 className="text-xl font-bold tracking-tight">S-Watch 360</h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">{profile?.role.replace('_', ' ')}</p>
        </div>
        <nav className="p-4 space-y-1">
          {items.map((item) => (
            <a
              key={item.path}
              href={item.path}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm ${
                isActive(item.path)
                  ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--border)]'
              }`}
            >
              <item.icon className="w-5 h-5" />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto p-4 border-t border-[var(--border)]">
          <button
            onClick={signOut}            className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm text-[var(--danger)] hover:bg-[var(--border)]"
          >
            <LogOut className="w-5 h-5" /> Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto bg-[var(--background)] p-6">
        <header className="no-print mb-6 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold">{currentPageTitle(location.pathname)}</h2>
            <p className="text-sm text-[var(--text-muted)]">{profile?.email}</p>
          </div>
          <ThemeToggle />
        </header>
        <Outlet />
      </main>
    </div>
  )
}

function currentPageTitle(path: string): string {
  const match = [...SIDEBAR_ITEMS, ...HO_ONLY_ITEMS].find((i) => path === i.path || path.startsWith(i.path + '/'))
  return match ? match.label : 'Dashboard'
}
