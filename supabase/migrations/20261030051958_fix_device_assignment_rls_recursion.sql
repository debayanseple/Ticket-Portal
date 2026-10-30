-- Avoid the RLS cycle between devices_scope_read and the assignment scope
-- policy by performing the devices lookup in a private SECURITY DEFINER helper.
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

drop policy if exists device_si_assignments_read_scope on public.device_si_assignments;
create policy device_si_assignments_read_scope on public.device_si_assignments
  for select to authenticated
  using (
    public.current_user_role() = 'head_office'
    or (public.current_user_role() = 'si' and si_user_id = (select auth.uid()))
    or (public.current_user_role() <> 'si' and private.device_in_scope(device_id))
  );
