-- =====================================================
-- Myndlabs / Atelier
-- Migration 001: Initial schema
--
-- Atelier is a website architect built as graph-evolution.
-- The graph holds Atelier's understanding of web design
-- as mechanisms with derivations and boundaries — the
-- same discipline Sable uses for software architecture,
-- adapted to a design domain.
--
-- Atelier's domain: editorial, considered, character-driven
-- web design. Not e-commerce templates. Not generic SaaS.
-- The kind of design Myndlabs ships.
-- =====================================================

create schema if not exists myndlabs_atelier;
set search_path to myndlabs_atelier;

-- =====================================================
-- SOURCES
-- Books, monographs, papers, posters, sites, anything
-- Atelier reads to build understanding.
-- =====================================================

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  kind text not null,
    -- 'book', 'paper', 'monograph', 'poster_series', 'site',
    -- 'essay', 'lecture'
  title text not null,
  author text,
  reference text,
    -- ISBN, URL, citation - whatever makes the source locatable
  notes text,
    -- Atelier's notes about this source - not user-facing
  ingestion_status text default 'in_progress'
    check (ingestion_status in ('in_progress', 'complete', 'partial', 'abandoned'))
);

-- =====================================================
-- CONCEPTS
-- Vocabulary Atelier uses to think. Lowercase canonical
-- terms. Mechanisms reference concepts.
-- =====================================================

create table if not exists concepts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  name text unique not null,  -- always lowercase
  definition text
    -- Atelier's working definition. Can evolve.
);

-- =====================================================
-- MECHANISMS
-- The primary nodes. Each mechanism is a piece of design
-- understanding with explicit derivation and boundary.
-- =====================================================

create table if not exists mechanisms (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  name text unique not null,  -- canonical lowercase name
  description text not null,
    -- What this mechanism explains. The cause-and-effect.
    -- Not a paraphrase of someone's claim - the underlying logic.
  derivation text not null,
    -- How this follows from prior mechanisms or foundations.
    -- For derived mechanisms, references other mechanisms by name.
    -- For foundational mechanisms, explains why it can't reduce further.
  boundary text not null,
    -- The specific conditions under which this mechanism stops
    -- applying. Named failure modes.
  origin text not null
    check (origin in ('foundational', 'derived', 'synthetic')),
    -- foundational: irreducible observation, doesn't derive from others
    -- derived: follows from prior mechanisms in the graph
    -- synthetic: produced by Atelier reasoning across multiple priors
  status text default 'theoretical'
    check (status in ('theoretical', 'tested', 'rock_solid', 'contested', 'retired')),
    -- theoretical: in the graph but not validated by case work
    -- tested: applied in cases, held up partially
    -- rock_solid: applied multiple times, consistently held
    -- contested: case work surfaced tensions; needs resolution
    -- retired: superseded or invalidated
  confidence numeric default 0.5 check (confidence between 0 and 1)
);

-- =====================================================
-- PENDING QUESTIONS
-- Claims Atelier has read but cannot yet derive.
-- Each has a specific obstruction explaining what's missing.
-- The reflection cycle (step 3) processes these.
-- =====================================================

create table if not exists pending_questions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  claim text not null,
    -- The claim, stated as Atelier understood it
  source_id uuid references sources(id),
  source_locator text,
    -- e.g. "chunk 23 of 147", "page 91", "section 3.2"
  source_excerpt text,
    -- The actual text from the source
  obstruction text,
    -- What's missing in the graph that would let Atelier derive this.
    -- e.g. "Need a mechanism for why grid alignment produces coherence
    -- before this can be derived."
  status text default 'open'
    check (status in ('open', 'resolved', 'rejected', 'merged'))
);

-- =====================================================
-- CASES
-- Real design problems Atelier has worked on.
-- Used to validate mechanisms - case work is what
-- moves a mechanism from 'theoretical' to 'rock_solid'
-- or surfaces tensions.
-- =====================================================

create table if not exists cases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  title text not null,
    -- e.g. "Kiesza tribute site - entrance composition"
  scope text not null,
    -- The client scope Atelier was working from
  outcome text,
    -- What Atelier produced and what happened
  notes text
);

-- =====================================================
-- EDGES
-- Relationships between primary nodes.
-- =====================================================

-- Mechanism derives from another mechanism
create table if not exists mechanism_derives_from_mechanism (
  derived_id uuid references mechanisms(id) on delete cascade,
  source_id uuid references mechanisms(id) on delete cascade,
  reasoning text,
    -- Why this derivation holds
  created_at timestamptz default now(),
  primary key (derived_id, source_id),
  check (derived_id != source_id)
);

-- Mechanism uses a concept
create table if not exists mechanism_uses_concept (
  mechanism_id uuid references mechanisms(id) on delete cascade,
  concept_id uuid references concepts(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (mechanism_id, concept_id)
);

-- Mechanism cited in a source
create table if not exists mechanism_cited_in_source (
  mechanism_id uuid references mechanisms(id) on delete cascade,
  source_id uuid references sources(id) on delete cascade,
  locator text,  -- chunk, page, section
  source_framing text,
    -- How the source phrases the mechanism (their words)
  created_at timestamptz default now(),
  primary key (mechanism_id, source_id)
);

-- A claim derived from a mechanism (Atelier's own claim, not a source's)
create table if not exists derived_claims (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  mechanism_id uuid references mechanisms(id) on delete cascade,
  claim text not null,
  reasoning text
);

-- Mechanism applied to a case
create table if not exists mechanism_applied_to_case (
  mechanism_id uuid references mechanisms(id) on delete cascade,
  case_id uuid references cases(id) on delete cascade,
  application text,
    -- How the mechanism was applied
  outcome text,
    -- What happened when applied
  validation text
    check (validation in ('held', 'partially_held', 'failed', 'inconclusive')),
  created_at timestamptz default now(),
  primary key (mechanism_id, case_id)
);

-- Tension between two mechanisms (apparent contradiction)
create table if not exists mechanism_tension (
  mechanism_a_id uuid references mechanisms(id) on delete cascade,
  mechanism_b_id uuid references mechanisms(id) on delete cascade,
  description text,
    -- What the apparent contradiction is
  resolution text,
    -- Once resolved through case work, how it was resolved
    -- (often: a deeper mechanism that explains both)
  status text default 'unresolved'
    check (status in ('unresolved', 'resolved', 'merged', 'one_retired')),
  created_at timestamptz default now(),
  primary key (mechanism_a_id, mechanism_b_id)
);

-- Reflections — Atelier processing pending questions
create table if not exists reflections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  pending_question_id uuid references pending_questions(id),
  reasoning text,
    -- Atelier's working out
  outcome text
    check (outcome in ('resolved_to_mechanism', 'still_pending', 'rejected', 'merged'))
);

-- =====================================================
-- INDEXES
-- =====================================================

create index if not exists idx_mechanisms_status on mechanisms(status);
create index if not exists idx_mechanisms_origin on mechanisms(origin);
create index if not exists idx_pending_questions_status on pending_questions(status);
create index if not exists idx_pending_questions_source on pending_questions(source_id);
create index if not exists idx_mechanism_cited_source on mechanism_cited_in_source(source_id);

