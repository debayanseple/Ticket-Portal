import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Search, ShieldAlert, UserPlus } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabase'

type BranchOption = {
  id: string
  name: string
  code: string
  zones: { name: string; nbgs: { name: string } | null } | null
}
type DeviceOption = { id: string; branch_id: string; type: string; serial_number: string }
type SiOption = { id: string; name: string; email: string }
type ActiveAssignment = { device_id: string; si_user_id: string; profiles: SiOption | null }
type AuditEvent = {
  id: string
  changed_at: string
  devices: { type: string; serial_number: string; branches: { name: string; code: string } | null } | null
  previous_si: { name: string; email: string } | null
  new_si: { name: string; email: string } | null
  actor: { name: string; email: string } | null
}

export default function AssignSiPage() {
  const { profile } = useAuth()
  const queryClient = useQueryClient()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [selectedBranchId, setSelectedBranchId] = useState('')
  const [branchSearch, setBranchSearch] = useState('')
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false)
  const [siName, setSiName] = useState('')
  const [siEmail, setSiEmail] = useState('')
  const [createNotice, setCreateNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)

  const assignmentsQuery = useQuery({
    queryKey: ['siAssignments'],
    enabled: profile?.role === 'head_office',
    queryFn: async () => {
      const [branches, devices, sis, assignments, audit] = await Promise.all([
        supabase.from('branches').select('id, name, code, zones(name, nbgs(name))').order('name'),
        supabase.from('devices').select('id, branch_id, type, serial_number').order('type'),
        supabase.from('profiles').select('id, name, email').eq('role', 'si').order('name'),
        supabase.from('device_si_assignments')
          .select('device_id, si_user_id, profiles:profiles!device_si_assignments_si_user_id_fkey(id, name, email)')
          .eq('is_active', true),
        supabase.from('device_assignment_events')
          .select('id, changed_at, devices(type, serial_number, branches(name, code)), previous_si:profiles!device_assignment_events_previous_si_user_id_fkey(name, email), new_si:profiles!device_assignment_events_new_si_user_id_fkey(name, email), actor:profiles!device_assignment_events_actor_id_fkey(name, email)')
          .order('changed_at', { ascending: false })
          .limit(12),
      ])
      const error = branches.error ?? devices.error ?? sis.error ?? assignments.error ?? audit.error
      if (error) throw error
      return {
        branches: (branches.data ?? []) as unknown as BranchOption[],
        devices: (devices.data ?? []) as DeviceOption[],
        sis: (sis.data ?? []) as SiOption[],
        assignments: (assignments.data ?? []) as unknown as ActiveAssignment[],
        audit: (audit.data ?? []) as unknown as AuditEvent[],
      }
    },
  })

  const createSi = useMutation({
    mutationFn: async ({ name, email }: { name: string; email: string }) => {
      const { error } = await supabase.functions.invoke('invite-user', {
        body: { name, email, role: 'si', scope_id: null, scope_type: null },
      })
      if (error) throw error
    },
    onSuccess: async () => {
      setSiName('')
      setSiEmail('')
      setCreateNotice({ kind: 'success', message: 'SI profile created.' })
      await queryClient.invalidateQueries({ queryKey: ['siAssignments'] })
    },
    onError: (error: unknown) => {
      setCreateNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not create SI profile.',
      })
    },
  })

  const assign = useMutation({
    mutationFn: async ({ deviceId, siUserId }: { deviceId: string; siUserId: string }) => {
      const { error } = await supabase.rpc('set_device_si_assignment', {
        p_device_id: deviceId,
        p_si_user_id: siUserId || null,
      })
      if (error) throw error
    },
    onSuccess: async (_, variables) => {
      setDrafts((previous) => {
        const next = { ...previous }
        delete next[variables.deviceId]
        return next
      })
      await queryClient.invalidateQueries({ queryKey: ['siAssignments'] })
      await queryClient.invalidateQueries({ queryKey: ['ticketFilterOptions'] })
    },
  })

  const activeByDevice = useMemo(() => {
    const map = new Map<string, ActiveAssignment>()
    for (const assignment of assignmentsQuery.data?.assignments ?? []) {
      map.set(assignment.device_id, assignment)
    }
    return map
  }, [assignmentsQuery.data?.assignments])

  const devicesByBranch = useMemo(() => {
    const map = new Map<string, DeviceOption[]>()
    for (const device of assignmentsQuery.data?.devices ?? []) {
      map.set(device.branch_id, [...(map.get(device.branch_id) ?? []), device])
    }
    return map
  }, [assignmentsQuery.data?.devices])

  if (profile?.role !== 'head_office') {
    return <div role="alert" className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">This page is available to Head Office users only.</div>
  }
  if (assignmentsQuery.isLoading) return <p className="p-4" role="status">Loading assignments…</p>
  if (assignmentsQuery.error) return <div role="alert" className="rounded-lg border-l-4 border-[var(--border)] border-l-[var(--danger)] bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger)]">Could not load SI assignments: {assignmentsQuery.error.message}</div>

  const data = assignmentsQuery.data!
  const selectedBranch = data.branches.find((branch) => branch.id === selectedBranchId) ?? data.branches[0] ?? null
  const selectedBranchDevices = selectedBranch ? devicesByBranch.get(selectedBranch.id) ?? [] : []
  const matchingBranches = data.branches.filter((branch) =>
    `${branch.name} ${branch.code}`.toLocaleLowerCase().includes(branchSearch.trim().toLocaleLowerCase()),
  )
  const assignedByBranch = data.branches.map((branch) => ({
    branch,
    devices: (devicesByBranch.get(branch.id) ?? []).filter((device) => activeByDevice.has(device.id)),
  })).filter((group) => group.devices.length > 0)
  const unassignedByBranch = data.branches.map((branch) => ({
    branch,
    devices: (devicesByBranch.get(branch.id) ?? []).filter((device) => !activeByDevice.has(device.id)),
  })).filter((group) => group.devices.length > 0)
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <ShieldAlert className="h-6 w-6 text-[var(--accent)]" aria-hidden="true" />
        <div>
          <h2 className="text-2xl font-semibold">Assign SI</h2>
          <p className="text-sm text-[var(--text-muted)]">Create an SI profile first, then assign an SI to each device. New tickets go to that device’s SI; existing tickets keep their assignment snapshot. Each branch supports up to five devices.</p>
        </div>
      </div>

      {assign.error && <p role="alert" className="rounded-lg bg-[var(--danger-bg)] p-3 text-sm text-[var(--danger)]">Could not save assignment: {assign.error.message}</p>}

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-center gap-2 mb-3">
          <UserPlus className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
          <h3 className="font-semibold">Create SI Profile</h3>
        </div>
        {createNotice && (
          <p className={`mb-3 text-sm rounded px-3 py-2 ${
            createNotice.kind === 'success'
              ? 'bg-[var(--success-bg)] text-[var(--success)] border border-[var(--success)]/30'
              : 'bg-[var(--danger-bg)] text-[var(--danger)] border border-[var(--danger)]/30'
          }`}>{createNotice.message}</p>
        )}
        <form onSubmit={(event) => {
          event.preventDefault()
          createSi.mutate({ name: siName.trim(), email: siEmail.trim() })
        }} className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Name</label>
            <input
              type="text"
              required
              value={siName}
              onChange={(event) => setSiName(event.target.value)}
              placeholder="e.g. Rajesh Kumar"
              className="rounded border border-[var(--border)] px-3 py-2 bg-[var(--background)]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Email</label>
            <input
              type="email"
              required
              value={siEmail}
              onChange={(event) => setSiEmail(event.target.value)}
              placeholder="e.g. rajesh@example.com"
              className="rounded border border-[var(--border)] px-3 py-2 bg-[var(--background)]"
            />
          </div>
          <div>
            <button
              type="submit"
              disabled={createSi.isPending || !siName.trim() || !siEmail.trim()}
              className="rounded bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-contrast)] disabled:opacity-40"
            >
              {createSi.isPending ? 'Creating…' : 'Create SI'}
            </button>
          </div>
        </form>
      </section>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium" htmlFor="assignment-branch">Branch</label>
              <div
                className="relative"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBranchDropdownOpen(false)
                }}
              >
                <button
                  id="assignment-branch"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={branchDropdownOpen}
                  aria-controls="assignment-branch-options"
                  disabled={data.branches.length === 0}
                  onClick={() => {
                    setBranchSearch('')
                    setBranchDropdownOpen((open) => !open)
                  }}
                  className="flex min-h-11 w-full items-center justify-between rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-left disabled:opacity-50"
                >
                  <span>{selectedBranch ? `${selectedBranch.name} (${selectedBranch.code})` : 'No branches available'}</span>
                  <ChevronDown className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${branchDropdownOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
                {branchDropdownOpen && <div className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 shadow-sm">
                  <div className="relative mb-2">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden="true" />
                    <input
                      autoFocus
                      type="search"
                      value={branchSearch}
                      onChange={(event) => setBranchSearch(event.target.value)}
                      placeholder="Search branches…"
                      aria-label="Search branches"
                      className="min-h-11 w-full rounded border border-[var(--border)] bg-[var(--background)] py-2 pl-9 pr-3 text-sm"
                    />
                  </div>
                  <ul id="assignment-branch-options" role="listbox" aria-label="Branches" className="max-h-72 space-y-1 overflow-y-auto">
                    {matchingBranches.length === 0 ? <li className="px-3 py-2 text-sm text-[var(--text-muted)]">No matching branches.</li> : matchingBranches.map((branch) => (
                      <li key={branch.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={selectedBranch?.id === branch.id}
                          onClick={() => {
                            setSelectedBranchId(branch.id)
                            setBranchSearch('')
                            setBranchDropdownOpen(false)
                          }}
                          className={`min-h-10 w-full rounded px-3 py-2 text-left text-sm hover:bg-[var(--row-hover)] ${selectedBranch?.id === branch.id ? 'bg-[var(--row-hover)] font-medium' : ''}`}
                        >
                          {branch.name} ({branch.code})
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>}
              </div>
            </div>
            {selectedBranch && <div className="pb-2 text-xs text-[var(--text-muted)]">
              {selectedBranchDevices.length}/5 devices
              {[selectedBranch.zones?.nbgs?.name, selectedBranch.zones?.name].filter(Boolean).length > 0 && (
                <span> · {[selectedBranch.zones?.nbgs?.name, selectedBranch.zones?.name].filter(Boolean).join(' / ')}</span>
              )}
            </div>}
          </div>

          {!selectedBranch ? <p className="text-sm text-[var(--text-muted)]">No branches are available.</p> : selectedBranchDevices.length === 0 ? (
            <p className="rounded-lg border border-[var(--border)] p-4 text-sm text-[var(--text-muted)]">No devices registered for this branch.</p>
          ) : <div className="space-y-2">
            {selectedBranchDevices.map((device) => {
              const active = activeByDevice.get(device.id)
              const currentValue = active?.si_user_id ?? ''
              const selected = Object.hasOwn(drafts, device.id) ? drafts[device.id] : currentValue
              const changed = selected !== currentValue
              const busy = assign.isPending && assign.variables?.deviceId === device.id
              return <div key={device.id} className="grid grid-cols-1 gap-2 rounded-lg border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
                <div><div className="font-medium">{device.type}</div><div className="font-mono text-xs text-[var(--text-muted)]">{device.serial_number}</div></div>
                <div><label className="sr-only" htmlFor={`si-${device.id}`}>Select SI for {selectedBranch.name} {device.type}</label><select id={`si-${device.id}`} value={selected} onChange={(event) => setDrafts((previous) => ({ ...previous, [device.id]: event.target.value }))} className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2">
                  <option value="">Unassigned</option>
                  {data.sis.map((si) => <option key={si.id} value={si.id}>{si.name} · {si.email}</option>)}
                </select></div>
                <button type="button" disabled={!changed || busy} onClick={() => assign.mutate({ deviceId: device.id, siUserId: selected })} className="inline-flex items-center justify-center gap-2 rounded bg-[var(--accent)] px-3 py-2 font-medium text-[var(--accent-contrast)] disabled:opacity-40"><Check className="h-4 w-4" aria-hidden="true" />{busy ? 'Saving…' : 'Save'}</button>
              </div>
            })}
          </div>}
        </div>
      </section>

      <section className="flex h-80 flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 lg:h-96">
        <h3 className="mb-3 shrink-0 font-semibold">Recent assignment changes</h3>
        {data.audit.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No assignment changes recorded.</p> : <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">{data.audit.map((event) => <li key={event.id} className="border-b border-[var(--border)]/50 pb-3 text-sm last:border-0 last:pb-0">
          <p><span className="font-medium">{event.devices?.branches?.name ?? 'Branch'} ({event.devices?.branches?.code ?? '—'}) · {event.devices?.type ?? 'Device'} {event.devices?.serial_number ?? ''}</span>: {event.previous_si?.name ?? 'Unassigned'} → {event.new_si?.name ?? 'Unassigned'}</p>
          <p className="text-xs text-[var(--text-muted)]">{new Date(event.changed_at).toLocaleString()} · by {event.actor?.name ?? event.actor?.email ?? 'Head Office'}</p>
        </li>)}</ol>}
      </section>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-semibold">Assigned branches</h3>
            <span className="rounded-full bg-[var(--success-bg)] px-2.5 py-1 text-xs font-medium text-[var(--success)]">{assignedByBranch.reduce((total, group) => total + group.devices.length, 0)} devices</span>
          </div>
          {assignedByBranch.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No devices have an SI assigned yet.</p> : <div className="max-h-80 space-y-4 overflow-y-auto pr-1">
            {assignedByBranch.map(({ branch, devices }) => <div key={branch.id} className="rounded-lg border border-[var(--border)] p-3">
              <h4 className="mb-2 text-sm font-semibold">{branch.name} ({branch.code})</h4>
              <ul className="space-y-2">
                {devices.map((device) => {
                  const si = activeByDevice.get(device.id)?.profiles
                  return <li key={device.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
                    <span>{device.type} <span className="font-mono text-xs text-[var(--text-muted)]">{device.serial_number}</span></span>
                    <span className="text-[var(--text-muted)]">{si?.name ?? si?.email ?? 'SI profile unavailable'}</span>
                  </li>
                })}
              </ul>
            </div>)}
          </div>}
        </section>

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-semibold">Devices without an SI</h3>
            <span className="rounded-full bg-[var(--background)] px-2.5 py-1 text-xs font-medium text-[var(--text-muted)]">{unassignedByBranch.reduce((total, group) => total + group.devices.length, 0)} devices</span>
          </div>
          {unassignedByBranch.length === 0 ? <p className="text-sm text-[var(--text-muted)]">Every device has an SI assigned.</p> : <div className="max-h-80 space-y-4 overflow-y-auto pr-1">
            {unassignedByBranch.map(({ branch, devices }) => <div key={branch.id} className="rounded-lg border border-[var(--border)] p-3">
              <h4 className="mb-2 text-sm font-semibold">{branch.name} ({branch.code})</h4>
              <ul className="space-y-2">
                {devices.map((device) => <li key={device.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
                  <span>{device.type} <span className="font-mono text-xs text-[var(--text-muted)]">{device.serial_number}</span></span>
                  <span className="text-xs text-[var(--text-muted)]">Unassigned</span>
                </li>)}
              </ul>
            </div>)}
          </div>}
        </section>
      </div>
    </div>
  )
}
