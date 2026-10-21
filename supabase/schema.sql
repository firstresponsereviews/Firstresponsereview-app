-- First Response database schema for Supabase.
-- Run once in Supabase: SQL Editor → New query → paste this file → Run.
-- Row-level security makes sure each business only ever sees its own data,
-- and only First Response staff can see everything.

create extension if not exists pgcrypto;

-- People -----------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'client' check (role in ('client', 'staff')),
  created_at timestamptz not null default now()
);

-- Businesses (one per client location group) -----------------------------
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,
  phone text,
  locations text,
  plan text,
  review_sites text,
  owner_email text,
  status text not null default 'onboarding'
    check (status in ('onboarding', 'in_review', 'active', 'paused')),
  guidelines jsonb,
  guidelines_submitted_at timestamptz,
  guidelines_approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'manager', 'agency')),
  created_at timestamptz not null default now(),
  primary key (user_id, business_id)
);
create index if not exists memberships_business on public.memberships (business_id);

-- Reviews and replies ------------------------------------------------------
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  platform text not null check (platform in ('Google', 'Yelp', 'Trustpilot', 'G2')),
  external_id text,
  author text not null,
  rating int not null check (rating between 1 and 5),
  body text not null default '',
  posted_at timestamptz not null default now(),
  -- new: needs a reply · approved: reply approved, waiting to be posted · posted: live
  status text not null default 'new' check (status in ('new', 'approved', 'posted')),
  flag text,
  reply text,
  replied_at timestamptz,
  replied_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (business_id, platform, external_id)
);
create index if not exists reviews_business_posted on public.reviews (business_id, posted_at desc);

-- Monthly insight reports --------------------------------------------------
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft', 'sent')),
  summary text not null default '',
  stats jsonb not null default '{}'::jsonb,
  insights jsonb not null default '[]'::jsonb,
  approved_by uuid references auth.users(id),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, period_start)
);

-- Helpers (security definer so policies can call them without recursion) ---
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'staff');
$$;

create or replace function public.is_member(bid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships where user_id = auth.uid() and business_id = bid);
$$;

-- Every new login gets a profile row.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Row-level security -------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.memberships enable row level security;
alter table public.reviews enable row level security;
alter table public.reports enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.is_staff());

drop policy if exists businesses_read on public.businesses;
create policy businesses_read on public.businesses for select to authenticated
  using (public.is_member(id) or public.is_staff());
drop policy if exists businesses_staff_update on public.businesses;
create policy businesses_staff_update on public.businesses for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists memberships_read on public.memberships;
create policy memberships_read on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.is_staff());

drop policy if exists reviews_read on public.reviews;
create policy reviews_read on public.reviews for select to authenticated
  using (public.is_member(business_id) or public.is_staff());
drop policy if exists reviews_staff_insert on public.reviews;
create policy reviews_staff_insert on public.reviews for insert to authenticated
  with check (public.is_staff());
drop policy if exists reviews_staff_update on public.reviews;
create policy reviews_staff_update on public.reviews for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Clients only ever see reports after the team has approved and sent them.
drop policy if exists reports_read on public.reports;
create policy reports_read on public.reports for select to authenticated
  using ((public.is_member(business_id) and status = 'sent') or public.is_staff());
drop policy if exists reports_staff_insert on public.reports;
create policy reports_staff_insert on public.reports for insert to authenticated
  with check (public.is_staff());
drop policy if exists reports_staff_update on public.reports;
create policy reports_staff_update on public.reports for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Client actions -------------------------------------------------------------
-- Clients change data only through these checked functions.

create or replace function public.submit_guidelines(bid uuid, g jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_member(bid) or public.is_staff()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.businesses
     set guidelines = g,
         guidelines_submitted_at = now(),
         guidelines_approved_at = null,
         name = coalesce(nullif(g #>> '{business,name}', ''), name),
         status = case when status = 'onboarding' then 'in_review' else status end
   where id = bid;
end $$;

-- Approve a reply. Google and Trustpilot replies wait as 'approved' until posted.
create or replace function public.approve_reply(rid uuid, reply_text text) returns void
language plpgsql security definer set search_path = public as $$
declare bid uuid;
begin
  select business_id into bid from public.reviews where id = rid;
  if bid is null or not (public.is_member(bid) or public.is_staff()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(reply_text, ''))) = 0 or length(reply_text) > 4000 then
    raise exception 'reply must be 1 to 4000 characters' using errcode = '22023';
  end if;
  update public.reviews
     set reply = reply_text, status = 'approved', replied_at = coalesce(replied_at, now()), replied_by = auth.uid()
   where id = rid and status <> 'posted';
end $$;

-- Mark a reply as live (used for Yelp and G2, where the client pastes it in).
create or replace function public.mark_reply_posted(rid uuid, reply_text text) returns void
language plpgsql security definer set search_path = public as $$
declare bid uuid;
begin
  select business_id into bid from public.reviews where id = rid;
  if bid is null or not (public.is_member(bid) or public.is_staff()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(reply_text, ''))) = 0 or length(reply_text) > 4000 then
    raise exception 'reply must be 1 to 4000 characters' using errcode = '22023';
  end if;
  update public.reviews
     set reply = reply_text, status = 'posted', replied_at = coalesce(replied_at, now()), replied_by = auth.uid()
   where id = rid;
end $$;

-- Staff: connect a business to an existing login with the same email.
create or replace function public.link_business_owner(bid uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not public.is_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select u.id into uid from auth.users u join public.businesses b on lower(u.email) = lower(b.owner_email) where b.id = bid;
  if uid is null then return false; end if;
  insert into public.memberships (user_id, business_id, role) values (uid, bid, 'owner') on conflict do nothing;
  return true;
end $$;

-- Lock things down: no anonymous access, functions only for signed-in users.
revoke all on all tables in schema public from anon;
revoke execute on function public.submit_guidelines(uuid, jsonb) from public, anon;
revoke execute on function public.approve_reply(uuid, text) from public, anon;
revoke execute on function public.mark_reply_posted(uuid, text) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_staff() from public, anon;
revoke execute on function public.is_member(uuid) from public, anon;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.submit_guidelines(uuid, jsonb) to authenticated;
grant execute on function public.approve_reply(uuid, text) to authenticated;
grant execute on function public.mark_reply_posted(uuid, text) to authenticated;
revoke execute on function public.link_business_owner(uuid) from public, anon;
grant execute on function public.link_business_owner(uuid) to authenticated;

-- Make yourself staff (run after you first log in, with your own email):
-- update public.profiles set role = 'staff'
--  where id = (select id from auth.users where email = 'you@yourcompany.com');
