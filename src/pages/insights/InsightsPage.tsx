import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle, Clock, Layers, Mail } from 'lucide-react'
import { supabase } from '../../lib/supabase'

// Ticket analytics, scoped by RLS like every other page: each signed-in user
// only sees their own scope's tickets and branch names. All figures are
// computed client-side from one tickets fetch (the ticket lifecycle is the record).

type TicketRow = {
  id: string
  status: 'open' | 'resolved'
  escalation_level: number
  created_at: string
  resolved_at: string | null
  branches: { id: string; name: string; code: string } | null
  devices: { id: string; type: string; serial_number: string } | null
}

const DAY_WINDOW = 14

async function fetchAnalyticsTickets(): Promise<TicketRow[]> {
  const { data, error } = await supabase
    .from('tickets')
    .select(
      `id, status, escalation_level, created_at, resolved_at,
       branches ( id, name, code ),
       devices ( id, type, serial_number )`,
    )
    .order('created_at')
    .limit(1000)
  if (error) throw error
  return (data ?? []) as unknown as TicketRow[]
}

export default function InsightsPage() {
  const navigate = useNavigate()

  const ticketsQuery = useQuery({
    queryKey: ['ticketAnalytics'],
    queryFn: fetchAnalyticsTickets,
  })

  if (ticketsQuery.isLoading) return <p className="p-4" role="status">Loading analytics…</p>
  if (ticketsQuery.error) return (
    <div className="space-y-3 rounded-lg border-l-4 border-[var(--border)] border-l-[var(--danger)] bg-[var(--danger-bg)] p-4" role="alert">
      <p className="text-[var(--danger)]">Could not load ticket analytics: {ticketsQuery.error.message}</p>
      <button onClick={() => void ticketsQuery.refetch()} className="rounded border border-[var(--border)] px-3 py-2 text-sm">Try again</button>
    </div>
  )

  const rows = ticketsQuery.data ?? []
  const open = rows.filter((row) => row.status === 'open')
  const resolvedRows = rows.filter((row) => row.status === 'resolved')
  const escalated = open.filter((row) => row.escalation_level > 0)
  const aged = open.filter((row) => Date.now() - new Date(row.created_at).getTime() > 24 * 3_600_000)
  const avgResolution = averageResolution(rows)

  const days = lastDays(DAY_WINDOW)
  const createdPerDay = countPerDay(rows, (row) => row.created_at, days)
  const resolvedPerDay = countPerDay(rows, (row) => row.resolved_at ?? '', days)

  const maxDaily = maxInRange(days, createdPerDay, resolvedPerDay)

  const typeMix = openTicketTypeMix(open)
  const escMix = escalationMix(open)
  const branchRows = branchPerformance(rows, navigate)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Insights</h2>
        <p className="text-sm text-[var(--text-muted)]">Ticket analytics for your scope · Asia/Kolkata days</p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" aria-label="Ticket KPIs">
        <Kpi icon={AlertTriangle} label="Open now" value={open.length} accent />
        <Kpi icon={CheckCircle} label="Resolved total" value={resolvedRows.length} />
        <Kpi icon={Mail} label="Escalated (open)" value={escalated.length} danger />
        <Kpi icon={Clock} label="Open over 24h" value={aged.length} danger={aged.length > 0} />
        <Kpi icon={Layers} label="Avg resolution" value={avgResolution} />
      </section>

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5" aria-label="Created vs resolved, last 14 days">
        <div className="mb-4 flex flex-wrap items-baseline gap-4">
          <h3 className="font-semibold">Created vs resolved · last {DAY_WINDOW} days</h3>
          <span className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--accent)]" aria-hidden="true" /> Created
            <span className="ml-3 inline-block h-2.5 w-2.5 rounded-sm bg-[var(--success)]" aria-hidden="true" /> Resolved
          </span>
        </div>
        {days.map((day) => {
          const created = createdPerDay.get(day) ?? 0
          const resolved = resolvedPerDay.get(day) ?? 0
          return (
            <div key={day} className="flex items-center gap-2 text-xs">
              <span className="w-16 shrink-0 text-[var(--text-muted)]">{day.slice(5)}</span>
              <div className="flex h-24 flex-1 items-start justify-start gap-1 border-l border-[var(--border)]" title={`${day}: ${created} created, ${resolved} resolved`}>
                <MeterHorizontal value={created} max={maxDaily} className="bg-[var(--accent)]" />
                <MeterHorizontal value={resolved} max={maxDaily} className="bg-[var(--success)]" />
              </div>
              <span className="w-6 text-right font-mono">{created + resolved}</span>
            </div>
          )
        })}
        {rows.length === 0 && <p className="mt-3 text-sm text-[var(--text-muted)]">No tickets in your scope yet.</p>}
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Open tickets by device type" isEmpty={rows.length === 0 || typeMix.length === 0} emptyText="No open tickets.">
          {typeMix.map((row) => (
            <BarRow key={row.label} label={row.label} value={row.value} max={open.length || 1} className="bg-[var(--accent)]" />
          ))}
        </Panel>

        <Panel title="Escalation mix of open tickets" isEmpty={rows.length === 0 || escMix.length === 0} emptyText="No open tickets.">
          {escMix.map((row) => (
            <BarRow key={row.label} label={row.label} value={row.value} max={open.length || 1} className={row.value > 0 ? 'bg-[var(--danger)]' : 'bg-[var(--row-hover)]'} />
          ))}
        </Panel>
      </div>

      <section className="overflow-x-auto rounded-2xl border border-[var(--border)]" aria-label="Branch performance">
        <table className="w-full min-w-[640px] border-collapse bg-[var(--surface)] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--background)] text-[var(--text-muted)]">
              <th className="px-4 py-3 font-medium">Branch</th>
              <th className="px-4 py-3 font-medium">Open</th>
              <th className="px-4 py-3 font-medium">Escalated</th>
              <th className="px-4 py-3 font-medium">Resolved</th>
              <th className="px-4 py-3 font-medium">Avg resolution</th>
            </tr>
          </thead>
          {rows.length > 0 && <tbody>{branchRows}</tbody>}
        </table>
        {rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-[var(--text-muted)]">No tickets in your scope yet.</p>}
      </section>
    </div>
  )
}

