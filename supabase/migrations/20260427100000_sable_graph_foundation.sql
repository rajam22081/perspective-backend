-- =====================================================
-- Myndlabs / Sable
-- Migration 001 — Graph-character foundation
-- =====================================================
-- Creates the graph that holds Sable's identity, knowledge,
-- and reasoning structure. Sable IS this graph. The graph
-- grows through reading, pattern formation, and case work.
--
-- Lives in its own schema (myndlabs_sable) so it's cleanly
-- separated from existing tables.
-- =====================================================

create schema if not exists myndlabs_sable;

-- =====================================================
-- NODE TYPES
-- =====================================================
-- Sable's graph has six kinds of nodes. Each one represents
-- a different shape of knowledge.
-- =====================================================

-- A source is something Sable has read or studied.
-- Books, papers, codebases, blog posts.
-- All principles and concepts trace back to a source.
create table if not exists myndlabs_sable.sources (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The kind of source
  kind text not null check (kind in ('book', 'paper', 'codebase', 'article', 'documentation', 'conversation', 'other')),

  -- Display name. e.g. "A Philosophy of Software Design"
  title text not null,

  -- Author or origin. e.g. "John Ousterhout"
  author text,

  -- Where it came from (URL, ISBN, file path)
  reference text,

  -- Free-form notes Sable keeps about this source
  notes text,

  -- Has this source been fully read into the graph?
  ingestion_status text not null default 'pending'
    check (ingestion_status in ('pending', 'in_progress', 'complete', 'failed'))
);

create index if not exists sources_kind_idx on myndlabs_sable.sources(kind);
create index if not exists sources_status_idx on myndlabs_sable.sources(ingestion_status);


-- A concept is a named idea. "State ownership", "coupling", "encapsulation".
-- Concepts are the vocabulary of the graph. Principles are about concepts.
create table if not exists myndlabs_sable.concepts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The concept's canonical name. Lowercase, normalized.
  -- e.g. "state ownership", "coupling", "single source of truth"
  name text not null unique,

  -- A short definition (Sable's own working definition, not from a single source)
  definition text,

  -- How confident is Sable that this concept is well-understood?
  -- 0.0 = encountered once, no real grasp. 1.0 = thoroughly understood.
  confidence numeric(3,2) not null default 0.3
    check (confidence >= 0 and confidence <= 1),

  notes text
);

create index if not exists concepts_name_idx on myndlabs_sable.concepts(name);


-- A principle is a claim. "Each piece of state should have one owner."
-- Principles come from sources. They use concepts. They get tested.
create table if not exists myndlabs_sable.principles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The claim itself, in its clearest form
  statement text not null,

  -- The source this principle came from (one source per principle).
  -- Different sources stating similar principles get separate rows;
  -- they get connected via patterns later.
  source_id uuid not null references myndlabs_sable.sources(id) on delete cascade,

  -- Where in the source (page, section, chapter)
  source_locator text,

  -- Confidence in the principle. Starts at the source's authority level,
  -- gets updated by case validation over time.
  confidence numeric(3,2) not null default 0.5
    check (confidence >= 0 and confidence <= 1),

  -- How widely Sable believes this applies.
  -- 'narrow' = specific context only, 'broad' = general principle
  scope text not null default 'unknown'
    check (scope in ('unknown', 'narrow', 'contextual', 'broad', 'universal')),

  notes text
);

create index if not exists principles_source_idx on myndlabs_sable.principles(source_id);


-- A pattern is what emerges when multiple principles share an underlying shape.
-- Patterns are not extracted from any single source — they are abstracted by
-- Sable across principles. They are the highest layer of the graph.
create table if not exists myndlabs_sable.patterns (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The pattern's name (Sable's own naming)
  name text not null unique,

  -- The pattern stated as a generalized claim
  statement text not null,

  -- Confidence in the pattern. Starts low and grows with case validation.
  confidence numeric(3,2) not null default 0.3
    check (confidence >= 0 and confidence <= 1),

  -- Status of the pattern.
  -- 'candidate' = proposed by Sable but not yet validated
  -- 'tested' = applied to cases, refined
  -- 'durable' = repeatedly validated, high confidence
  -- 'deprecated' = pattern was rejected after testing
  status text not null default 'candidate'
    check (status in ('candidate', 'tested', 'durable', 'deprecated')),

  notes text
);


-- An example is a concrete case from a source that illustrates a principle.
-- Different from a 'case', which is real work Sable did.
create table if not exists myndlabs_sable.examples (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Description of the example
  description text not null,

  -- The source it came from
  source_id uuid not null references myndlabs_sable.sources(id) on delete cascade,
  source_locator text
);

create index if not exists examples_source_idx on myndlabs_sable.examples(source_id);


-- A case is real architecture work Sable engaged with.
-- The Myndlabs project itself, the Sable build, future projects.
-- Cases are how principles get validated against reality.
create table if not exists myndlabs_sable.cases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Name of the case. e.g. "Sable graph schema design"
  name text not null,

  -- What was the architectural question or problem
  description text not null,

  -- Status of the case
  status text not null default 'active'
    check (status in ('active', 'resolved', 'abandoned')),

  -- Was the architecture decision good in retrospect?
  -- Updated after the case has run for a while.
  outcome text
    check (outcome is null or outcome in ('held', 'partial', 'failed', 'too_early_to_tell')),

  outcome_reasoning text,

  notes text
);


