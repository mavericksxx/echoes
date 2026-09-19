-- Phase 11: the village evolves itself. A daily cron agent (worker/
-- village-agent.ts) calls a fixed toolset (set_district_activity,
-- set_weather, start_festival, set_time_of_day, send_visitor,
-- set_character_mood — shared/world.ts's WorldState/Timed<T> is what its
-- validated diffs write into), and these three tables are how that's
-- persisted and made replayable. Purely additive — no existing table
-- touched.

-- Single-row (id=1) snapshot of the raw WorldState (shared/world.ts) as
-- JSON — GET /api/world reads this, runs it through effectiveWorld() to
-- drop expired entries, and returns the result. The raw (not pre-pruned)
-- state is kept here so a just-expired entry is still visible to whichever
-- agent_run wrote it (see agent_event.after) rather than silently vanishing
-- from the only copy.
CREATE TABLE world_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL, -- JSON, shared/world.ts's WorldState
  updated_at TEXT NOT NULL -- ISO timestamp of the last write to `state`
);

-- One row per owner-local day (wrangler.jsonc's OWNER_TZ var) the agent has
-- run or attempted to run — same "ready vs pending" convention as
-- weekly_brief (migrations/0009): 'pending' means a real attempt was made
-- and failed/hit quota, eligible for a retry on a later cron tick; 'ready'
-- is done for good, whether or not it actually changed anything.
CREATE TABLE agent_run (
  run_date TEXT PRIMARY KEY, -- owner-local "YYYY-MM-DD"
  status TEXT NOT NULL, -- 'ready' | 'pending'
  last_attempt_at TEXT NOT NULL, -- ISO timestamp of the most recent attempt
  state_before TEXT NOT NULL, -- JSON WorldState snapshot before this run's calls
  state_after TEXT NOT NULL, -- JSON WorldState snapshot after this run's calls
  summary TEXT NOT NULL -- short in-character line describing what changed, "" if nothing did
);

-- Every tool call the agent made on a given run, accepted or not — Phase
-- 12's chronicle replays a day by walking these in id order. `before`/
-- `after` are the narrow slice of WorldState that one call touched (e.g.
-- just that slot's Timed<ActivityLevel>), not the whole state, so a replay
-- can show a single step's diff without re-deriving it from state_before/
-- state_after.
CREATE TABLE agent_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL REFERENCES agent_run(run_date),
  tool TEXT NOT NULL, -- e.g. 'set_weather', 'start_festival'
  args TEXT NOT NULL, -- JSON, the tool call's raw arguments as Gemini sent them
  reasoning TEXT NOT NULL, -- short in-character explanation, shown in the chronicle
  before TEXT NOT NULL, -- JSON, the touched slice of WorldState pre-call ("null" if new)
  after TEXT NOT NULL, -- JSON, the touched slice of WorldState post-call ("null" if rejected)
  created_at TEXT NOT NULL -- ISO timestamp
);

CREATE INDEX idx_agent_event_run_date ON agent_event(run_date);
