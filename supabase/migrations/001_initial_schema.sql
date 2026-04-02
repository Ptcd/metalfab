-- TCB Metalworks Bid Pipeline CRM — Initial Schema
-- Run this in your Supabase SQL Editor

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ============================================================
-- updated_at trigger function
-- ============================================================
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ============================================================
-- opportunities table
-- ============================================================
create table opportunities (
  id                uuid primary key default uuid_generate_v4(),
  sam_notice_id     text unique,
  title             text not null,
  description       text,
  agency            text,
  sub_agency        text,
  naics_code        text,
  naics_description text,
  dollar_min        numeric,
  dollar_max        numeric,
  posted_date       date,
  response_deadline timestamptz,
  point_of_contact  text,
  contact_email     text,
  source_url        text,
  source            text not null default 'manual',
  raw_data          jsonb,
  score             int default 0,
  score_signals     jsonb default '[]'::jsonb,
  status            text not null default 'new',
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint valid_status check (
    status in ('new', 'reviewing', 'bidding', 'won', 'lost', 'passed')
  )
);

create trigger opportunities_updated_at
  before update on opportunities
  for each row execute function update_updated_at();

-- Indexes for common queries
create index idx_opportunities_status on opportunities (status);
create index idx_opportunities_score on opportunities (score desc);
create index idx_opportunities_deadline on opportunities (response_deadline);
create index idx_opportunities_sam_notice on opportunities (sam_notice_id);

-- ============================================================
-- scoring_config table (single row, holds current config)
-- ============================================================
create table scoring_config (
  id                uuid primary key default uuid_generate_v4(),
  keyword_primary   text[] not null default '{}',
  keyword_secondary text[] not null default '{}',
  keyword_disqualify text[] not null default '{}',
  naics_codes       text[] not null default '{}',
  dollar_min        numeric not null default 10000,
  dollar_max        numeric not null default 1500000,
  score_green       int not null default 70,
  score_yellow      int not null default 40,
  updated_at        timestamptz not null default now()
);

create trigger scoring_config_updated_at
  before update on scoring_config
  for each row execute function update_updated_at();

-- Seed with TCB Metalworks defaults
insert into scoring_config (
  keyword_primary,
  keyword_secondary,
  keyword_disqualify,
  naics_codes,
  dollar_min,
  dollar_max
) values (
  array['handrail', 'railing', 'stair', 'stairs', 'ornamental', 'structural steel', 'misc metals', 'fabrication', 'metal fabrication', 'zoo', 'cage', 'enclosure', 'fencing', 'gate', 'canopy', 'awning'],
  array['welding', 'steel', 'iron', 'architectural metals', 'custom metal'],
  array['AWS certification required', 'AISC certified', 'PE stamp required', 'prevailing wage certified'],
  array['332312', '332321', '332323', '332999', '238120', '238990'],
  10000,
  1500000
);

-- ============================================================
-- pipeline_events table (activity log)
-- ============================================================
create table pipeline_events (
  id              uuid primary key default uuid_generate_v4(),
  opportunity_id  uuid not null references opportunities(id) on delete cascade,
  event_type      text not null,
  old_value       text,
  new_value       text,
  created_at      timestamptz not null default now(),

  constraint valid_event_type check (
    event_type in ('status_change', 'note_added', 'score_updated', 'created')
  )
);

create index idx_events_opportunity on pipeline_events (opportunity_id);
create index idx_events_created on pipeline_events (created_at desc);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table opportunities enable row level security;
alter table scoring_config enable row level security;
alter table pipeline_events enable row level security;

-- Service role (used by API routes) bypasses RLS automatically.
-- Authenticated users can read everything, write via API only.
create policy "Authenticated users can read opportunities"
  on opportunities for select
  to authenticated
  using (true);

create policy "Authenticated users can read config"
  on scoring_config for select
  to authenticated
  using (true);

create policy "Authenticated users can read events"
  on pipeline_events for select
  to authenticated
  using (true);
