import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle, Clock, Mail, MessageSquare } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { apiFetch } from '../../lib/api'
import { supabase } from '../../lib/supabase'
import type { TicketEvent } from '../../types'

type TicketDetail = {
  id: string
  ticket_number: string
  branch_id: string
  device_id: string | null
  si_user_id: string | null
  status: 'open' | 'resolved'
  escalation_level: number
  created_at: string
  updated_at: string
  resolved_at: string | null
  resolved_by: string | null
  resolution_note: string | null
  issue_description: string
  source_system: string | null
  source_event_id: string | null
  assigned_si_name: string | null
  assigned_si_email: string | null
  branches: { name: string; code: string; zones: { name: string; nbgs: { name: string } | null } | null } | null
  devices: { type: string; serial_number: string } | null
  si_user: { id: string; name: string; email: string } | null
  resolver: { name: string; email: string } | null
  current_si_assignment: { si_user_id: string; profiles: { id: string; name: string; email: string } | null } | null
  ticket_events: TimelineItem[]
  hms_events: HmsSourceEvent[]
  ticket_escalations: EscalationItem[]
  email_outbox: EmailItem[]
}
type TimelineItem = TicketEvent & { actor: { name: string; email: string } | null }
type EmailItem = { id: string; subject: string; status: string; sent_at: string | null; created_at: string; error: string | null }
type HmsSourceEvent = { id: string; source_event_id: string; event_type: string; correlation_event_id: string | null; issue_description: string | null; occurred_at: string | null; received_at: string; processing_status: string }
type EscalationItem = { id: string; escalation_level: number; due_at: string; processed_at: string; recipient: string | null; email_outcome: string }

