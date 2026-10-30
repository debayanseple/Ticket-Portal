-- Migration 0007: HMS device relationships.
-- HMS owns device-health monitoring and sends events to SDesk360. Keep the
-- existing inventory and status history intact; never reseed customer rows.

-- Stop the legacy 24-hour status poll. Fault tickets are now created when HMS
-- sends its event, while escalation remains scheduled separately.
do $$
begin
  perform cron.unschedule('generate-tickets-every-5min');
exception when others then
  null;
end $$;

drop function if exists public.generate_tickets();

alter table public.devices
  add column if not exists hms_panel_id uuid references public.devices(id);

create index if not exists idx_devices_hms_panel
  on public.devices(hms_panel_id)
  where hms_panel_id is not null;
