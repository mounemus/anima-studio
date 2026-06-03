-- Anima Studio admin schema
-- Run this once in the Supabase SQL editor.

create extension if not exists pgcrypto;

-- Single admin (you). More can be added later if you want.
create table if not exists admin_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- Key-value store for app settings. Values are AES-GCM encrypted by the API.
create table if not exists app_settings (
  key text primary key,
  value text not null,
  hint text,                              -- e.g. last 4 chars to recognise the key
  updated_at timestamptz not null default now(),
  updated_by uuid references admin_users(id) on delete set null
);

-- RLS on. We only ever access these tables with the SERVICE_ROLE key from server.
alter table admin_users enable row level security;
alter table app_settings enable row level security;

-- No policies = no public access. Service role bypasses RLS.

-- Seed marker table (used to detect first-run setup)
-- not needed; we count admin_users instead.
