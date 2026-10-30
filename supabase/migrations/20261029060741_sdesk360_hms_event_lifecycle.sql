-- Preserve existing records while adding idempotent HMS event handling.
alter table public.branches
  add column if not exists external_key text;

alter table public.devices
  add column if not exists external_key text;

create unique index if not exists branches_external_key_unique
  on public.branches(external_key) where external_key is not null;
create unique index if not exists devices_external_key_unique
  on public.devices(external_key) where external_key is not null;

alter table public.branch_si_assignments
  add column if not exists ended_at timestamptz,
  add column if not exists ended_by uuid references public.profiles(id);

-- Assignment writes must go through the audited, role-checking RPC below.
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
create policy branch_assignment_events_ho_read on public.branch_assignment_events
  for select to authenticated
  using (public.current_user_role() = 'head_office');
create index if not exists branch_assignment_events_recent_idx
  on public.branch_assignment_events(changed_at desc);

create or replace function public.set_branch_si_assignment(
  p_branch_id uuid,
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

  if not exists (select 1 from public.branches where id = p_branch_id) then
    raise exception 'Branch not found';
  end if;
  if p_si_user_id is not null and not exists (
    select 1 from public.profiles where id = p_si_user_id and role = 'si'
  ) then
    raise exception 'Selected user is not a System Integrator';
  end if;

  perform 1 from public.branches where id = p_branch_id for update;
  select si_user_id into previous_si from public.branch_si_assignments
    where branch_id = p_branch_id and is_active
    order by assigned_at desc limit 1 for update;

  if previous_si is not distinct from p_si_user_id then
    return null;
  end if;

  update public.branch_si_assignments
    set is_active = false, ended_at = now(), ended_by = auth.uid()
    where branch_id = p_branch_id and is_active;

  if p_si_user_id is not null then
    insert into public.branch_si_assignments (branch_id, si_user_id, assigned_by, is_active)
      values (p_branch_id, p_si_user_id, auth.uid(), true)
      returning id into new_assignment_id;
  end if;

  insert into public.branch_assignment_events (
    branch_id, previous_si_user_id, new_si_user_id, actor_id
  ) values (p_branch_id, previous_si, p_si_user_id, auth.uid());

  return new_assignment_id;
end;
$$;

revoke all on function public.set_branch_si_assignment(uuid, uuid)
  from public, anon;
grant execute on function public.set_branch_si_assignment(uuid, uuid)
  to authenticated;

alter table public.tickets
  add column if not exists issue_description text not null default '',
  add column if not exists source_system text,
  add column if not exists source_event_id text,
  add column if not exists assigned_si_name text,
  add column if not exists assigned_si_email text;

create unique index if not exists tickets_source_event_unique
  on public.tickets(source_system, source_event_id)
  where source_system is not null and source_event_id is not null;
create index if not exists tickets_si_created_idx
  on public.tickets(si_user_id, created_at desc);
create index if not exists tickets_device_created_idx
  on public.tickets(device_id, created_at desc);

create table if not exists public.hms_events (
  id uuid primary key default gen_random_uuid(),
  source_system text not null default 'hms',
  source_event_id text not null,
  event_type text not null check (event_type in ('fault', 'restoration')),
  correlation_event_id text,
  branch_key text,
  device_key text,
  issue_description text,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  processing_status text not null default 'processing'
    check (processing_status in ('processing', 'processed', 'unmatched')),
  ticket_id uuid references public.tickets(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  unique (source_system, source_event_id)
);

create table if not exists public.ticket_escalations (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  escalation_level integer not null check (escalation_level between 1 and 3),
  due_at timestamptz not null,
  processed_at timestamptz not null default now(),
  recipient text,
  email_outcome text not null default 'queued'
    check (email_outcome in ('queued', 'sent', 'failed', 'not_configured', 'cancelled')),
  email_outbox_id uuid references public.email_outbox(id) on delete set null,
  unique (ticket_id, escalation_level)
);

create index if not exists hms_events_ticket_received_idx
  on public.hms_events(ticket_id, received_at desc) where ticket_id is not null;
create index if not exists ticket_escalations_due_idx
  on public.ticket_escalations(due_at, ticket_id);

alter table public.hms_events enable row level security;
alter table public.ticket_escalations enable row level security;

revoke all on public.hms_events, public.ticket_escalations from anon, authenticated;
grant select on public.hms_events, public.ticket_escalations to authenticated;
grant all on public.hms_events, public.ticket_escalations to service_role;

create policy hms_events_scoped_read on public.hms_events
  for select to authenticated
  using (
    public.current_user_role() = 'head_office'
    or (ticket_id is not null and exists (
      select 1 from public.tickets t
      where t.id = hms_events.ticket_id and public.branch_in_scope(t.branch_id)
    ))
  );

create policy ticket_escalations_scoped_read on public.ticket_escalations
  for select to authenticated
  using (
    public.current_user_role() = 'head_office'
    or exists (
      select 1 from public.tickets t
      where t.id = ticket_escalations.ticket_id and public.branch_in_scope(t.branch_id)
    )
  );

-- Let scoped portal users see the SI names attached to branches/tickets in
-- their own scope, while keeping unrelated SI profiles private.
create policy profiles_si_assignment_scope_read on public.profiles
  for select to authenticated
  using (
    role = 'si'
    and exists (
      select 1 from public.branch_si_assignments bsa
      where bsa.si_user_id = profiles.id and bsa.is_active
        and public.branch_in_scope(bsa.branch_id)
    )
  );

-- Fault event and its ticket/audit record are one transaction. The source event
-- namespace is global per source_system, so HMS event IDs must be unique across
-- all panels. A second distinct fault on an already-open device is appended to
-- that ticket's history; it does not create a parallel active ticket.
create or replace function public.process_hms_fault(
  p_source_event_id text,
  p_branch_key text,
  p_device_key text,
  p_issue_description text,
  p_occurred_at timestamptz,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_row public.hms_events%rowtype;
  target_branch public.branches%rowtype;
  target_device public.devices%rowtype;
  target_ticket public.tickets%rowtype;
  assigned_si uuid;
  assigned_name text;
  assigned_email text;
  result_body jsonb;
  reused_ticket boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext('hms:event:' || p_source_event_id));

  insert into public.hms_events (
    source_event_id, event_type, branch_key, device_key,
    issue_description, occurred_at, payload
  ) values (
    p_source_event_id, 'fault', p_branch_key, p_device_key,
    p_issue_description, p_occurred_at, coalesce(p_payload, '{}'::jsonb)
  ) on conflict (source_system, source_event_id) do nothing
  returning * into event_row;

  if not found then
    select * into event_row from public.hms_events
    where source_system = 'hms' and source_event_id = p_source_event_id;
    return coalesce(event_row.result, jsonb_build_object(
      'event_id', p_source_event_id,
      'processing_result', event_row.processing_status,
      'ticket_id', event_row.ticket_id
    )) || jsonb_build_object('duplicate', true);
  end if;

  select * into target_branch from public.branches
  where external_key = p_branch_key;
  if not found then
    select * into target_branch from public.branches where code = p_branch_key;
  end if;

  if not found then
    result_body := jsonb_build_object(
      'event_id', p_source_event_id, 'processing_result', 'unmatched',
      'reason', 'branch_not_found'
    );
    update public.hms_events set processing_status = 'unmatched', result = result_body
      where id = event_row.id;
    return result_body;
  end if;

  select * into target_device from public.devices
  where branch_id = target_branch.id and external_key = p_device_key;
  if not found then
    select * into target_device from public.devices
    where branch_id = target_branch.id and serial_number = p_device_key;
  end if;

  if not found then
    result_body := jsonb_build_object(
      'event_id', p_source_event_id, 'processing_result', 'unmatched',
      'reason', 'device_not_found_for_branch', 'branch_id', target_branch.id
    );
    update public.hms_events set processing_status = 'unmatched', result = result_body
      where id = event_row.id;
    return result_body;
  end if;

  perform pg_advisory_xact_lock(hashtext('hms:device:' || target_device.id::text));

  select t.* into target_ticket from public.tickets t
  where t.device_id = target_device.id and t.status = 'open'
  order by t.created_at desc limit 1 for update;

  if found then
    reused_ticket := true;
    update public.tickets set
      issue_description = concat_ws(E'\n', nullif(issue_description, ''), p_issue_description),
      updated_at = now()
    where id = target_ticket.id returning * into target_ticket;

    insert into public.ticket_events (ticket_id, event_type, note)
    values (target_ticket.id, 'hms_fault_related',
      'HMS fault event ' || p_source_event_id || ' appended to the existing open ticket.');
  else
    select bsa.si_user_id, p.name, p.email
      into assigned_si, assigned_name, assigned_email
    from public.branch_si_assignments bsa
    join public.profiles p on p.id = bsa.si_user_id
    where bsa.branch_id = target_branch.id and bsa.is_active
    order by bsa.assigned_at desc limit 1;

    insert into public.tickets (
      branch_id, device_id, si_user_id, status, escalation_level,
      issue_description, source_system, source_event_id,
      assigned_si_name, assigned_si_email
    ) values (
      target_branch.id, target_device.id, assigned_si, 'open', 0,
      p_issue_description, 'hms', p_source_event_id,
      assigned_name, assigned_email
    ) returning * into target_ticket;

    insert into public.ticket_events (ticket_id, event_type, note)
    values (target_ticket.id, 'created',
      'Created from HMS fault event ' || p_source_event_id || '.');
  end if;

  result_body := jsonb_build_object(
    'event_id', p_source_event_id,
    'processing_result', 'processed',
    'ticket_id', target_ticket.id,
    'ticket_number', target_ticket.ticket_number,
    'existing_open_ticket', reused_ticket
  );
  update public.hms_events set processing_status = 'processed',
    ticket_id = target_ticket.id, result = result_body
    where id = event_row.id;
  return result_body;
end;
$$;

create or replace function public.process_hms_restoration(
  p_source_event_id text,
  p_correlation_event_id text,
  p_occurred_at timestamptz,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_row public.hms_events%rowtype;
  target_ticket public.tickets%rowtype;
  fault_event public.hms_events%rowtype;
  result_body jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('hms:event:' || p_source_event_id));

  insert into public.hms_events (
    source_event_id, event_type, correlation_event_id, occurred_at, payload
  ) values (
    p_source_event_id, 'restoration', p_correlation_event_id,
    p_occurred_at, coalesce(p_payload, '{}'::jsonb)
  ) on conflict (source_system, source_event_id) do nothing
  returning * into event_row;

  if not found then
    select * into event_row from public.hms_events
    where source_system = 'hms' and source_event_id = p_source_event_id;
    return coalesce(event_row.result, jsonb_build_object(
      'event_id', p_source_event_id,
      'processing_result', event_row.processing_status,
      'ticket_id', event_row.ticket_id
    )) || jsonb_build_object('duplicate', true);
  end if;

  select * into fault_event from public.hms_events
  where source_system = 'hms' and source_event_id = p_correlation_event_id
    and event_type = 'fault';

  if not found or fault_event.ticket_id is null then
    result_body := jsonb_build_object(
      'event_id', p_source_event_id, 'processing_result', 'unmatched',
      'reason', 'fault_event_not_found', 'correlation_event_id', p_correlation_event_id
    );
    update public.hms_events set processing_status = 'unmatched', result = result_body
      where id = event_row.id;
    return result_body;
  end if;

  select * into target_ticket from public.tickets
  where id = fault_event.ticket_id for update;

  if not found then
    result_body := jsonb_build_object(
      'event_id', p_source_event_id, 'processing_result', 'unmatched',
      'reason', 'ticket_not_found'
    );
    update public.hms_events set processing_status = 'unmatched', result = result_body
      where id = event_row.id;
    return result_body;
  end if;

  if target_ticket.status = 'open' then
    update public.tickets set status = 'resolved', resolved_at = coalesce(p_occurred_at, now()),
      resolved_by = null, resolution_note = 'Restored by HMS event ' || p_source_event_id,
      updated_at = now()
    where id = target_ticket.id;

    insert into public.ticket_events (ticket_id, event_type, note)
    values (target_ticket.id, 'resolved',
      'Resolved by HMS restoration event ' || p_source_event_id || '.');
    result_body := jsonb_build_object(
      'event_id', p_source_event_id, 'processing_result', 'resolved',
      'ticket_id', target_ticket.id, 'ticket_number', target_ticket.ticket_number
    );
  else
    result_body := jsonb_build_object(
      'event_id', p_source_event_id, 'processing_result', 'already_resolved',
      'ticket_id', target_ticket.id, 'ticket_number', target_ticket.ticket_number
    );
  end if;

  update public.hms_events set processing_status = 'processed',
    ticket_id = target_ticket.id, result = result_body
    where id = event_row.id;
  return result_body;
end;
$$;

revoke all on function public.process_hms_fault(text, text, text, text, timestamptz, jsonb)
  from public, anon, authenticated;
revoke all on function public.process_hms_restoration(text, text, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.process_hms_fault(text, text, text, text, timestamptz, jsonb)
  to service_role;
grant execute on function public.process_hms_restoration(text, text, timestamptz, jsonb)
  to service_role;

-- pg_cron runs this function in the hosted database; there is no public
-- scheduled HTTP endpoint to call. Unique (ticket_id, level) rows make every
-- threshold idempotent even if the scheduler retries.
create or replace function public.escalate_tickets() returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  rec record;
  target_level integer;
  level_to_process integer;
  due_time timestamptz;
  escalation_id uuid;
  email_id uuid;
  recipient_email text;
  recipient_name text;
begin
  for rec in
    select t.id, t.ticket_number, t.created_at, t.escalation_level,
      t.assigned_si_email, t.assigned_si_name, t.si_user_id
    from public.tickets t
    where t.status = 'open' and t.escalation_level < 3
      and t.created_at <= now() - interval '24 hours'
    order by t.created_at
    for update of t skip locked
  loop
    target_level := case
      when now() >= rec.created_at + interval '72 hours' then 3
      when now() >= rec.created_at + interval '48 hours' then 2
      else 1
    end;

    select coalesce(rec.assigned_si_email, p.email), coalesce(rec.assigned_si_name, p.name)
      into recipient_email, recipient_name
    from public.profiles p where p.id = rec.si_user_id;
    if rec.si_user_id is null then
      recipient_email := rec.assigned_si_email;
      recipient_name := rec.assigned_si_name;
    end if;

    for level_to_process in rec.escalation_level + 1..target_level loop
      due_time := rec.created_at + make_interval(hours => 24 * level_to_process);
      escalation_id := null;
      insert into public.ticket_escalations (
        ticket_id, escalation_level, due_at, recipient,
        email_outcome
      ) values (
        rec.id, level_to_process, due_time, recipient_email,
        case when recipient_email is null then 'not_configured' else 'queued' end
      ) on conflict (ticket_id, escalation_level) do nothing
      returning id into escalation_id;

      if escalation_id is not null then
        insert into public.ticket_events (ticket_id, event_type, note)
        values (rec.id, 'escalated', 'Escalation level ' || level_to_process || ' at the 24/48/72 hour threshold.');

        if recipient_email is not null then
          insert into public.email_outbox (ticket_id, to_email, subject, body)
          values (
            rec.id, recipient_email,
            'SDesk360: Level ' || level_to_process || ' warning - ticket ' || rec.ticket_number,
            'Dear ' || coalesce(recipient_name, 'SI') || ', ticket ' || rec.ticket_number ||
              ' remains open and has reached escalation level ' || level_to_process || '.'
          ) returning id into email_id;
          update public.ticket_escalations
            set email_outbox_id = email_id where id = escalation_id;
        end if;
      end if;
    end loop;

    update public.tickets set escalation_level = target_level, updated_at = now()
      where id = rec.id and status = 'open';
  end loop;
end;
$$;

revoke all on function public.escalate_tickets() from public, anon, authenticated;

-- The mail worker is an HTTP Edge Function. Store these two values in Vault
-- before this scheduled job is active: `sdesk360_function_url` should be the
-- project URL and `sdesk360_scheduled_secret` must match the function secret.
select cron.schedule(
  'send-emails-every-5min',
  '*/5 * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'sdesk360_function_url') || '/functions/v1/send-emails',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sdesk360_scheduled_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);
