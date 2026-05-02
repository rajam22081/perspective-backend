-- =====================================================
-- Myndlabs / Atelier
-- Migration: structural character
--
-- This migration extends the myndlabs_atelier schema so that
-- Atelier's character lives in the structure of the graph itself,
-- not in a system prompt. The existing tables stay; this adds
-- what the architecture was missing:
--
--   - Mechanisms now hold their alternatives and outside-boundary
--     reasoning as first-class data, not commentary
--   - A new entries table for reasoned-through encounters that
--     aren't (yet) full mechanisms but represent real working-through
--   - A cases table for specific designs Atelier has examined
--   - A projects table for design work Atelier has done
--   - An unresolved_encounters table that distinguishes acknowledged
--     gaps from pending-as-todo
--   - Project decisions linked to mechanisms applied and cases referenced
--
-- The character emerges from how this structure accumulates. A new
-- Atelier with an empty graph is the same architecture; it becomes
-- Atelier through the work of reading, reasoning, and case work.
-- =====================================================

SET search_path TO myndlabs_atelier;

-- =====================================================
-- 1. EXTEND MECHANISMS WITH ALTERNATIVES AND OUTSIDE-BOUNDARY
-- =====================================================
-- Every mechanism should carry not just what it claims and where
-- it holds, but what happens outside its boundary and what
-- alternatives a designer could choose instead. These are
-- structural, not optional commentary.

ALTER TABLE mechanisms
  ADD COLUMN IF NOT EXISTS outside_boundary TEXT,
  ADD COLUMN IF NOT EXISTS what_it_means TEXT;

COMMENT ON COLUMN mechanisms.outside_boundary IS
  'What happens when the conditions for this mechanism do not apply. The mechanism does not fail — a different mechanism takes over, or the situation becomes a different kind of situation. Atelier articulates that here.';

COMMENT ON COLUMN mechanisms.what_it_means IS
  'Atelier''s reading of what the mechanism is actually claiming, in its own words. Not paraphrase of source — Atelier''s working-out of what is being asserted.';


-- Alternatives table: each mechanism can have multiple alternatives
-- a designer could choose instead, with conditions for each.

