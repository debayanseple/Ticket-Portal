import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { supabase } from '../../lib/supabase'

// Devices are a registry of hardware in a branch. Each branch has one Dexter
// (HMS) panel; BAS, FAS, Timelock, Access Control and CCTV devices are linked
// to it through hms_panel_id. There is no live device status: a device is
// "Triggered" while it has open tickets and "Clear" otherwise.

type EmbeddedDevice = {
  id: string
  type: string
  serial_number: string
  hms_panel_id: string | null
  branches: null | {
    id: string
    name: string
    code: string
    zones: null | {
      id: string
      name: string
      code: string
      nbgs: null | { id: string; name: string; code: string }
    }
  }
}

type DeviceRow = EmbeddedDevice & { openTickets: number }

type PanelGroup = { key: string; serial: string; devices: DeviceRow[] }

type BranchGroup = {
  key: string
  branchName: string
  branchCode: string
  zoneKey: string
  zoneName: string
  zoneCode: string
  nbgKey: string
  nbgName: string
  nbgCode: string
  panels: PanelGroup[]
  standalone: DeviceRow[]
  total: number
  triggered: number
}

type NbgGroup = { key: string; name: string; code: string; zones: NbgZoneGroup[] }
type NbgZoneGroup = { key: string; name: string; code: string; branches: BranchGroup[] }

type TicketRow = { device_id: string | null }

async function fetchDevicesData() {
  const [devicesResult, openTicketsResult] = await Promise.all([
    fetchDeviceRows(),
    // RLS limits open tickets to the caller's scope the same way devices are.
    supabase.from('tickets').select('device_id').eq('status', 'open'),
  ])
  if (devicesResult.error) throw devicesResult.error
  const openTickets = (openTicketsResult.data ?? []) as TicketRow[]
  if (openTicketsResult.error) throw openTicketsResult.error

  const openByDevice = new Map<string, number>()
  for (const ticket of openTickets) {
    if (ticket.device_id) {
      openByDevice.set(ticket.device_id, (openByDevice.get(ticket.device_id) ?? 0) + 1)
    }
  }

  const devices = (devicesResult.data ?? []) as unknown as EmbeddedDevice[]
  return devices.map((device) => ({
    ...device,
    // Older deployments do not have the HMS panel relationship yet.
    hms_panel_id: device.hms_panel_id ?? null,
    openTickets: openByDevice.get(device.id) ?? 0,
  }))
}

async function fetchDeviceRows() {
  const withPanelLink = await supabase
    .from('devices')
    .select(
      `id, type, serial_number, hms_panel_id,
       branches ( id, name, code, zones ( id, name, code, nbgs ( id, name, code ) ) )`,
    )
    .order('serial_number')

  // The HMS migration is not deployed everywhere yet. Keep the existing
  // device registry usable while that database still has the legacy schema.
  if (
    withPanelLink.error?.code !== '42703' ||
    !withPanelLink.error.message.includes('hms_panel_id')
  ) {
    return withPanelLink
  }

  return supabase
    .from('devices')
    .select(
      `id, type, serial_number,
       branches ( id, name, code, zones ( id, name, code, nbgs ( id, name, code ) ) )`,
    )
    .order('serial_number')
}

