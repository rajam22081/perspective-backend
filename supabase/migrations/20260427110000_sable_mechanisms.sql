-- =====================================================
-- Myndlabs / Sable
-- Migration 002 — Mechanisms architecture
-- =====================================================
-- This migration replaces the principle-centric schema with
-- a mechanism-centric one. Sable's graph holds MECHANISMS
-- (the why-it-works) rather than principles (surface claims).
--
-- Principles in books are claims. Mechanisms in Sable's graph
-- are the underlying logic that makes claims true. Sable
-- accepts a claim only when its mechanism can be derived from
-- what's already understood, or when case work validates it.
--
-- Drops the previous myndlabs_sable schema and recreates
-- clean. This is safe because the graph was empty — no data
-- is lost.
-- =====================================================

drop schema if exists myndlabs_sable cascade;
create schema myndlabs_sable;


-- =====================================================
-- SOURCES
-- Things Sable has read or studied. Books, papers, codebases.
-- Sources are evidence, not authority. A claim from a source
-- doesn't enter the graph until its mechanism is understood.
-- =====================================================

create table myndlabs_sable.sources (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  kind text not null check (kind in ('book', 'paper', 'codebase', 'article', 'documentation', 'conversation', 'other')),
  title text not null,
  author text,
  reference text,
  notes text,

  ingestion_status text not null default 'pending'
    check (ingestion_status in ('pending', 'in_progress', 'complete', 'failed'))
);

create index sources_kind_idx on myndlabs_sable.sources(kind);


-- =====================================================
-- CONCEPTS
-- The vocabulary of the graph. Named ideas mechanisms operate on.
-- "State", "coupling", "ownership", "consistency".
-- =====================================================

create table myndlabs_sable.concepts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Canonical name, lowercase
  name text not null unique,

  -- Sable's working definition. Refined over time.
  definition text,

  -- Confidence Sable understands this concept well
  confidence numeric(3,2) not null default 0.3
    check (confidence >= 0 and confidence <= 1),

  notes text
);

create index concepts_name_idx on myndlabs_sable.concepts(name);


-- =====================================================
-- MECHANISMS — THE PRIMARY NODES OF THE GRAPH
-- =====================================================
-- A mechanism is the underlying logic that makes claims true.
-- Not "single ownership prevents bugs" (claim) but
-- "ambiguous write order from concurrent writers makes system
--  behavior depend on timing, which makes correctness intractable
--  to reason about" (mechanism).
--
-- Mechanisms are how Sable understands. Claims are derived from
-- mechanisms. Sable doesn't memorize claims; Sable holds mechanisms
-- and produces claims by reasoning.
--
-- A mechanism enters the graph only when:
--   (a) Its derivation is explicit and follows from existing
--       mechanisms or base concepts, OR
--   (b) Case work has validated it directly
--
-- Anything else stays as a pending_question.
-- =====================================================

create table myndlabs_sable.mechanisms (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Short canonical name. e.g. "ambiguous mutation order"
  name text not null unique,

  -- The mechanism stated as a description: what it explains,
  -- in terms of cause and effect
  description text not null,

  -- The derivation: in plain text, how this mechanism follows
  -- from more fundamental things. References to other mechanisms
  -- or base concepts are made explicit through the
  -- mechanism_derives_from table.
  derivation text not null,

  -- The boundary: under what conditions does this mechanism
  -- stop applying? What would falsify it? What edge cases does
  -- it not cover?
  boundary text not null,

  -- How this mechanism became part of the graph.
  -- 'derived'  = followed from existing mechanisms in the graph
  -- 'foundational' = base mechanism, doesn't reduce further (used sparingly)
  -- 'validated' = entered via direct case work without prior derivation
  -- 'generated' = Sable produced this themselves by reasoning across mechanisms
  origin text not null
    check (origin in ('derived', 'foundational', 'validated', 'generated')),

  -- Validation status of the mechanism
  -- 'theoretical' = derivation is sound but not yet tested in cases
  -- 'tested' = applied in cases, held up
  -- 'rock_solid' = repeatedly tested, derivation is clean, no failures
  -- 'questioned' = a case or new reading raised doubt; needs review
  status text not null default 'theoretical'
    check (status in ('theoretical', 'tested', 'rock_solid', 'questioned')),

  -- Numeric confidence, 0-1. A function of derivation soundness
  -- and case validation. Updated as the graph evolves.
  confidence numeric(3,2) not null default 0.5
    check (confidence >= 0 and confidence <= 1),

  notes text
);

