-- Assign a System Integrator to each device. Branch assignments remain as a
-- fallback for older installations and tickets without a device.
alter table public.tickets
  add column if not exists issue_description text not null default '',
  add column if not exists source_system text,
  add column if not exists source_event_id text,
  add column if not exists assigned_si_name text,
  add column if not exists assigned_si_email text;

create table public.device_si_assignments (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  si_user_id uuid not null references public.profiles(id) on delete cascade,
  assigned_by uuid not null references public.profiles(id),
  assigned_at timestamptz not null default now(),
  is_active boolean not null default true,
  ended_at timestamptz,
  ended_by uuid references public.profiles(id)
);

create unique index device_si_assignments_one_active
  on public.device_si_assignments(device_id) where is_active;
create index device_si_assignments_si_active
  on public.device_si_assignments(si_user_id, device_id) where is_active;

-- Preserve current routing by carrying each branch's latest active SI onto
-- its devices. Head Office can then change individual devices independently.
insert into public.device_si_assignments (device_id, si_user_id, assigned_by, assigned_at)
select d.id, current_assignment.si_user_id, current_assignment.assigned_by, now()
from public.devices d
join (
  select distinct on (branch_id) branch_id, si_user_id, assigned_by
  from public.branch_si_assignments
  where is_active
  order by branch_id, assigned_at desc
) current_assignment on current_assignment.branch_id = d.branch_id;

alter table public.device_si_assignments enable row level security;
revoke all on public.device_si_assignments from anon, authenticated;
grant select on public.device_si_assignments to authenticated;
grant all on public.device_si_assignments to service_role;

-- Run the device-to-branch lookup as the function owner so this policy does
-- not recurse through devices_scope_read -> device_si_assignments.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.device_in_scope(p_device_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.devices d
    where d.id = p_device_id and public.branch_in_scope(d.branch_id)
  )
$$;
revoke all on function private.device_in_scope(uuid) from public, anon;
grant execute on function private.device_in_scope(uuid) to authenticated;

create policy device_si_assignments_read_scope on public.device_si_assignments
  for select to authenticated
  using (
    public.current_user_role() = 'head_office'
    or (public.current_user_role() = 'si' and si_user_id = auth.uid())
    or (public.current_user_role() <> 'si'
      and private.device_in_scope(device_id))
  );

create table public.device_assignment_events (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  previous_si_user_id uuid references public.profiles(id) on delete set null,
  new_si_user_id uuid references public.profiles(id) on delete set null,
  actor_id uuid not null references public.profiles(id),
  changed_at timestamptz not null default now()
);
alter table public.device_assignment_events enable row level security;
revoke all on public.device_assignment_events from anon, authenticated;
grant select on public.device_assignment_events to authenticated;
grant all on public.device_assignment_events to service_role;
create policy device_assignment_events_ho_read on public.device_assignment_events
  for select to authenticated
  using (public.current_user_role() = 'head_office');
create index device_assignment_events_recent_idx
  on public.device_assignment_events(changed_at desc);

