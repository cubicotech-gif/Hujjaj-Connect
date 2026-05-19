-- ============================================================
--  Hujjaj Connect — Supabase schema
--  Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

create extension if not exists pgcrypto;

-- ---- Pilgrims --------------------------------------------------
create table if not exists pilgrims (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default '',
  phone       text not null default '',
  bus         text default '',
  hotel       text default '',
  room        text default '',
  grp         text default '',
  notes       text default '',
  checkin_at  date,
  checkout_at date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- Additive migrations (safe to re-run)
alter table pilgrims add column if not exists checkin_at  date;
alter table pilgrims add column if not exists checkout_at date;
alter table pilgrims add column if not exists family      text  not null default '';
alter table pilgrims add column if not exists log         jsonb not null default '[]'::jsonb;
create index if not exists pilgrims_family_idx on pilgrims (family) where family <> '';
create index if not exists pilgrims_name_idx  on pilgrims using gin (to_tsvector('simple', coalesce(name,'')));
create index if not exists pilgrims_phone_idx on pilgrims (phone);

-- ---- Message templates ----------------------------------------
create table if not exists templates (
  id         uuid primary key default gen_random_uuid(),
  title      text not null default 'Template',
  body       text not null default '',
  sort       int  not null default 0,
  created_at timestamptz not null default now()
);

-- ---- Single-row app config ------------------------------------
create table if not exists app_config (
  id              int  primary key default 1 check (id = 1),
  country_code    text not null default '92',
  bulk_delay_sec  int  not null default 5
);
insert into app_config (id) values (1) on conflict (id) do nothing;
alter table app_config add column if not exists bulk_delay_sec int not null default 5;

-- ---- updated_at trigger ---------------------------------------
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_pilgrims_touch on pilgrims;
create trigger trg_pilgrims_touch before update on pilgrims
for each row execute function touch_updated_at();

-- ---- Row Level Security (OPEN — no login) ---------------------
-- This app runs with no authentication. RLS stays ON so it is easy
-- to lock down later, but anon (anyone with the anon key) has full
-- access. Treat the deployed URL as the only thing between the
-- public and this data.
alter table pilgrims   enable row level security;
alter table templates  enable row level security;
alter table app_config enable row level security;

drop policy if exists "auth pilgrims"  on pilgrims;
drop policy if exists "auth templates" on templates;
drop policy if exists "auth read cfg"  on app_config;
drop policy if exists "auth upd cfg"   on app_config;
drop policy if exists "open pilgrims"  on pilgrims;
drop policy if exists "open templates" on templates;
drop policy if exists "open cfg"       on app_config;

create policy "open pilgrims"  on pilgrims   for all to anon, authenticated using (true) with check (true);
create policy "open templates" on templates  for all to anon, authenticated using (true) with check (true);
create policy "open cfg"       on app_config for all to anon, authenticated using (true) with check (true);

-- ---- Realtime --------------------------------------------------
alter publication supabase_realtime add table pilgrims;
alter publication supabase_realtime add table templates;
alter publication supabase_realtime add table app_config;

-- ---- Seed default templates -----------------------------------
insert into templates (title, body, sort)
select * from (values
 ('Hotel & room info',
  'Assalam o Alaikum {name}. Billoo Travels ki taraf se. Aap ka hotel: {hotel}, Room: {room}, Bus: {bus}. Kisi bhi madad ke liye isi number par rabta karein. JazakAllah.', 0),
 ('Departure reminder',
  'Assalam o Alaikum {name}. Departure ki tafseelat — Bus: {bus}. Baraye meharbani waqt par tayyar rahein. Shukriya.', 1)
) as t
where not exists (select 1 from templates);

-- ============================================================
--  No auth needed. After running this, the app works as soon as
--  the two NEXT_PUBLIC_SUPABASE_* env vars are set in Vercel.
-- ============================================================
