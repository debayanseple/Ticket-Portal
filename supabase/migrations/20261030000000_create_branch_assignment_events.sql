-- Create branch_assignment_events table for SI assignment audit history.
-- This table is referenced by the Assign SI page.

alter table public.branch_si_assignments
  add column if not exists ended_at timestamptz,
  add column if not exists ended_by uuid references public.profiles(id);

drop policy if exists bsa_ho_manage on public.branch_si_assignments;
revoke insert, update, delete on public.branch_si_assignments from anon, authenticated;
grant select on public.branch_si_assignments to authenticated;

create table if not exists public.branch_assignment_events (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  previous_si_user_id uuid references public.profiles(id) on delete set null,
  new_si_user_id uuid references public.profiles(id) on delete set null,
  actor_id uuid not null references public.profiles(id),
  changed_at timestamptz not null default now()
);
alter table public.branch_assignment_events enable row level security;
revoke all on public.branch_assignment_events from anon, authenticated;
grant select on public.branch_assignment_events to authenticated;
grant all on public.branch_assignment_events to service_role;
drop policy if exists branch_assignment_events_ho_read on public.branch_assignment_events;
create policy branch_assignment_events_ho_read on public.branch_assignment_events
  for select to authenticated
  using (public.current_user_role() = 'head_office');
create index if not exists branch_assignment_events_recent_idx
  on public.branch_assignment_events(changed_at desc);
