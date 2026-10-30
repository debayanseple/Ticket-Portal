import { useQuery } from '@tanstack/react-query'
import { Building2, ChevronDown } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabase'

type NbgRow = { id: string; name: string }
type ZoneRow = { id: string; name: string; nbg_id: string }
type BranchRow = { id: string; name: string; zone_id: string }
type TreeNode = { id: string; name: string; isBranch?: boolean; children?: TreeNode[] }

export default function UsersPage() {
  const { profile } = useAuth()
  const hierarchyQuery = useQuery({
    queryKey: ['organizationHierarchy'],
    queryFn: async () => {
      const [nbgs, zones, branches] = await Promise.all([
        supabase.from('nbgs').select('id, name').order('name'),
        supabase.from('zones').select('id, name, nbg_id').order('name'),
        supabase.from('branches').select('id, name, zone_id').order('name'),
      ])
      const error = nbgs.error ?? zones.error ?? branches.error
      if (error) throw error

      const organization: TreeNode = {
        id: 'head-office',
        name: 'Bank of India (HO)',
        children: (nbgs.data ?? []).map((nbg: NbgRow) => ({
          id: nbg.id,
          name: nbg.name,
          children: (zones.data ?? [])
            .filter((zone: ZoneRow) => zone.nbg_id === nbg.id)
            .map((zone: ZoneRow) => ({
              id: zone.id,
              name: zone.name,
              children: (branches.data ?? [])
                .filter((branch: BranchRow) => branch.zone_id === zone.id)
                .map((branch: BranchRow) => ({ id: branch.id, name: branch.name, isBranch: true })),
            })),
        })),
      }
      return organization
    },
  })

  if (hierarchyQuery.isLoading) return <p className="p-4" role="status">Loading organization hierarchy…</p>
  if (hierarchyQuery.error) return <div role="alert" className="rounded-lg border-l-4 border-[var(--border)] border-l-[var(--danger)] bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger)]">Could not load organization hierarchy: {hierarchyQuery.error.message}</div>

  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
        <h2 className="mb-3 text-lg font-semibold">My account</h2>
        {profile ? <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <AccountDetail label="Username" value={profile.name} />
          <AccountDetail label="Email" value={profile.email} />
          <AccountDetail label="Role" value={profile.role === 'head_office' ? 'Head Office' : profile.role.toUpperCase()} />
          <AccountDetail label="User ID" value={profile.id} mono />
          <AccountDetail label="Member since" value={new Date(profile.created_at).toLocaleDateString()} />
        </dl> : <p className="text-sm text-[var(--text-muted)]">Your profile details are unavailable.</p>}
      </section>

      <h2 className="text-lg font-semibold">Organization Hierarchy</h2>
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-5">
        {hierarchyQuery.data?.children?.length ? <ul className="space-y-0.5">
          <HierarchyItem node={hierarchyQuery.data} root />
        </ul> : <p className="text-sm text-[var(--text-muted)]">No organization hierarchy is available.</p>}
      </section>
    </div>
  )
}

function AccountDetail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0">
    <dt className="text-xs font-medium text-[var(--text-muted)]">{label}</dt>
    <dd className={`mt-0.5 truncate text-sm ${mono ? 'font-mono' : 'font-medium'}`} title={value}>{value}</dd>
  </div>
}

function HierarchyItem({ node, root = false }: { node: TreeNode; root?: boolean }) {
  const hasChildren = Boolean(node.children?.length)
  const count = countBranches(node)
  const row = <span className="flex min-h-8 min-w-0 items-center gap-2 rounded px-2 hover:bg-[var(--row-hover)]">
    {hasChildren
      ? <ChevronDown className="h-3 w-3 shrink-0 rotate-90 text-[var(--text-muted)] transition-transform group-open/tree-node:rotate-0" aria-hidden="true" />
      : <span className="w-3 shrink-0" aria-hidden="true" />}
    <Building2 className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
    <span className="min-w-0 flex-1 truncate">{node.name}</span>
    <span aria-label={`${count} ${count === 1 ? 'branch' : 'branches'}`} className="rounded-full border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[10px] leading-4 text-[var(--text-muted)]">{count}</span>
  </span>

  return <li className={`relative min-w-0 text-sm ${root ? '' : 'pl-4 before:absolute before:left-0 before:top-4 before:w-4 before:border-t before:border-dashed before:border-[var(--border)]'}`}>
    {hasChildren ? <details open className="group/tree-node">
      <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">{row}</summary>
      <ul className="ml-3 space-y-0.5 border-l border-dashed border-[var(--border)] py-0.5">
        {node.children!.map((child) => <HierarchyItem key={child.id} node={child} />)}
      </ul>
    </details> : <div>{row}</div>}
  </li>
}

function countBranches(node: TreeNode): number {
  if (node.isBranch) return 1
  if (!node.children?.length) return 0
  return node.children.reduce((total, child) => total + countBranches(child), 0)
}