-- =====================================================
-- EDGE TYPES
-- =====================================================
-- Edges connect nodes. Each edge has a type that tells you
-- what kind of relationship it represents.
-- =====================================================

-- A principle uses concepts. e.g. "Each piece of state should have one owner"
-- uses the concepts "state" and "ownership".
create table if not exists myndlabs_sable.principle_uses_concept (
  principle_id uuid not null references myndlabs_sable.principles(id) on delete cascade,
  concept_id uuid not null references myndlabs_sable.concepts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (principle_id, concept_id)
);


-- An example illustrates a principle.
create table if not exists myndlabs_sable.example_illustrates_principle (
  example_id uuid not null references myndlabs_sable.examples(id) on delete cascade,
  principle_id uuid not null references myndlabs_sable.principles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (example_id, principle_id)
);


-- A pattern abstracts across principles. The pattern node groups them.
create table if not exists myndlabs_sable.pattern_abstracts_principle (
  pattern_id uuid not null references myndlabs_sable.patterns(id) on delete cascade,
  principle_id uuid not null references myndlabs_sable.principles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (pattern_id, principle_id)
);


-- A principle applies to a case. Recorded when Sable uses a principle in real work.
create table if not exists myndlabs_sable.principle_applied_to_case (
  id uuid primary key default gen_random_uuid(),
  principle_id uuid not null references myndlabs_sable.principles(id) on delete cascade,
  case_id uuid not null references myndlabs_sable.cases(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- How the principle was applied (Sable's reasoning at the time)
  application_notes text,

  -- Did this application hold up?
  -- Updated later when the case outcome is known.
  application_outcome text
    check (application_outcome is null or application_outcome in ('held', 'partial', 'failed', 'too_early_to_tell'))
);

create index if not exists principle_case_principle_idx on myndlabs_sable.principle_applied_to_case(principle_id);
create index if not exists principle_case_case_idx on myndlabs_sable.principle_applied_to_case(case_id);


-- Two principles can contradict each other.
-- Sable surfaces these as tensions to be resolved through case work.
create table if not exists myndlabs_sable.principle_contradicts_principle (
  principle_a_id uuid not null references myndlabs_sable.principles(id) on delete cascade,
  principle_b_id uuid not null references myndlabs_sable.principles(id) on delete cascade,
  created_at timestamptz not null default now(),
  notes text,
  primary key (principle_a_id, principle_b_id),
  -- Can't contradict yourself
  check (principle_a_id <> principle_b_id)
);


-- One principle refines another (adds nuance, conditions, exceptions).
create table if not exists myndlabs_sable.principle_refines_principle (
  refining_principle_id uuid not null references myndlabs_sable.principles(id) on delete cascade,
  refined_principle_id uuid not null references myndlabs_sable.principles(id) on delete cascade,
  created_at timestamptz not null default now(),
  notes text,
  primary key (refining_principle_id, refined_principle_id),
  check (refining_principle_id <> refined_principle_id)
);


-- =====================================================
-- REFLECTION LOG
-- =====================================================
-- When Sable reflects on their own work, the reflection itself
-- gets logged here. This is the audit trail of how Sable's graph
-- changed and why.
-- =====================================================

create table if not exists myndlabs_sable.reflections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- What triggered this reflection
  trigger text not null
    check (trigger in ('source_ingested', 'case_resolved', 'pattern_proposed', 'scheduled', 'manual', 'contradiction_found')),

  -- Free-form text of what Sable noticed
  observation text not null,

  -- What graph changes were proposed as a result
  -- (stored as JSON for flexibility while we figure out the right structure)
  proposed_changes jsonb,

  -- Status of the reflection's proposals
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'partially_applied'))
);

create index if not exists reflections_status_idx on myndlabs_sable.reflections(status);
create index if not exists reflections_created_idx on myndlabs_sable.reflections(created_at desc);


-- =====================================================
-- UPDATED_AT TRIGGERS
-- =====================================================

create or replace function myndlabs_sable.set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists sources_updated_at on myndlabs_sable.sources;
create trigger sources_updated_at
  before update on myndlabs_sable.sources
  for each row execute function myndlabs_sable.set_updated_at();

drop trigger if exists concepts_updated_at on myndlabs_sable.concepts;
create trigger concepts_updated_at
  before update on myndlabs_sable.concepts
  for each row execute function myndlabs_sable.set_updated_at();

drop trigger if exists principles_updated_at on myndlabs_sable.principles;
create trigger principles_updated_at
  before update on myndlabs_sable.principles
  for each row execute function myndlabs_sable.set_updated_at();

drop trigger if exists patterns_updated_at on myndlabs_sable.patterns;
create trigger patterns_updated_at
  before update on myndlabs_sable.patterns
  for each row execute function myndlabs_sable.set_updated_at();

drop trigger if exists cases_updated_at on myndlabs_sable.cases;
create trigger cases_updated_at
  before update on myndlabs_sable.cases
  for each row execute function myndlabs_sable.set_updated_at();

