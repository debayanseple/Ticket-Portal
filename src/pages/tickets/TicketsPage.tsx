import { useCallback, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle, ChevronLeft, ChevronRight, Plus, Printer, Search, X } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { supabase } from '../../lib/supabase'
import type { Ticket } from '../../types'

const PAGE_SIZE = 20
type Sort = 'created_desc' | 'created_asc' | 'level_desc' | 'ticket_asc'
type TicketRow = Ticket & {
  branches: { name: string; code: string } | null
  devices: { serial_number: string } | null
  si_user: { name: string; email: string } | null
}
type BranchOption = { id: string; name: string; code: string }
type SiOption = { id: string; name: string; email: string }
type TicketFilterOptions = { branches: BranchOption[]; device_types: string[]; si_users: SiOption[] }
type DeviceOption = { id: string; type: string; serial_number: string }
type CreatedTicket = { ticket_id: string; ticket_number: string }

export default function TicketsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [createBranchId, setCreateBranchId] = useState('')
  const [createDeviceSerial, setCreateDeviceSerial] = useState('')
  const [createNote, setCreateNote] = useState('')
  const [printedAt, setPrintedAt] = useState('')
  const [createdTicket, setCreatedTicket] = useState<CreatedTicket | null>(null)
  const filter = searchParams.get('filter') || 'all'
  const status = searchParams.get('status') || ''
  const level = searchParams.get('level') || ''
  const branch = searchParams.get('branch') || ''
  const device = searchParams.get('device') || ''
  const deviceType = searchParams.get('device_type') || ''
  const siUserId = searchParams.get('si_user_id') || ''
  const from = searchParams.get('from') || ''
  const to = searchParams.get('to') || ''
  const search = searchParams.get('search') || ''
  const sort = (searchParams.get('sort') || 'created_desc') as Sort
  const page = Math.max(1, Number(searchParams.get('page')) || 1)

  const updateParam = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key !== 'page') next.set('page', '1')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  const filterOptionsQuery = useQuery({
    queryKey: ['ticketFilterOptions'],
    queryFn: async () => {
      return apiFetch<TicketFilterOptions>('/ticket-filters')
    },
  })

  const createDevicesQuery = useQuery({
    queryKey: ['ticketCreateDevices', createBranchId],
    enabled: Boolean(createBranchId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('devices')
        .select('id, type, serial_number')
        .eq('branch_id', createBranchId)
        .order('serial_number')
      if (error) throw error
      return (data ?? []) as DeviceOption[]
    },
  })

  const createTicket = useMutation({
    mutationFn: async () => {
      const deviceId = createDevicesQuery.data?.find((item) => item.serial_number === createDeviceSerial)?.id ?? null
      const { data } = await apiFetch<{ data: { id: string; ticket_number: string } }>('/tickets', {
        method: 'POST',
        body: JSON.stringify({
          branch_id: createBranchId,
          device_id: deviceId,
          note: createNote.trim(),
        }),
      })
      return { ticket_id: data.id, ticket_number: data.ticket_number } as CreatedTicket
    },
    onSuccess: async (ticket) => {
      setCreatedTicket(ticket)
      setCreateOpen(false)
      setCreateBranchId('')
      setCreateDeviceSerial('')
      setCreateNote('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tickets'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboardStats'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboardBreakdown'] }),
      ])
    },
  })

  const submitCreateTicket = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCreatedTicket(null)
    createTicket.mutate()
  }

  const ticketsQuery = useQuery({
    queryKey: ['tickets', filter, status, level, branch, device, deviceType, siUserId, from, to, search, sort, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })

      if (filter === 'open' || filter === 'today_open' || filter === 'escalated') params.set('status', 'open')
      if (filter === 'resolved' || filter === 'today_resolved') params.set('status', 'resolved')
      if (filter === 'escalated') params.set('escalated', 'true')
      if (filter === 'today_open' || filter === 'today_resolved') {
        const { start, next } = kolkataDayBounds(kolkataToday())
        if (filter === 'today_open') {
          params.set('from', start)
          params.set('to', next)
        } else {
          params.set('resolved_from', start)
          params.set('resolved_to', next)
        }
      }
      if (status) params.set('status', status)
      if (level) params.set('escalation_level', level)
      if (branch) params.set('branch_id', branch)
      if (device.trim()) params.set('device_serial', device.trim())
      if (deviceType) params.set('device_type', deviceType)
      if (siUserId) params.set('si_user_id', siUserId)
      if (from) params.set('from', kolkataDayBounds(from).start)
      if (to) params.set('to', kolkataDayBounds(to).next)
      if (search.trim()) params.set('search', search.trim())

      if (sort === 'created_asc') {
        params.set('sort', 'created_at')
        params.set('order', 'asc')
      } else if (sort === 'level_desc') {
        params.set('sort', 'escalation_level')
        params.set('order', 'desc')
      } else if (sort === 'ticket_asc') {
        params.set('sort', 'ticket_number')
        params.set('order', 'asc')
      } else {
        params.set('sort', 'created_at')
        params.set('order', 'desc')
      }

      return apiFetch<{ data: TicketRow[]; total: number }>(`/tickets?${params.toString()}`)
    },
  })

  const tickets = ticketsQuery.data?.data ?? []
  const total = ticketsQuery.data?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const setPage = (nextPage: number) => updateParam('page', String(nextPage))
  const selectedBranch = filterOptionsQuery.data?.branches.find((item) => item.id === branch)
  const selectedSi = filterOptionsQuery.data?.si_users.find((item) => item.id === siUserId)
  const printContext = [
    status ? `Status: ${status}` : '',
    level ? `Escalation: ${level}` : '',
    selectedBranch ? `Branch: ${selectedBranch.name} (${selectedBranch.code})` : '',
    deviceType ? `Device: ${deviceType}` : '',
    selectedSi ? `SI: ${selectedSi.name}` : '',
    from ? `Created from: ${from}` : '',
    to ? `Created through: ${to}` : '',
    search ? `Search: ${search}` : '',
  ].filter(Boolean).join(' · ') || 'All tickets'

  if (ticketsQuery.isLoading) return <p className="p-4" role="status">Loading tickets…</p>
  if (ticketsQuery.error) return (
    <div className="space-y-3 rounded-lg border-l-4 border-[var(--border)] border-l-[var(--danger)] bg-[var(--danger-bg)] p-4" role="alert">
      <p className="text-[var(--danger)]">Could not load tickets: {ticketsQuery.error.message}</p>
      <button onClick={() => void ticketsQuery.refetch()} className="rounded border border-[var(--border)] px-3 py-2 text-sm">Try again</button>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Tickets</h2>
          <p className="text-sm text-[var(--text-muted)]">{total} ticket{total === 1 ? '' : 's'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-label="Ticket actions and presets">
          <button type="button" onClick={() => { setPrintedAt(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })); window.setTimeout(() => window.print(), 0) }} className="no-print inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--row-hover)]">
            <Printer className="h-4 w-4" aria-hidden="true" /> Print / Save PDF
          </button>
          <button
            type="button"
            onClick={() => {
              createTicket.reset()
              setCreatedTicket(null)
              setCreateOpen(true)
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent-contrast)] transition hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> New ticket
          </button>
        </div>
      </div>
      <p className="print-meta">SDesk360 tickets · {printContext} · Generated {printedAt || 'at print time'} (Asia/Kolkata)</p>

      {createdTicket && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-l-4 border-[var(--border)] border-l-[var(--success)] bg-[var(--success-bg)] p-4 text-sm text-[var(--success)]" role="status">
          <span className="inline-flex items-center gap-2"><CheckCircle className="h-4 w-4" />Ticket {createdTicket.ticket_number} created.</span>
          <button type="button" onClick={() => navigate(`/tickets/${createdTicket.ticket_id}`)} className="font-semibold underline underline-offset-2">View ticket</button>
        </div>
      )}

      {createOpen && (
        <section className="no-print rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5" aria-labelledby="create-ticket-title">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 id="create-ticket-title" className="text-lg font-semibold">Create a ticket</h3>
              <p className="mt-1 text-sm text-[var(--text-muted)]">Choose a branch and describe the issue. You can optionally attach a device.</p>
            </div>
            <button type="button" aria-label="Close ticket form" onClick={() => { setCreateOpen(false); createTicket.reset() }} className="rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--row-hover)] hover:text-[var(--text-primary)]">
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={submitCreateTicket} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block text-sm font-medium text-[var(--text-primary)]">
                Branch <span className="text-[var(--danger)]">*</span>
                <select required value={createBranchId} onChange={(event) => { setCreateBranchId(event.target.value); setCreateDeviceSerial('') }} className="mt-1.5 block w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text-primary)]">
                <option value="">{filterOptionsQuery.isLoading ? 'Loading branches…' : 'Select a branch'}</option>
                  {(filterOptionsQuery.data?.branches ?? []).map((item) => <option key={item.id} value={item.id}>{item.name} ({item.code})</option>)}
                </select>
                {filterOptionsQuery.error && <span className="mt-1 block text-xs text-[var(--danger)]">Could not load branches: {filterOptionsQuery.error.message}</span>}
                {!filterOptionsQuery.isLoading && filterOptionsQuery.data?.branches.length === 0 && <span className="mt-1 block text-xs text-[var(--text-muted)]">No branches are available in your account scope.</span>}
              </label>

              <label className="block text-sm font-medium text-[var(--text-primary)]">
                Device <span className="font-normal text-[var(--text-muted)]">(optional)</span>
                <select value={createDeviceSerial} onChange={(event) => setCreateDeviceSerial(event.target.value)} disabled={!createBranchId || createDevicesQuery.isLoading} className="mt-1.5 block w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60">
                  <option value="">{!createBranchId ? 'Select a branch first' : createDevicesQuery.isLoading ? 'Loading devices…' : 'No specific device'}</option>
                  {(createDevicesQuery.data ?? []).map((item) => <option key={item.id} value={item.serial_number}>{item.type} · {item.serial_number}</option>)}
                </select>
                {createDevicesQuery.error && <span className="mt-1 block text-xs text-[var(--danger)]">Could not load devices: {createDevicesQuery.error.message}</span>}
              </label>
            </div>

            <label className="block text-sm font-medium text-[var(--text-primary)]">
              Issue details <span className="text-[var(--danger)]">*</span>
              <textarea required value={createNote} onChange={(event) => setCreateNote(event.target.value)} rows={4} maxLength={2000} placeholder="Describe what happened and any steps already taken…" className="mt-1.5 block w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]" />
              <span className="mt-1 block text-right text-xs text-[var(--text-muted)]">{createNote.length}/2000</span>
            </label>

            {createTicket.error && <div role="alert" className="rounded-lg border-l-4 border-[var(--border)] border-l-[var(--danger)] bg-[var(--danger-bg)] p-3 text-sm text-[var(--danger)]">Could not create ticket: {createTicket.error.message}</div>}

            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => { setCreateOpen(false); createTicket.reset() }} className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--row-hover)]">Cancel</button>
              <button type="submit" disabled={createTicket.isPending || filterOptionsQuery.isLoading || !filterOptionsQuery.data?.branches.length} className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50">
                <Plus className="h-4 w-4" />{createTicket.isPending ? 'Creating…' : 'Create ticket'}
              </button>
            </div>
          </form>
        </section>
      )}

      <div className="no-print flex flex-wrap gap-2" aria-label="Ticket presets">
          {[
            ['all', 'All'], ['open', 'Open'], ['resolved', 'Resolved'], ['escalated', 'Escalated'],
            ['today_open', "Today's open"], ['today_resolved', "Today's resolved"],
          ].map(([value, label]) => (
            <button key={value} onClick={() => updateParam('filter', value === 'all' ? '' : value)}
              aria-pressed={filter === value}
              className={`rounded border px-3 py-1.5 text-sm ${filter === value ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]' : 'border-[var(--border)]'}`}>
              {label}
            </button>
          ))}
      </div>

      <section className="no-print grid grid-cols-1 gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Ticket filters">
        <label className="text-xs text-[var(--text-muted)]">Status
          <select value={status} onChange={(event) => updateParam('status', event.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)]">
            <option value="">Any status</option><option value="open">Open</option><option value="resolved">Resolved</option>
          </select>
        </label>
        <label className="text-xs text-[var(--text-muted)]">Escalation level
          <select value={level} onChange={(event) => updateParam('level', event.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)]">
            <option value="">Any level</option><option value="0">Not escalated</option><option value="1">Level 1</option><option value="2">Level 2</option><option value="3">Level 3</option>
          </select>
        </label>
        <label className="text-xs text-[var(--text-muted)]">Branch
          <select value={branch} onChange={(event) => updateParam('branch', event.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)]">
            <option value="">All visible branches</option>
            {(filterOptionsQuery.data?.branches ?? []).map((item) => <option key={item.id} value={item.id}>{item.name} ({item.code})</option>)}
          </select>
        </label>
        <label className="text-xs text-[var(--text-muted)]">Device serial
          <input value={device} onChange={(event) => updateParam('device', event.target.value)} placeholder="Search serial number" className="mt-1 block w-full rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-primary)]" />
        </label>
        <label className="text-xs text-[var(--text-muted)]">Device category
          <select value={deviceType} onChange={(event) => updateParam('device_type', event.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)]">
            <option value="">All categories</option>
            {(filterOptionsQuery.data?.device_types ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="text-xs text-[var(--text-muted)]">Assigned SI
          <select value={siUserId} onChange={(event) => updateParam('si_user_id', event.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)]">
            <option value="">All SIs</option>
            {(filterOptionsQuery.data?.si_users ?? []).map((item) => <option key={item.id} value={item.id}>{item.name || item.email}</option>)}
          </select>
        </label>
        <label className="text-xs text-[var(--text-muted)]">Created from
          <input type="date" value={from} onChange={(event) => updateParam('from', event.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-primary)]" />
        </label>
        <label className="text-xs text-[var(--text-muted)]">Created through
          <input type="date" value={to} onChange={(event) => updateParam('to', event.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-primary)]" />
        </label>
        <label className="text-xs text-[var(--text-muted)]">Sort by
          <select value={sort} onChange={(event) => updateParam('sort', event.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)]">
            <option value="created_desc">Newest first</option><option value="created_asc">Oldest first</option><option value="level_desc">Highest escalation</option><option value="ticket_asc">Ticket number</option>
          </select>
        </label>
        <label className="text-xs text-[var(--text-muted)]">Search ticket number
          <span className="mt-1 flex items-center rounded border border-[var(--border)] px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            <input value={search} onChange={(event) => updateParam('search', event.target.value)} placeholder="e.g. SW-000123" className="min-w-0 flex-1 py-2 text-sm text-[var(--text-primary)] outline-none" />
          </span>
        </label>
        <div className="flex items-end">
          <button onClick={() => setSearchParams(new URLSearchParams())} className="w-full rounded border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--background)]">Clear filters</button>
        </div>
      </section>

      <div className="overflow-x-auto rounded-2xl border border-[var(--border)]">
        <table className="w-full min-w-[850px] border-collapse text-left text-sm">
          <thead><tr className="border-b border-[var(--border)] bg-[var(--background)] text-[var(--text-muted)]">
            <th className="px-4 py-3 font-medium">Ticket</th><th className="px-4 py-3 font-medium">Branch / Device</th><th className="px-4 py-3 font-medium">Assigned SI</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Escalation</th><th className="px-4 py-3 font-medium">Created</th><th className="px-4 py-3 font-medium">Age</th>
          </tr></thead>
          <tbody>
            {tickets.map((ticket) => (
              <tr key={ticket.id} role="link" aria-label={`Open ticket ${ticket.ticket_number}`} tabIndex={0} onClick={() => navigate(`/tickets/${ticket.id}`)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(`/tickets/${ticket.id}`) } }} className="cursor-pointer border-b border-[var(--border)]/60 hover:bg-[var(--row-hover)] focus:bg-[var(--background)]">
                <td className="px-4 py-3 font-semibold">{ticket.ticket_number}</td>
                <td className="px-4 py-3"><div className="font-medium">{ticket.branches?.name ?? '—'}</div><div className="text-xs text-[var(--text-muted)]">{ticket.devices?.serial_number ?? '—'}</div></td>
                <td className="px-4 py-3">{ticket.si_user?.name ?? ticket.si_user?.email ?? '—'}</td>
                <td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-xs font-medium ${ticket.status === 'open' ? 'bg-[var(--danger-bg)] text-[var(--danger)]' : 'bg-[var(--success-bg)] text-[var(--success)]'}`}>{ticket.status === 'open' ? 'Open' : 'Resolved'}</span></td>
                <td className="px-4 py-3">{ticket.escalation_level ? <span className={`rounded-full px-2 py-1 text-xs font-medium ${ticket.escalation_level === 1 ? 'bg-[var(--danger-bg)] text-[var(--danger)]' : ticket.escalation_level === 2 ? 'bg-[var(--danger-bg)] text-[var(--danger)]' : 'bg-[var(--danger-bg)] text-[var(--danger)]'}`}>Level {ticket.escalation_level}</span> : <span className="text-[var(--text-muted)]">Not escalated</span>}</td>
                <td className="whitespace-nowrap px-4 py-3">{new Date(ticket.created_at).toLocaleString()}</td>
                <td className="whitespace-nowrap px-4 py-3 text-[var(--text-muted)]">{ticketAge(ticket.created_at, ticket.status === 'resolved' ? ticket.resolved_at : null)}</td>
              </tr>
            ))}
            {tickets.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-[var(--text-muted)]">No tickets match these filters.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="no-print flex items-center justify-between text-sm text-[var(--text-muted)]">
        <span>{total === 0 ? 'No results' : `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`}</span>
        <div className="flex items-center gap-2">
          <span>Page {totalPages ? Math.min(page, totalPages) : 0} of {totalPages}</span>
          <button aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-[var(--border)] p-2 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
          <button aria-label="Next page" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded border border-[var(--border)] p-2 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  )
}

function kolkataToday(): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function kolkataDayBounds(day: string): { start: string; next: string } {
  const [year, month, date] = day.split('-').map(Number)
  const offsetMinutes = 330
  return {
    start: new Date(Date.UTC(year, month - 1, date) - offsetMinutes * 60_000).toISOString(),
    next: new Date(Date.UTC(year, month - 1, date + 1) - offsetMinutes * 60_000).toISOString(),
  }
}

function ticketAge(createdAt: string, resolvedAt: string | null | undefined): string {
  const elapsedMs = Math.max(0, new Date(resolvedAt ?? Date.now()).getTime() - new Date(createdAt).getTime())
  const hours = Math.floor(elapsedMs / 3_600_000)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`
}