create index mechanisms_status_idx on myndlabs_sable.mechanisms(status);
create index mechanisms_origin_idx on myndlabs_sable.mechanisms(origin);


-- =====================================================
-- DERIVATION EDGES
-- A mechanism is "derived from" zero or more other mechanisms
-- or concepts. This is how the graph encodes its own reasoning.
-- A mechanism with no derivation_from edges is foundational
-- (or validated directly through case work).
-- =====================================================

create table myndlabs_sable.mechanism_derives_from_mechanism (
  derived_id uuid not null references myndlabs_sable.mechanisms(id) on delete cascade,
  source_id uuid not null references myndlabs_sable.mechanisms(id) on delete cascade,
  created_at timestamptz not null default now(),
  reasoning text,
  primary key (derived_id, source_id),
  check (derived_id <> source_id)
);

create table myndlabs_sable.mechanism_uses_concept (
  mechanism_id uuid not null references myndlabs_sable.mechanisms(id) on delete cascade,
  concept_id uuid not null references myndlabs_sable.concepts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (mechanism_id, concept_id)
);


-- =====================================================
-- CITATIONS
-- A mechanism may be cited by multiple sources. This is evidence,
-- not authority. The mechanism's truth doesn't come from citations;
-- citations are records that this mechanism (or this mechanism's
-- corresponding claim) was discussed in a source.
-- =====================================================

create table myndlabs_sable.mechanism_cited_in_source (
  mechanism_id uuid not null references myndlabs_sable.mechanisms(id) on delete cascade,
  source_id uuid not null references myndlabs_sable.sources(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- Where in the source (chapter, section, page)
  locator text,

  -- The exact claim the source makes about this mechanism, in the
  -- source's own framing. Useful for noting how different authors
  -- describe the same underlying mechanism differently.
  source_framing text,

  primary key (mechanism_id, source_id)
);


-- =====================================================
-- CLAIMS DERIVED FROM MECHANISMS
-- Claims are surface statements. They follow from mechanisms.
-- We don't usually need to store them — Sable derives them on
-- demand. But for important or non-obvious derivations, we
-- can record them.
-- =====================================================

create table myndlabs_sable.derived_claims (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- The claim stated clearly
  statement text not null,

  -- The mechanism it follows from
  mechanism_id uuid not null references myndlabs_sable.mechanisms(id) on delete cascade,

  -- The reasoning that takes us from mechanism to claim
  derivation_reasoning text,

  -- Sable's confidence in this specific derivation
  confidence numeric(3,2) not null default 0.5
    check (confidence >= 0 and confidence <= 1)
);

create index derived_claims_mechanism_idx on myndlabs_sable.derived_claims(mechanism_id);


-- =====================================================
-- PENDING QUESTIONS
-- Claims Sable has encountered but does not yet understand.
-- They cannot enter the graph as mechanisms because no derivation
-- exists yet. They sit here until reasoning or case work resolves them.
--
-- This table is the queue of "things to work out." Reflection cycles
-- process it. It is itself a knowledge artifact — the map of what
-- Sable knows they don't yet understand.
-- =====================================================

create table myndlabs_sable.pending_questions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The claim Sable encountered
  claim text not null,

  -- Where Sable encountered it
  source_id uuid references myndlabs_sable.sources(id) on delete set null,
  source_locator text,

  -- The exact text that prompted the claim
  source_excerpt text,

  -- Why is this pending? Sable's reasoning for why it can't yet enter the graph.
  -- e.g. "The mechanism for why X is true would require a mechanism for Y,
  --       which the graph doesn't yet have."
  obstruction text,

  -- Status of the question
  -- 'open' = unresolved, hasn't been worked on
  -- 'investigating' = a reflection cycle is working on it
  -- 'derived' = resolved into a mechanism (link in resolved_mechanism_id)
  -- 'rejected' = determined to be false or unfounded
  -- 'deferred' = parked for later, often waiting on case work
  status text not null default 'open'
    check (status in ('open', 'investigating', 'derived', 'rejected', 'deferred')),

  -- If status is 'derived', the mechanism this resolved into
  resolved_mechanism_id uuid references myndlabs_sable.mechanisms(id) on delete set null,

  notes text
);