-- Let SIs enter branches where they own at least one device assignment.
create or replace function public.branch_in_scope(branch_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  r public.user_role;
  p public.profiles%rowtype;
  b public.branches%rowtype;
  z public.zones%rowtype;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found then return false; end if;
  r := p.role;
  if r = 'head_office' then return true; end if;
  if r = 'si' then
    return exists (
      select 1 from public.branch_si_assignments bsa
      where bsa.branch_id = branch_in_scope.branch_id
        and bsa.si_user_id = auth.uid() and bsa.is_active
    ) or exists (
      select 1 from public.device_si_assignments dsa
      join public.devices d on d.id = dsa.device_id
      where d.branch_id = branch_in_scope.branch_id
        and dsa.si_user_id = auth.uid() and dsa.is_active
    );
  end if;
  select * into b from public.branches where id = branch_in_scope.branch_id;
  if not found then return false; end if;
  if r = 'branch' then return b.id = p.branch_id; end if;
  select * into z from public.zones where id = b.zone_id;
  if not found then return false; end if;
  if r = 'zonal' then return z.id = p.zone_id; end if;
  if r = 'nbg' then return z.nbg_id = p.nbg_id; end if;
  return false;
end;
$$;

drop policy if exists devices_scope_read on public.devices;
create policy devices_scope_read on public.devices
  for select to authenticated
  using (
    public.current_user_role() = 'head_office'
    or (public.current_user_role() = 'si' and (
      exists (select 1 from public.device_si_assignments dsa
        where dsa.device_id = devices.id and dsa.si_user_id = auth.uid() and dsa.is_active)
      or exists (select 1 from public.branch_si_assignments bsa
        where bsa.branch_id = devices.branch_id and bsa.si_user_id = auth.uid() and bsa.is_active)
    ))
    or (public.current_user_role() <> 'si' and public.branch_in_scope(branch_id))
  );

drop policy if exists tickets_scope_read on public.tickets;
create policy tickets_scope_read on public.tickets
  for select to authenticated
  using (
    public.current_user_role() = 'head_office'
    or (public.current_user_role() = 'si' and si_user_id = auth.uid())
    or (public.current_user_role() <> 'si' and public.branch_in_scope(branch_id))
  );

drop policy if exists ticket_events_scope_read on public.ticket_events;
create policy ticket_events_scope_read on public.ticket_events
  for select to authenticated
  using (exists (
    select 1 from public.tickets t where t.id = ticket_events.ticket_id and (
      public.current_user_role() = 'head_office'
      or (public.current_user_role() = 'si' and t.si_user_id = auth.uid())
      or (public.current_user_role() <> 'si' and public.branch_in_scope(t.branch_id))
    )
  ));

drop policy if exists email_outbox_scope_read on public.email_outbox;
create policy email_outbox_scope_read on public.email_outbox
  for select to authenticated
  using (exists (
    select 1 from public.tickets t where t.id = email_outbox.ticket_id and (
      public.current_user_role() = 'head_office'
      or (public.current_user_role() = 'si' and t.si_user_id = auth.uid())
      or (public.current_user_role() <> 'si' and public.branch_in_scope(t.branch_id))
    )
  ));

create or replace function public.set_device_si_assignment(
  p_device_id uuid,
  p_si_user_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_si uuid;
  new_assignment_id uuid;
begin
  if auth.uid() is null or public.current_user_role() <> 'head_office' then
    raise exception 'Head Office role is required';
  end if;

  perform 1 from public.devices where id = p_device_id for update;
  if not found then
    raise exception 'Device not found';
  end if;
  if p_si_user_id is not null and not exists (
    select 1 from public.profiles where id = p_si_user_id and role = 'si'
  ) then
    raise exception 'Selected user is not a System Integrator';
  end if;

  select si_user_id into previous_si from public.device_si_assignments
    where device_id = p_device_id and is_active for update;
  if previous_si is not distinct from p_si_user_id then
    return null;
  end if;

  update public.device_si_assignments
    set is_active = false, ended_at = now(), ended_by = auth.uid()
    where device_id = p_device_id and is_active;

  if p_si_user_id is not null then
    insert into public.device_si_assignments (device_id, si_user_id, assigned_by)
    values (p_device_id, p_si_user_id, auth.uid())
    returning id into new_assignment_id;
  end if;

  insert into public.device_assignment_events (
    device_id, previous_si_user_id, new_si_user_id, actor_id
  ) values (p_device_id, previous_si, p_si_user_id, auth.uid());

  return new_assignment_id;
end;
$$;
revoke all on function public.set_device_si_assignment(uuid, uuid) from public, anon;
grant execute on function public.set_device_si_assignment(uuid, uuid) to authenticated;

create or replace function public.apply_device_si_assignment_to_ticket()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  assigned_si uuid;
  assigned_name text;
  assigned_email text;
begin
  if new.device_id is not null then
    select dsa.si_user_id, p.name, p.email
      into assigned_si, assigned_name, assigned_email
    from public.device_si_assignments dsa
    join public.profiles p on p.id = dsa.si_user_id
    where dsa.device_id = new.device_id and dsa.is_active;
    if found then
      new.si_user_id := assigned_si;
      new.assigned_si_name := assigned_name;
      new.assigned_si_email := assigned_email;
    end if;
  end if;
  return new;
end;
$$;
create trigger tickets_use_device_si_assignment
  before insert on public.tickets
  for each row execute function public.apply_device_si_assignment_to_ticket();

-- Keep the stated five-device-per-branch limit safe under concurrent writes.
create or replace function public.enforce_branch_device_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  device_count integer;
begin
  perform 1 from public.branches where id = new.branch_id for update;
  if tg_op = 'INSERT' then
    select count(*) into device_count from public.devices where branch_id = new.branch_id;
    if device_count >= 5 then
      raise exception 'A branch can have no more than five devices';
    end if;
  elsif old.branch_id is distinct from new.branch_id then
    select count(*) into device_count from public.devices
      where branch_id = new.branch_id and id <> new.id;
    if device_count >= 5 then
      raise exception 'A branch can have no more than five devices';
    end if;
  end if;
  return new;
end;
$$;
create trigger devices_enforce_branch_limit
  before insert or update of branch_id on public.devices
  for each row execute function public.enforce_branch_device_limit();

-- Prefer the device-specific SI when opening new tickets, while preserving
-- legacy branch assignments as a fallback.
create or replace function public.create_ticket_api(
  p_branch_code text,
  p_note text default null,
  p_device_serial text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_branch public.branches%rowtype;
  target_device public.devices%rowtype;
  assigned_si uuid;
  new_ticket_id uuid;
  new_ticket_number text;
  clean_note text;
  clean_device_serial text;
  caller_role public.user_role;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  p_branch_code := btrim(coalesce(p_branch_code, ''));
  if p_branch_code = '' or length(p_branch_code) > 50 then raise exception 'A valid branch code is required'; end if;
  clean_note := nullif(btrim(coalesce(p_note, '')), '');
  if clean_note is not null and length(clean_note) > 2000 then raise exception 'Note cannot exceed 2000 characters'; end if;
  clean_device_serial := nullif(btrim(coalesce(p_device_serial, '')), '');
  if clean_device_serial is not null and length(clean_device_serial) > 200 then raise exception 'Device serial cannot exceed 200 characters'; end if;

  select * into target_branch from public.branches where lower(code) = lower(p_branch_code);
  if not found then raise exception 'Branch not found'; end if;
  if not public.branch_in_scope(target_branch.id) then raise exception 'Branch is outside the caller''s scope'; end if;
  if clean_device_serial is not null then
    select * into target_device from public.devices where branch_id = target_branch.id and lower(serial_number) = lower(clean_device_serial);
    if not found then raise exception 'Device not found for this branch'; end if;
  end if;

  if target_device.id is not null then
    select si_user_id into assigned_si from public.device_si_assignments where device_id = target_device.id and is_active;
  end if;
  if assigned_si is null then
    select si_user_id into assigned_si from public.branch_si_assignments
      where branch_id = target_branch.id and is_active order by assigned_at desc limit 1;
  end if;

  caller_role := public.current_user_role();
  insert into public.tickets (branch_id, device_id, si_user_id, status, escalation_level)
  values (target_branch.id, target_device.id, assigned_si, 'open', 0)
  returning id, ticket_number into new_ticket_id, new_ticket_number;
  insert into public.ticket_events (ticket_id, event_type, actor_id, actor_role, note)
  values (new_ticket_id, 'created', auth.uid(), caller_role, coalesce(clean_note, 'Ticket created through the ticket API'));
  return jsonb_build_object('ticket_id', new_ticket_id, 'ticket_number', new_ticket_number,
    'status', 'open', 'branch_code', target_branch.code, 'branch_name', target_branch.name,
    'device_serial', target_device.serial_number, 'si_user_id', assigned_si, 'note', clean_note);
end;
$$;
revoke all on function public.create_ticket_api(text, text, text) from public, anon;
grant execute on function public.create_ticket_api(text, text, text) to authenticated;