function Kpi({ icon: Icon, label, value, accent = false, danger = false }: {
  icon: typeof AlertTriangle
  label: string
  value: number | string
  accent?: boolean
  danger?: boolean
}) {
  const color = danger ? 'text-[var(--danger)]' : accent ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-2">
        <span className={`font-mono text-2xl font-bold leading-none ${color}`}>{value}</span>
        <Icon className={`h-4 w-4 ${accent || danger ? color : 'text-[var(--text-muted)]'}`} aria-hidden="true" />
      </div>
      <span className="mt-2 block text-xs text-[var(--text-muted)]">{label}</span>
    </div>
  )
}

function Panel({ title, isEmpty, emptyText, children }: {
  title: string
  isEmpty: boolean
  emptyText: string
  children: ReactNode
}) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <h3 className="mb-3 font-semibold">{title}</h3>
      {isEmpty ? <p className="text-sm text-[var(--text-muted)]">{emptyText}</p> : <div className="space-y-2.5">{children}</div>}
    </section>
  )
}

function BarRow({ label, value, max, className }: { label: string; value: number; max: number; className: string }) {
  return (
    <div className="grid grid-cols-[110px_1fr_28px] items-center gap-2 text-sm" aria-label={`${label}: ${value}`}>
      <span className="truncate text-[var(--text-muted)]">{label}</span>
      <TrackMeter value={value} max={max} className={className} />
      <span className="text-right font-mono text-xs">{value}</span>
    </div>
  )
}

function TrackMeter({ value, max, className }: { value: number; max: number; className: string }) {
  return (
    <span className="block h-2.5 rounded-full bg-[var(--row-hover)]">
      <span
        className={`block h-2.5 rounded-full ${className}`}
        style={{ width: `${Math.max(2, Math.round((value / max) * 100))}%` }}
      />
    </span>
  )
}

function MeterHorizontal({ value, max, className }: { value: number; max: number; className: string }) {
  return <span className={`inline-block h-3 rounded-sm ${className}`} style={{ width: `${Math.round((value / max) * 100) + 4}%`, minWidth: value > 0 ? 3 : 0 }} />
}

function maxInRange(days: string[], ...maps: Array<Map<string, number>>): number {
  let max = 1
  for (const map of maps) {
    for (const day of days) {
      max = Math.max(max, map.get(day) ?? 0)
    }
  }
  return max
}

function lastDays(count: number): string[] {
  const days: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    days.push(kolkataDayKey(new Date(Date.now() - offset * 86_400_000).toISOString()))
  }
  return days
}