CREATE TABLE IF NOT EXISTS mechanism_alternatives (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mechanism_id UUID NOT NULL REFERENCES mechanisms(id) ON DELETE CASCADE,
  alternative TEXT NOT NULL,
  comparison  TEXT NOT NULL,
  conditions_for_use TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE mechanism_alternatives IS
  'For each mechanism, the alternative approaches a designer could choose instead. Each alternative carries its comparison to the original mechanism and the conditions under which it would be preferable. This is first-class data: Atelier never reasons about a mechanism without also seeing its alternatives.';

CREATE INDEX IF NOT EXISTS idx_alternatives_mechanism
  ON mechanism_alternatives(mechanism_id);


-- =====================================================
-- 2. ENTRIES — REASONED-THROUGH ENCOUNTERS
-- =====================================================
-- Not every encounter produces a mechanism. Sometimes Atelier
-- reasons through a claim and arrives at a partial understanding
-- — the trace doesn't reach foundations, or the boundary is
-- unclear, or the alternatives aren't yet articulated. These
-- are entries: real reasoning Atelier has done, captured
-- as-is, with explicit acknowledgment of what's incomplete.
--
-- An entry can mature into a full mechanism over time, as
-- Atelier reasons through it again from new sources. The
-- entry is honest about its own status.

CREATE TABLE IF NOT EXISTS entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim           TEXT NOT NULL,
  what_it_means   TEXT,
  why_it_holds    TEXT,
  boundary        TEXT,
  outside_boundary TEXT,
  status          TEXT NOT NULL CHECK (status IN (
    'worked_through_with_trace',
    'worked_through_partial',
    'encountered_without_trace',
    'matured_to_mechanism'
  )),
  matured_mechanism_id UUID REFERENCES mechanisms(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE entries IS
  'Reasoned-through encounters that are not (yet) full mechanisms. An entry captures Atelier''s working-out of a claim — what it means, why it might hold, where the boundary seems to be — even when the trace is incomplete. Entries can mature into mechanisms when later reasoning resolves their gaps.';


-- Entries can use concepts and have alternatives too — the same
-- structure as mechanisms, because the reasoning shape is the same.

CREATE TABLE IF NOT EXISTS entry_uses_concept (
  entry_id   UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, concept_id)
);

CREATE TABLE IF NOT EXISTS entry_alternatives (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id   UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  alternative TEXT NOT NULL,
  comparison TEXT NOT NULL,
  conditions_for_use TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS entry_cited_in_source (
  entry_id   UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  source_id  UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  locator    TEXT,
  source_framing TEXT,
  PRIMARY KEY (entry_id, source_id)
);


-- =====================================================
-- 3. UNRESOLVED ENCOUNTERS — ACKNOWLEDGED GAPS
-- =====================================================
-- Distinct from pending_questions. Pending was being used as a
-- catch-all. Unresolved encounters are specifically: things
-- Atelier read or saw, recognized as substantive, but could
-- not account for from current understanding.
--
-- These are not "to be derived later." They are "I noticed
-- this and I cannot yet see it clearly." Honest about gaps.
--
-- Atelier carries these as part of its character. Asked
-- "what don't you understand about X?" Atelier can answer
-- truthfully from this table.

CREATE TABLE IF NOT EXISTS unresolved_encounters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  what_was_encountered TEXT NOT NULL,
  source_id       UUID REFERENCES sources(id),
  source_locator  TEXT,
  source_excerpt  TEXT,
  why_unresolved  TEXT NOT NULL,
  what_would_resolve_it TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open',
    'partially_addressed',
    'resolved'
  )),
  resolution_notes TEXT,
  resolved_via_mechanism_id UUID REFERENCES mechanisms(id),
  resolved_via_entry_id UUID REFERENCES entries(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE unresolved_encounters IS
  'Things Atelier encountered and recognized as substantive but could not account for. These are honest acknowledgments of current incompleteness. They are part of Atelier''s character — Atelier knows what it does not know, and can say so truthfully.';


-- =====================================================
-- 4. CASES — SPECIFIC DESIGNS EXAMINED
-- =====================================================
-- A case is a real design Atelier has looked at and reasoned
-- through. Not theoretical. Specific. The hero of a website,
-- a typographic treatment in a book, a layout in a magazine,
-- a poster on a wall.
--
-- Cases ground Atelier's mechanism understanding in
-- particulars. Mature architects' minds aren't lists of
-- principles — they're libraries of cases reasoned through.

CREATE TABLE IF NOT EXISTS cases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  context         TEXT,
  reference_url   TEXT,
  reference_image_url TEXT,
  what_atelier_noticed TEXT NOT NULL,
  what_works      TEXT,
  what_does_not_work TEXT,
  why             TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE cases IS
  'Specific designs Atelier has examined and reasoned through. Real artifacts, not abstractions. The library of cases grounds mechanism understanding in particulars and is the substance of Atelier''s maturing eye.';


-- A case applies mechanisms — and reveals where mechanisms hold,
-- where they fail, where they need refinement.

CREATE TABLE IF NOT EXISTS case_applies_mechanism (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  mechanism_id  UUID NOT NULL REFERENCES mechanisms(id) ON DELETE CASCADE,
  how_it_applies TEXT NOT NULL,
  did_it_hold   BOOLEAN,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE case_applies_mechanism IS
  'Each case applies one or more mechanisms. For each application, Atelier records how the mechanism applies in this specific case and whether it held. Cases that surface mechanism failures are valuable — they refine the mechanism''s boundary.';


-- =====================================================
-- 5. PROJECTS — WORK ATELIER HAS DONE
-- =====================================================
-- Projects are different from cases. Cases are designs Atelier
-- examines; projects are work Atelier produces. The Myndlabs
-- site, a Kiesza tribute, a client website — each is a project.
--
-- A project carries its specification (voice, register, intent,
-- audience, constraints) as structural context. Atelier's
-- decisions within the project are evaluated against this
-- specification, not in the abstract.
--
-- Over time, the body of completed projects becomes part of
-- Atelier's character. Asked what kind of work it does, Atelier
-- can show projects and the reasoning that produced them.

CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  client          TEXT,
  brief           TEXT NOT NULL,
  voice           TEXT,
  register        TEXT,
  intent          TEXT,
  audience        TEXT,
  constraints     TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active',
    'paused',
    'shipped',
    'archived'
  )),
  output_url      TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);