export default function TicketDetailPage() {
  const { ticketId } = useParams()
  const { profile, loading: authLoading } = useAuth()
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const [actionError, setActionError] = useState('')

  const ticketQuery = useQuery({
    queryKey: ['ticket', ticketId],
    enabled: Boolean(ticketId) && !authLoading,
    queryFn: async () => {
      const { data } = await apiFetch<{ data: TicketDetail }>(`/tickets/${ticketId}`)
      return data
    },
  })

  const addNote = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('add_ticket_note', { p_ticket_id: ticketId!, p_note: note.trim() })
      if (error) throw error
    },
    onSuccess: async () => {
      setNote('')
      setActionError('')
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] })
    },
    onError: (error: Error) => setActionError(error.message),
  })
  const resolve = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('resolve_ticket', { p_ticket_id: ticketId!, p_note: note.trim() || null })
      if (error) throw error
    },
    onSuccess: async () => {
      setNote('')
      setActionError('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] }),
        queryClient.invalidateQueries({ queryKey: ['tickets'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboardStats'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboardBreakdown'] }),
      ])
    },
    onError: (error: Error) => setActionError(error.message),
  })

  if (authLoading || ticketQuery.isLoading) return <p className="p-4" role="status">Loading ticket…</p>
  if (ticketQuery.error || !ticketQuery.data) return <div className="space-y-3 rounded-lg border-l-4 border-[var(--border)] border-l-[var(--danger)] bg-[var(--danger-bg)] p-4" role="alert"><p className="text-[var(--danger)]">Could not load ticket: {ticketQuery.error?.message ?? 'Ticket not found.'}</p><button onClick={() => void ticketQuery.refetch()} className="rounded border border-[var(--border)] px-3 py-2 text-sm">Try again</button></div>

  const ticket = ticketQuery.data
  const canManage = ticket.status === 'open' && (profile?.role === 'head_office' || (profile?.role === 'si' && ticket.si_user_id === profile.id))
  const busy = addNote.isPending || resolve.isPending
  const items = [
    ...ticket.ticket_events.map((event) => ({ id: event.id, kind: 'event' as const, at: event.created_at, event })),
    ...ticket.email_outbox.map((email) => ({ id: email.id, kind: 'email' as const, at: email.sent_at ?? email.created_at, email })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link to="/tickets" className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)] hover:text-[var(--accent)]"><ArrowLeft className="h-4 w-4" />Back to tickets</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-sm text-[var(--text-muted)]">Ticket</p><h2 className="text-2xl font-bold">{ticket.ticket_number}</h2><p className="mt-1 text-sm text-[var(--text-muted)]">Created {formatDate(ticket.created_at)} · Age {ticketAge(ticket.created_at, ticket.status === 'resolved' ? ticket.resolved_at : null)}</p></div>
        <div className="flex flex-wrap gap-2"><span className={`rounded-full px-3 py-1 text-sm font-medium ${ticket.status === 'open' ? 'bg-[var(--danger-bg)] text-[var(--danger)]' : 'bg-[var(--success-bg)] text-[var(--success)]'}`}>{ticket.status === 'open' ? 'Open' : 'Resolved'}</span><span className={`rounded-full px-3 py-1 text-sm font-medium ${ticket.escalation_level === 3 ? 'bg-[var(--danger-bg)] text-[var(--danger)]' : ticket.escalation_level === 2 ? 'bg-[var(--danger-bg)] text-[var(--danger)]' : ticket.escalation_level === 1 ? 'bg-[var(--danger-bg)] text-[var(--danger)]' : 'bg-[var(--background)] text-[var(--text-muted)]'}`}>{ticket.escalation_level ? `Level ${ticket.escalation_level}` : 'Not escalated'}</span></div>
      </div>

      <section className="grid grid-cols-1 gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:grid-cols-2" aria-label="Ticket information">
        <Info label="Branch" value={`${ticket.branches?.name ?? '—'}${ticket.branches?.code ? ` (${ticket.branches.code})` : ''}`} />
        <Info label="Region" value={[ticket.branches?.zones?.nbgs?.name, ticket.branches?.zones?.name].filter(Boolean).join(' / ') || '—'} />
        <Info label="Device" value={ticket.devices ? `${ticket.devices.type} · ${ticket.devices.serial_number}` : '—'} />
        <Info label="Assigned SI at ticket creation" value={ticket.assigned_si_name ?? ticket.assigned_si_email ?? ticket.si_user?.name ?? ticket.si_user?.email ?? '—'} />
        <Info label="Current device SI" value={ticket.current_si_assignment?.profiles?.name ?? ticket.current_si_assignment?.profiles?.email ?? 'No active SI assignment'} />
        <Info label="Issue description" value={ticket.issue_description || '—'} />
        <Info label="Resolved" value={ticket.resolved_at ? `${formatDate(ticket.resolved_at)}${ticket.resolver?.name ? ` by ${ticket.resolver.name}` : ''}` : 'Not resolved'} />
        {ticket.resolution_note && <div className="sm:col-span-2"><Info label="Resolution note" value={ticket.resolution_note} /></div>}
      </section>

      {ticket.hms_events.length > 0 && <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-3 font-semibold">HMS source events</h3>
        <ul className="space-y-3">{ticket.hms_events.map((event) => <li key={event.id} className="border-b border-[var(--border)]/50 pb-3 last:border-0 last:pb-0">
          <p className="font-medium">{event.event_type === 'fault' ? 'Fault' : 'Restoration'} · {event.processing_status}</p>
          <p className="break-all text-xs text-[var(--text-muted)]">Event {event.source_event_id}{event.correlation_event_id ? ` · Correlates to ${event.correlation_event_id}` : ''}</p>
          {event.issue_description && <p className="mt-1 text-sm">{event.issue_description}</p>}
          <p className="mt-1 text-xs text-[var(--text-muted)]">Occurred {event.occurred_at ? formatDate(event.occurred_at) : 'time not supplied'} · Received {formatDate(event.received_at)}</p>
        </li>)}</ul>
        {ticket.source_system && <p className="mt-3 text-xs text-[var(--text-muted)]">Primary source: {ticket.source_system} · {ticket.source_event_id}</p>}
      </section>}

      {ticket.ticket_escalations.length > 0 && <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-3 font-semibold">Escalation history</h3>
        <ol className="space-y-2">{ticket.ticket_escalations.map((item) => <li key={item.id} className="flex flex-wrap justify-between gap-2 text-sm">
          <span>Level {item.escalation_level} · due {formatDate(item.due_at)}</span>
          <span className="text-[var(--text-muted)]">{item.email_outcome}{item.recipient ? ` · ${item.recipient}` : ''}</span>
        </li>)}</ol>
      </section>}

      {canManage && <section className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5" aria-label="Ticket actions">
        <h3 className="font-semibold">Update ticket</h3>
        <label htmlFor="ticket-note" className="block text-sm text-[var(--text-muted)]">Add a note (optional when resolving)</label>
        <textarea id="ticket-note" value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={2000} className="w-full rounded border border-[var(--border)] p-3 text-sm" placeholder="Add an update or resolution note…" />
        {actionError && <div role="alert" className="rounded-lg border-l-4 border-[var(--border)] border-l-[var(--danger)] bg-[var(--danger-bg)] p-3 text-sm text-[var(--danger)]">{actionError}</div>}
        <div className="flex flex-wrap gap-2">
          <button disabled={busy || !note.trim()} onClick={() => addNote.mutate()} className="inline-flex items-center gap-2 rounded border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-50"><MessageSquare className="h-4 w-4" />{addNote.isPending ? 'Adding…' : 'Add note'}</button>
          <button disabled={busy} onClick={() => resolve.mutate()} className="inline-flex items-center gap-2 rounded bg-[var(--success)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] disabled:opacity-50"><CheckCircle className="h-4 w-4" />{resolve.isPending ? 'Resolving…' : 'Mark resolved'}</button>
        </div>
      </section>}

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-4 font-semibold">Activity timeline</h3>
        {items.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No activity has been recorded yet.</p> : <ol className="space-y-4">{items.map((item) => item.kind === 'event' ? <li key={item.id} className="flex gap-3"><Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" /><div className="min-w-0"><p className="font-medium">{eventTitle(item.event.event_type)}</p><p className="text-xs text-[var(--text-muted)]">{formatDate(item.event.created_at)} · {item.event.actor?.name ?? item.event.actor_role?.replace('_', ' ') ?? 'System'}</p>{item.event.note && <p className="mt-1 whitespace-pre-wrap text-sm">{item.event.note}</p>}</div></li> : <li key={item.id} className="flex gap-3"><Mail className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" /><div><p className="font-medium">Escalation email {item.email.status}</p><p className="text-xs text-[var(--text-muted)]">{formatDate(item.at)} · {item.email.subject}</p>{item.email.error && <p className="mt-1 text-sm text-[var(--danger)]">{item.email.error}</p>}</div></li>)}</ol>}
      </section>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) { return <div><p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</p><p className="mt-1 text-sm">{value}</p></div> }
function formatDate(value: string) { return new Date(value).toLocaleString() }
function ticketAge(start: string, end: string | null) { const ms = Math.max(0, new Date(end ?? Date.now()).getTime() - new Date(start).getTime()); const hours = Math.floor(ms / 3_600_000); return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d ${hours % 24}h` }
function eventTitle(type: string) { return ({ created: 'Ticket created', escalated: 'Ticket escalated', note: 'Note added', resolved: 'Ticket resolved' } as Record<string, string>)[type] ?? type.replaceAll('_', ' ')}