function countPerDay(rows: TicketRow[], pick: (row: TicketRow) => string, days: string[]): Map<string, number> {
  const counts = new Map<string, number>(days.map((day) => [day, 0]))
  for (const row of rows) {
    const value = pick(row)
    if (!value) continue
    const day = kolkataDayKey(value)
    const existing = counts.get(day)
    if (existing !== undefined) counts.set(day, existing + 1)
  }
  return counts
}

// Asia/Kolkata day bucket, consistent with the rest of the app (Kolkata timezone).
function kolkataDayKey(iso: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function averageResolution(rows: TicketRow[]): string {
  const durations = rows
    .filter((row) => row.status === 'resolved' && row.resolved_at)
    .map((row) => new Date(row.resolved_at as string).getTime() - new Date(row.created_at).getTime())
  if (durations.length === 0) return '—'
  const avgHours = durations.reduce((sum, ms) => sum + Math.max(0, ms), 0) / durations.length / 3_600_000
  if (avgHours < 24) return `${Math.round(avgHours)}h`
  const days = Math.floor(avgHours / 24)
  const hours = Math.round(avgHours % 24)
  return hours ? `${days}d ${hours}h` : `${days}d`
}

function openTicketTypeMix(open: TicketRow[]): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>()
  for (const row of open) {
    const label = row.devices?.type ?? 'No device'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
}

function escalationMix(open: TicketRow[]): Array<{ label: string; value: number }> {
  const counts = [0, 0, 0, 0]
  for (const row of open) {
    counts[Math.min(3, Math.max(0, row.escalation_level))] += 1
  }
  return [
    { label: 'Not escalated', value: counts[0] },
    { label: 'Level 1', value: counts[1] },
    { label: 'Level 2', value: counts[2] },
    { label: 'Level 3', value: counts[3] },
  ]
}

function branchPerformance(rows: TicketRow[], navigate: (path: string) => void) {
  const groups = new Map<string, { id: string | null; name: string; code: string; open: number; escalated: number; resolved: number; durations: number[] }>()
  for (const row of rows) {
    const key = row.branches?.id ?? 'unknown'
    const group = groups.get(key) ?? {
      id: row.branches?.id ?? null,
      name: row.branches?.name ?? 'Unknown branch',
      code: row.branches?.code ?? '—',
      open: 0,
      escalated: 0,
      resolved: 0,
      durations: [],
    }
    if (row.status === 'open') {
      group.open += 1
      if (row.escalation_level > 0) group.escalated += 1
    } else if (row.resolved_at) {
      group.resolved += 1
      group.durations.push(Math.max(0, new Date(row.resolved_at).getTime() - new Date(row.created_at).getTime()))
    }
    groups.set(key, group)
  }

  return [...groups.values()]
    .sort((a, b) => b.open - a.open || b.resolved - a.resolved)
    .map((group) => (
      <tr
        key={group.id ?? 'unknown'}
        role="link"
        tabIndex={0}
        aria-label={`View tickets for ${group.name}`}
        onClick={() => navigate(group.id ? `/tickets?branch=${group.id}&status=open` : '/tickets')}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(group.id ? `/tickets?branch=${group.id}&status=open` : '/tickets') } }}
        className="cursor-pointer border-b border-[var(--border)]/50 hover:bg-[var(--row-hover)]"
      >
        <td className="px-4 py-3 font-medium">{group.name} <span className="text-xs text-[var(--text-muted)]">({group.code})</span></td>
        <td className="px-4 py-3">{group.open}</td>
        <td className="px-4 py-3">{group.escalated > 0 ? <span className="font-medium text-[var(--danger)]">{group.escalated}</span> : 0}</td>
        <td className="px-4 py-3">{group.resolved}</td>
        <td className="px-4 py-3 text-[var(--text-muted)]">{formatAvg(group.durations)}</td>
      </tr>
    ))
}

function formatAvg(durations: number[]): string {
  if (durations.length === 0) return '—'
  const avgHours = durations.reduce((sum, ms) => sum + ms, 0) / durations.length / 3_600_000
  if (avgHours < 24) return `${Math.round(avgHours)}h`
  const days = Math.floor(avgHours / 24)
  const hours = Math.round(avgHours % 24)
  return hours ? `${days}d ${hours}h` : `${days}d`
}