create index pending_questions_status_idx on myndlabs_sable.pending_questions(status);
create index pending_questions_source_idx on myndlabs_sable.pending_questions(source_id);


-- =====================================================
-- CASES
-- Real architectural work Sable engaged with. The Myndlabs build
-- itself. Future projects. Cases are how mechanisms get validated
-- against reality.
-- =====================================================

create table myndlabs_sable.cases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  name text not null,
  description text not null,

  status text not null default 'active'
    check (status in ('active', 'resolved', 'abandoned')),

  outcome text
    check (outcome is null or outcome in ('held', 'partial', 'failed', 'too_early_to_tell')),

  outcome_reasoning text,
  notes text
);


-- A mechanism applied to a case, with the outcome.
-- This is how case work validates mechanisms.
create table myndlabs_sable.mechanism_applied_to_case (
  id uuid primary key default gen_random_uuid(),
  mechanism_id uuid not null references myndlabs_sable.mechanisms(id) on delete cascade,
  case_id uuid not null references myndlabs_sable.cases(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- How the mechanism was applied (Sable's reasoning at the time)
  application_notes text,

  -- Did this application hold up?
  application_outcome text
    check (application_outcome is null or application_outcome in ('held', 'partial', 'failed', 'too_early_to_tell')),

  -- If failed: what did we learn? Was the mechanism wrong, or was
  -- the boundary mislocated, or did interaction with another
  -- mechanism produce unexpected behavior?
  failure_analysis text
);

create index mechanism_case_mechanism_idx on myndlabs_sable.mechanism_applied_to_case(mechanism_id);
create index mechanism_case_case_idx on myndlabs_sable.mechanism_applied_to_case(case_id);


-- =====================================================
-- TENSIONS
-- Two mechanisms that appear to contradict each other.
-- Tensions are real states in the graph, not errors.
-- They get resolved (or maintained as boundary cases) through
-- reflection and case work.
-- =====================================================

create table myndlabs_sable.mechanism_tension (
  mechanism_a_id uuid not null references myndlabs_sable.mechanisms(id) on delete cascade,
  mechanism_b_id uuid not null references myndlabs_sable.mechanisms(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Description of the apparent contradiction
  description text not null,

  -- Status of the tension
  -- 'open' = unresolved
  -- 'resolved' = a mechanism that explains both has been found
  -- 'boundary' = both mechanisms are valid in different contexts
  status text not null default 'open'
    check (status in ('open', 'resolved', 'boundary')),

  resolution_notes text,

  primary key (mechanism_a_id, mechanism_b_id),
  check (mechanism_a_id <> mechanism_b_id)
);


-- =====================================================
-- REFLECTIONS
-- Audit trail of when Sable reflected, what they noticed, what
-- changes were proposed. The history of how the graph evolved.
-- =====================================================

create table myndlabs_sable.reflections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- What triggered this reflection
  trigger text not null
    check (trigger in (
      'source_ingested',
      'case_resolved',
      'pending_question_review',
      'tension_review',
      'mechanism_proposed',
      'scheduled',
      'manual'
    )),

  -- Free-form text of what Sable noticed
  observation text not null,

  -- What graph changes were proposed (JSON)
  proposed_changes jsonb,

  -- Status of the reflection's proposals
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'partially_applied')),

  -- Founder's notes if reviewed
  founder_notes text
);

create index reflections_status_idx on myndlabs_sable.reflections(status);
create index reflections_trigger_idx on myndlabs_sable.reflections(trigger);


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

drop trigger if exists mechanisms_updated_at on myndlabs_sable.mechanisms;
create trigger mechanisms_updated_at
  before update on myndlabs_sable.mechanisms
  for each row execute function myndlabs_sable.set_updated_at();

drop trigger if exists pending_questions_updated_at on myndlabs_sable.pending_questions;
create trigger pending_questions_updated_at
  before update on myndlabs_sable.pending_questions
  for each row execute function myndlabs_sable.set_updated_at();

drop trigger if exists cases_updated_at on myndlabs_sable.cases;
create trigger cases_updated_at
  before update on myndlabs_sable.cases
  for each row execute function myndlabs_sable.set_updated_at();

drop trigger if exists mechanism_tension_updated_at on myndlabs_sable.mechanism_tension;
create trigger mechanism_tension_updated_at
  before update on myndlabs_sable.mechanism_tension
  for each row execute function myndlabs_sable.set_updated_at();
