export type UserRole = 'head_office' | 'nbg' | 'zonal' | 'branch' | 'si'
export type TicketStatus = 'open' | 'resolved'
export type EmailStatus = 'pending' | 'sent' | 'failed'

export interface Profile {
  id: string
  email: string
  name: string
  role: UserRole
  nbg_id?: string | null
  zone_id?: string | null
  branch_id?: string | null
  created_at: string
}

export interface Nbg {
  id: string
  name: string
  code: string
  created_at: string
}

export interface Zone {
  id: string
  nbg_id: string
  name: string
  code: string
  created_at: string
}

export interface Branch {
  id: string
  zone_id: string
  name: string
  code: string
  created_at: string
}

export interface BranchSiAssignment {
  id: string
  branch_id: string
  si_user_id: string
  assigned_by: string
  assigned_at: string
  is_active: boolean
}

export interface Device {
  id: string
  branch_id: string
  // Dexter (HMS) panels have hms_panel_id = null; monitored devices (BAS, FAS,
  // Timelock, Access Control, CCTV) point at their branch's panel. There is no
  // live status column: shown status derives from open tickets.
  hms_panel_id?: string | null
  type: string
  serial_number: string
  created_at: string
}

export interface Ticket {
  id: string
  ticket_number: string
  branch_id: string
  device_id?: string | null
  si_user_id?: string | null
  status: TicketStatus
  escalation_level: number
  created_at: string
  updated_at: string
  resolved_at?: string | null
  resolved_by?: string | null
  resolution_note?: string | null
  branches?: {
    id: string
    name: string
    zones?: {
      id: string
      name: string
      nbgs?: { id: string; name: string } | null
    } | null
  } | null
  devices?: { id: string; serial_number: string } | null
}

export interface TicketEvent {
  id: string
  ticket_id: string
  event_type: string
  actor_id?: string | null
  actor_role?: UserRole | null
  note?: string | null
  created_at: string
}

export interface EmailOutbox {
  id: string
  ticket_id: string
  to_email: string
  subject: string
  body: string
  status: EmailStatus
  error?: string | null
  sent_at?: string | null
  created_at: string
}

export interface DashboardWidget {
  label: string
  value: number
  filter: string
  href: string
}