-- A project decision is a discrete choice Atelier made within
-- the project — type pairing, color palette, hierarchy structure,
-- a specific section's design. Each decision cites the mechanisms
-- that justified it (where mechanism applies) and acknowledges
-- the taste decisions explicitly.

CREATE TABLE IF NOT EXISTS project_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision        TEXT NOT NULL,
  reasoning       TEXT NOT NULL,
  is_taste        BOOLEAN NOT NULL DEFAULT FALSE,
  taste_rationale TEXT,
  alternatives_considered TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN project_decisions.is_taste IS
  'TRUE when this decision is taste, not derivable from mechanism. Atelier is honest about which decisions are taste and which are mechanism-grounded. The character requires this honesty.';


-- A project decision links to the mechanisms it applies (when
-- mechanism applies) — making project work traceable to
-- Atelier's accumulated understanding.

CREATE TABLE IF NOT EXISTS decision_applies_mechanism (
  decision_id   UUID NOT NULL REFERENCES project_decisions(id) ON DELETE CASCADE,
  mechanism_id  UUID NOT NULL REFERENCES mechanisms(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, mechanism_id)
);


-- A project may reference cases — past designs that inform
-- the current decision.

CREATE TABLE IF NOT EXISTS decision_references_case (
  decision_id   UUID NOT NULL REFERENCES project_decisions(id) ON DELETE CASCADE,
  case_id       UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, case_id)
);


-- =====================================================
-- 6. INDEXES FOR THE NEW STRUCTURE
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
CREATE INDEX IF NOT EXISTS idx_entries_matured ON entries(matured_mechanism_id) WHERE matured_mechanism_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_unresolved_status ON unresolved_encounters(status);
CREATE INDEX IF NOT EXISTS idx_unresolved_source ON unresolved_encounters(source_id);

CREATE INDEX IF NOT EXISTS idx_case_applies_mechanism_case ON case_applies_mechanism(case_id);
CREATE INDEX IF NOT EXISTS idx_case_applies_mechanism_mechanism ON case_applies_mechanism(mechanism_id);

CREATE INDEX IF NOT EXISTS idx_project_decisions_project ON project_decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_decision_applies_mechanism_mechanism
  ON decision_applies_mechanism(mechanism_id);


-- =====================================================
-- 7. UPDATED_AT TRIGGERS FOR THE NEW TABLES
-- =====================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'mechanism_alternatives',
    'entries',
    'unresolved_encounters',
    'cases',
    'projects'
  ])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I; ' ||
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I ' ||
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t, t, t
    );
  END LOOP;
END$$;


-- =====================================================
-- 8. NOTES ON USAGE
-- =====================================================
--
-- READING A SOURCE:
--   For each substantive encounter in a chunk, Atelier produces
--   a structured working-through. The result lands as either:
--     - existing mechanism (citation added, possibly alternatives extended)
--     - new mechanism (with full alternatives, outside_boundary, what_it_means)
--     - new entry (worked-through with gaps explicitly named)
--     - unresolved encounter (substantive but unaccountable)
--     - non-claim (logged briefly but doesn't enter reasoning graph)
--
-- EXAMINING A DESIGN:
--   A case is created. Mechanisms applied are linked. Where the
--   mechanism held, the link records did_it_hold = TRUE. Where it
--   didn't, that's data — possibly the mechanism's boundary needs
--   refinement.
--
-- DOING A PROJECT:
--   A project record holds the brief, voice, register, intent.
--   Each decision Atelier makes within the project is recorded
--   with reasoning, mechanisms applied (or taste explicitly named),
--   alternatives considered, and cases referenced. The project
--   becomes part of Atelier's body of completed work.
--
-- The graph as a whole, with all these tables interlinked, is
-- Atelier's character. No prompt declares this character — the
-- structure embodies it.

