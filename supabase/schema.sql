-- Run this in the Supabase SQL Editor for a new project.
create table if not exists public.shared_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  owner_id uuid not null references auth.users(id) on delete cascade,
  invite_code text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);

create table if not exists public.schedule_members (
  schedule_id uuid not null references public.shared_schedules(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  primary key (schedule_id, user_id)
);

create table if not exists public.schedule_data (
  schedule_id uuid primary key references public.shared_schedules(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null,
  user_id uuid not null,
  endpoint text not null unique,
  subscription jsonb not null,
  reminder_time time not null default '20:00',
  reminder_offset text not null default 'day_before' check (reminder_offset in ('day_before', 'same_day')),
  timezone text not null default 'Asia/Bangkok',
  enabled boolean not null default true,
  last_sent_for_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (schedule_id, user_id)
    references public.schedule_members(schedule_id, user_id) on delete cascade
);

-- Name chosen in "ฉันคือ" on that device; reminders only include duties assigned to it (or unassigned).
alter table public.push_subscriptions add column if not exists member_name text check (char_length(member_name) <= 30);

create index if not exists push_subscriptions_due_idx
  on public.push_subscriptions (enabled, schedule_id)
  where enabled;

alter table public.shared_schedules enable row level security;
alter table public.schedule_members enable row level security;
alter table public.schedule_data enable row level security;
alter table public.push_subscriptions enable row level security;

revoke all on public.shared_schedules, public.schedule_members, public.schedule_data, public.push_subscriptions from anon, public;
grant select on public.shared_schedules, public.schedule_members to authenticated;
grant select, insert, update on public.schedule_data to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

drop policy if exists shared_schedules_read_member on public.shared_schedules;
create policy shared_schedules_read_member on public.shared_schedules
  for select to authenticated
  using (exists (
    select 1 from public.schedule_members m
    where m.schedule_id = shared_schedules.id and m.user_id = auth.uid()
  ));

drop policy if exists schedule_members_read_self on public.schedule_members;
create policy schedule_members_read_self on public.schedule_members
  for select to authenticated using (user_id = auth.uid());

drop policy if exists schedule_data_read_member on public.schedule_data;
create policy schedule_data_read_member on public.schedule_data
  for select to authenticated using (exists (
    select 1 from public.schedule_members m
    where m.schedule_id = schedule_data.schedule_id and m.user_id = auth.uid()
  ));

drop policy if exists schedule_data_insert_member on public.schedule_data;
create policy schedule_data_insert_member on public.schedule_data
  for insert to authenticated with check (exists (
    select 1 from public.schedule_members m
    where m.schedule_id = schedule_data.schedule_id and m.user_id = auth.uid()
  ));

drop policy if exists schedule_data_update_member on public.schedule_data;
create policy schedule_data_update_member on public.schedule_data
  for update to authenticated
  using (exists (
    select 1 from public.schedule_members m
    where m.schedule_id = schedule_data.schedule_id and m.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.schedule_members m
    where m.schedule_id = schedule_data.schedule_id and m.user_id = auth.uid()
  ));

drop policy if exists push_subscriptions_select_self on public.push_subscriptions;
create policy push_subscriptions_select_self on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists push_subscriptions_insert_self on public.push_subscriptions;
create policy push_subscriptions_insert_self on public.push_subscriptions
  for insert to authenticated with check (
    user_id = (select auth.uid()) and exists (
      select 1 from public.schedule_members m
      where m.schedule_id = push_subscriptions.schedule_id and m.user_id = (select auth.uid())
    )
  );

drop policy if exists push_subscriptions_update_self on public.push_subscriptions;
create policy push_subscriptions_update_self on public.push_subscriptions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid()) and exists (
      select 1 from public.schedule_members m
      where m.schedule_id = push_subscriptions.schedule_id and m.user_id = (select auth.uid())
    )
  );

drop policy if exists push_subscriptions_delete_self on public.push_subscriptions;
create policy push_subscriptions_delete_self on public.push_subscriptions
  for delete to authenticated using (user_id = (select auth.uid()));

create or replace function public.create_shared_schedule(p_name text, p_payload jsonb)
returns table (schedule_id uuid, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid := gen_random_uuid();
  new_code text := replace(gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Schedule name required'; end if;

  insert into public.shared_schedules (id, name, owner_id, invite_code)
  values (new_id, trim(p_name), auth.uid(), new_code);
  insert into public.schedule_members (schedule_id, user_id, role)
  values (new_id, auth.uid(), 'owner');
  insert into public.schedule_data (schedule_id, payload)
  values (new_id, coalesce(p_payload, '{}'::jsonb));

  return query select new_id, new_code;
end;
$$;

create or replace function public.join_shared_schedule(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select id into target_id from public.shared_schedules
  where invite_code = lower(trim(coalesce(p_invite_code, '')));
  if target_id is null then raise exception 'Invalid invite code'; end if;

  insert into public.schedule_members (schedule_id, user_id, role)
  values (target_id, auth.uid(), 'editor')
  on conflict (schedule_id, user_id) do nothing;
  return target_id;
end;
$$;

revoke all on function public.create_shared_schedule(text, jsonb) from public;
revoke all on function public.join_shared_schedule(text) from public;
grant execute on function public.create_shared_schedule(text, jsonb) to authenticated;
grant execute on function public.join_shared_schedule(text) to authenticated;
