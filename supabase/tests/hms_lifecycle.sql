-- Run only against a disposable hosted development project after migrations.
-- This integration check rolls back every fixture and exercises the database
-- transaction boundaries used by the HMS Edge Function.
begin;

do $$
<<test>>
declare
  test_key text := replace(gen_random_uuid()::text, '-', '');
  nbg_id uuid;
  zone_id uuid;
  branch_id uuid;
  device_id uuid;
  first_fault jsonb;
  retry_fault jsonb;
  related_fault jsonb;
  unmatched_restore jsonb;
  resolved_restore jsonb;
  duplicate_restore jsonb;
  new_fault jsonb;
  escalation_fault jsonb;
  result_count integer;
  ticket_id uuid;
  second_ticket_id uuid;
begin
  insert into public.nbgs (name, code) values ('HMS lifecycle test', 'T-' || test_key)
    returning id into nbg_id;
  insert into public.zones (nbg_id, name, code) values (nbg_id, 'HMS lifecycle test', 'T-' || test_key)
    returning id into zone_id;
  insert into public.branches (zone_id, name, code, external_key)
    values (zone_id, 'HMS lifecycle test', 'T-' || test_key, 'branch-' || test_key)
    returning id into branch_id;
  insert into public.devices (branch_id, type, serial_number, external_key)
    values (branch_id, 'CCTV', 'T-' || test_key, 'device-' || test_key)
    returning id into device_id;

  first_fault := public.process_hms_fault(
    'fault-' || test_key, 'branch-' || test_key, 'device-' || test_key,
    'Camera offline', now(), jsonb_build_object('event_id', 'fault-' || test_key)
  );
  ticket_id := (first_fault->>'ticket_id')::uuid;
  if first_fault->>'processing_result' <> 'processed' or ticket_id is null then
    raise exception 'fault event did not create a ticket: %', first_fault;
  end if;

  retry_fault := public.process_hms_fault(
    'fault-' || test_key, 'branch-' || test_key, 'device-' || test_key,
    'Camera offline', now(), '{}'::jsonb
  );
  if retry_fault->>'duplicate' <> 'true' or (retry_fault->>'ticket_id')::uuid <> ticket_id then
    raise exception 'fault retry was not idempotent: %', retry_fault;
  end if;

  related_fault := public.process_hms_fault(
    'related-' || test_key, 'branch-' || test_key, 'device-' || test_key,
    'Camera signal unstable', now(), '{}'::jsonb
  );
  if related_fault->>'existing_open_ticket' <> 'true' or (related_fault->>'ticket_id')::uuid <> ticket_id then
    raise exception 'distinct open-device fault did not append to existing ticket: %', related_fault;
  end if;
  if not exists (
    select 1 from public.ticket_events e where e.ticket_id = test.ticket_id and e.event_type = 'hms_fault_related'
  ) then raise exception 'related fault audit event was not written'; end if;

  unmatched_restore := public.process_hms_restoration(
    'unmatched-restore-' || test_key, 'unknown-fault-' || test_key,
    now(), '{}'::jsonb
  );
  if unmatched_restore->>'processing_result' <> 'unmatched' then
    raise exception 'unmatched restoration was not controlled: %', unmatched_restore;
  end if;

  resolved_restore := public.process_hms_restoration(
    'restore-' || test_key, 'fault-' || test_key, now(), '{}'::jsonb
  );
  if resolved_restore->>'processing_result' <> 'resolved' then
    raise exception 'correlated restoration did not resolve its ticket: %', resolved_restore;
  end if;
  duplicate_restore := public.process_hms_restoration(
    'restore-' || test_key, 'fault-' || test_key, now(), '{}'::jsonb
  );
  if duplicate_restore->>'duplicate' <> 'true' then
    raise exception 'restoration retry was not idempotent: %', duplicate_restore;
  end if;

  new_fault := public.process_hms_fault(
    'after-restore-' || test_key, 'branch-' || test_key, 'device-' || test_key,
    'Camera failed again', now(), '{}'::jsonb
  );
  second_ticket_id := (new_fault->>'ticket_id')::uuid;
  if second_ticket_id is null or second_ticket_id = ticket_id or new_fault->>'existing_open_ticket' = 'true' then
    raise exception 'fault after resolution did not create a new ticket: %', new_fault;
  end if;

  escalation_fault := public.process_hms_fault(
    'escalation-' || test_key, 'branch-' || test_key, 'device-' || test_key,
    'Camera fault after restoration', now(), '{}'::jsonb
  );
  second_ticket_id := (escalation_fault->>'ticket_id')::uuid;
  update public.tickets set created_at = now() - interval '25 hours' where id = second_ticket_id;
  perform public.escalate_tickets();
  if (select escalation_level from public.tickets where id = second_ticket_id) <> 1 then
    raise exception '24 hour threshold did not produce level 1';
  end if;
  update public.tickets set created_at = now() - interval '49 hours' where id = second_ticket_id;
  perform public.escalate_tickets();
  update public.tickets set created_at = now() - interval '73 hours' where id = second_ticket_id;
  perform public.escalate_tickets();
  perform public.escalate_tickets();
  select count(*) into result_count from public.ticket_escalations where ticket_id = second_ticket_id;
  if result_count <> 3 then raise exception 'escalation thresholds were not recorded exactly once: %', result_count; end if;

  update public.tickets set status = 'resolved', resolved_at = now(), escalation_level = 0
    where id = ticket_id;
  perform public.escalate_tickets();
  if (select escalation_level from public.tickets where id = ticket_id) <> 0 or exists (
    select 1 from public.ticket_escalations e where e.ticket_id = test.ticket_id
  ) then raise exception 'resolved ticket was escalated'; end if;
end;
$$;

rollback;