export default function DevicesPage() {
  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: fetchDevicesData,
  })

  if (devicesQuery.isLoading) return <p className="p-4" role="status">Loading devices…</p>
  if (devicesQuery.error) return (
    <div className="space-y-3 rounded-lg border-l-4 border-[var(--border)] border-l-[var(--danger)] bg-[var(--danger-bg)] p-4" role="alert">
      <p className="text-[var(--danger)]">Could not load devices: {devicesQuery.error.message}</p>
      <button onClick={() => void devicesQuery.refetch()} className="rounded border border-[var(--border)] px-3 py-2 text-sm">Try again</button>
    </div>
  )

  const devices = devicesQuery.data ?? []
  const branchGroups = buildBranchGroups(devices)
  const nbgGroups = groupByNbg(branchGroups)
  const triggeredTotal = branchGroups.reduce((sum, branch) => sum + branch.triggered, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Devices</h2>
          <p className="text-sm text-[var(--text-muted)]">
            {devices.length} device{devices.length === 1 ? '' : 's'} across {branchGroups.length} branch{branchGroups.length === 1 ? '' : 'es'},
            shown under their NBG → ZO → Branch → Dexter (HMS) hierarchy. {triggeredTotal} device{triggeredTotal === 1 ? '' : 's'} currently triggered.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void devicesQuery.refetch()}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--row-hover)]"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
        </button>
      </div>

      {nbgGroups.length === 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-10 text-center text-[var(--text-muted)]">
          No devices are visible in your scope yet.
        </div>
      )}

      {nbgGroups.map((nbg) => (
        <section key={nbg.key} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]" aria-label={`NBG ${nbg.name}`}>
          <header className="flex flex-wrap items-baseline gap-2 border-b border-[var(--border)] px-4 py-3">
            <h3 className="font-semibold">NBG · {nbg.name}</h3>
            <span className="text-xs text-[var(--text-muted)]">{nbg.code}</span>
            <span className="ml-auto text-xs text-[var(--text-muted)]">{countDevices(nbg)} device{countDevices(nbg) === 1 ? '' : 's'}</span>
          </header>

          <div className="divide-y divide-[var(--border)]/60">
            {nbg.zones.map((zone) => (
              <div key={zone.key} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h4 className="text-sm font-semibold">ZO · {zone.name}</h4>
                  <span className="text-xs text-[var(--text-muted)]">{zone.code}</span>
                </div>

                <div className="mt-2 space-y-2 border-l-2 border-[var(--border)] pl-3">
                  {zone.branches.map((branch) => (
                    <div key={branch.key} className="rounded-xl border border-[var(--border)] bg-[var(--background)]">
                      <header className="flex flex-wrap items-baseline gap-2 px-3 py-2">
                        <h5 className="text-sm font-medium">Branch · {branch.branchName}</h5>
                        <span className="text-xs text-[var(--text-muted)]">{branch.branchCode}</span>
                        <span className="ml-auto text-xs text-[var(--text-muted)]">
                          {branch.total} device{branch.total === 1 ? '' : 's'} · <span className={branch.triggered ? 'text-[var(--danger)]' : ''}>{branch.triggered} triggered</span>
                        </span>
                      </header>

                      <div className="space-y-2 border-t border-[var(--border)]/60 px-3 py-3">
                        {branch.panels.map((panel) => (
                          <div key={panel.key} className="rounded-lg border border-[var(--border)]">
                            <div className="flex flex-wrap items-baseline gap-2 px-3 py-2">
                              <span className="text-sm font-semibold">Dexter (HMS panel)</span>
                              <span className="font-mono text-xs text-[var(--text-muted)]">{panel.serial}</span>
                            </div>
                            <div className="overflow-x-auto border-t border-[var(--border)]/60">
                              <DeviceTable devices={panel.devices} indent />
                            </div>
                          </div>
                        ))}
                        {branch.standalone.length > 0 && <DeviceTable devices={branch.standalone} />}
                        {branch.panels.length === 0 && branch.standalone.length === 0 && (
                          <p className="text-sm text-[var(--text-muted)]">No devices registered for this branch.</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function DeviceTable({ devices, indent = false }: { devices: DeviceRow[]; indent?: boolean }) {
  return (
    <table className="w-full min-w-[520px] border-collapse text-left text-sm">
      <thead>
        <tr className="border-b border-[var(--border)]/60 text-[var(--text-muted)]">
          <th className="px-3 py-2 font-medium">Type</th>
          <th className="px-3 py-2 font-medium">Serial number</th>
          <th className="px-3 py-2 font-medium">Status</th>
          <th className="px-3 py-2 font-medium">Open tickets</th>
        </tr>
      </thead>
      <tbody>
        {devices.map((device) => (
          <tr key={device.id} className="border-b border-[var(--border)]/40 last:border-b-0 hover:bg-[var(--row-hover)]">
            <td className="px-3 py-2">{indent ? <span className="pl-3">{device.type}</span> : device.type}</td>
            <td className="px-3 py-2 font-mono text-xs">{device.serial_number}</td>
            <td className="px-3 py-2"><StatusBadge openTickets={device.openTickets} /></td>
            <td className="px-3 py-2">{device.openTickets > 0 ? device.openTickets : <span className="text-[var(--text-muted)]">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// The shown status is ticket-driven: a device is "Triggered" while it has open
// tickets, "Clear" otherwise (no live monitoring — HMS raises the tickets).
function StatusBadge({ openTickets }: { openTickets: number | undefined }) {
  const triggered = openTickets === undefined || openTickets > 0
  if (triggered) {
    return <span className="rounded-full bg-[var(--danger-bg)] px-2 py-1 text-xs font-medium text-[var(--danger)]">Triggered</span>
  }
  return <span className="rounded-full bg-[var(--success-bg)] px-2 py-1 text-xs font-medium text-[var(--success)]">Clear</span>
}

function buildBranchGroups(devices: DeviceRow[]): BranchGroup[] {
  const byBranch = new Map<string, BranchGroup>()
  for (const device of devices) {
    const branch = device.branches
    const zone = branch?.zones ?? null
    const nbg = zone?.nbgs ?? null
    const branchKey = branch?.id ?? 'unknown'
    let group = byBranch.get(branchKey)
    if (!group) {
      group = {
        key: branchKey,
        branchName: branch?.name ?? 'Unknown branch',
        branchCode: branch?.code ?? '—',
        zoneKey: zone?.id ?? 'unknown-zone',
        zoneName: zone?.name ?? 'Unknown zone',
        zoneCode: zone?.code ?? '—',
        nbgKey: nbg?.id ?? 'unknown-nbg',
        nbgName: nbg?.name ?? 'Unknown NBG',
        nbgCode: nbg?.code ?? '—',
        panels: [],
        standalone: [],
        total: 0,
        triggered: 0,
      }
      byBranch.set(branchKey, group)
    }
    group.total += 1
    if (device.openTickets > 0) group.triggered += 1
    if (device.type === 'Dexter') {
      group.panels.push({ key: device.id, serial: device.serial_number, devices: [] })
    } else {
      group.standalone.push(device)
    }
  }

  // Attach monitored devices to their branch's Dexter panel.
  for (const group of byBranch.values()) {
    for (const device of group.standalone) {
      const panel = group.panels.find((p) => p.key === device.hms_panel_id)
      if (panel) {
        panel.devices.push(device)
      }
    }
    group.standalone = group.standalone.filter((device) => !group.panels.some((p) => p.key === device.hms_panel_id))
  }

  return [...byBranch.values()].sort((a, b) => a.branchName.localeCompare(b.branchName))
}

function groupByNbg(branchGroups: BranchGroup[]): NbgGroup[] {
  const nbgMap = new Map<string, NbgGroup>()
  const zoneMap = new Map<string, NbgZoneGroup>()

  for (const branch of branchGroups) {
    let nbg = nbgMap.get(branch.nbgKey)
    if (!nbg) {
      nbg = { key: branch.nbgKey, name: branch.nbgName, code: branch.nbgCode, zones: [] }
      nbgMap.set(branch.nbgKey, nbg)
    }

    let zone = zoneMap.get(branch.zoneKey)
    if (!zone) {
      zone = { key: branch.zoneKey, name: branch.zoneName, code: branch.zoneCode, branches: [] }
      zoneMap.set(branch.zoneKey, zone)
      nbg.zones.push(zone)
    }
    zone.branches.push(branch)
  }

  for (const nbg of nbgMap.values()) {
    nbg.zones.sort((a, b) => a.name.localeCompare(b.name))
  }
  return [...nbgMap.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function countDevices(nbg: NbgGroup): number {
  return nbg.zones.reduce((sum, zone) => sum + zone.branches.length, 0)
}
