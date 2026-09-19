// Phase 12: "village chronicle" (SPEC.md — "Timeline UI of agent decisions
// with reasoning; replay a past day's changes"). GET /api/chronicle is
// D1-only, read-only: it never triggers a Gemini or Spotify call, since
// generation is entirely worker/village-agent.ts's cron job. It just returns
// what that job already wrote to agent_run/agent_event
// (migrations/0010_village_agent.sql), newest run first, capped to the last
// MAX_RUN_DAYS days, with each run's own agent_event rows in id order — the
// exact order src/sidebar.ts's replay needs to walk them in.

import type { Env } from "./index";
import { parseWorldState } from "./village-agent";
import type { ChronicleEvent, ChronicleResponse, ChronicleRun } from "../shared/world";

// SPEC.md's Phase 12 task: "cap ~30 days". The agent runs at most once a
// day (worker/village-agent.ts's RUN_HOUR_OWNER_LOCAL gate), so this is
// "the whole chronicle" in practice for a long while yet.
const MAX_RUN_DAYS = 30;

interface RunRow {
  run_date: string;
  status: "ready" | "pending";
  last_attempt_at: string;
  state_before: string;
  state_after: string;
  summary: string;
}

interface EventRow {
  id: number;
  run_date: string;
  tool: string;
  args: string;
  reasoning: string;
  before: string;
  after: string;
  created_at: string;
}

function safeParseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function handleChronicle(env: Env): Promise<Response> {
  const { results: runRows } = await env.DB.prepare(
    "SELECT run_date, status, last_attempt_at, state_before, state_after, summary FROM agent_run ORDER BY run_date DESC LIMIT ?",
  )
    .bind(MAX_RUN_DAYS)
    .all<RunRow>();

  // Handled explicitly (not just "the loop below runs zero times") so the
  // second query never fires an `IN ()` with no placeholders.
  if (runRows.length === 0) {
    return Response.json({ runs: [] } satisfies ChronicleResponse);
  }

  const runDates = runRows.map((r) => r.run_date);
  const placeholders = runDates.map(() => "?").join(",");
  const { results: eventRows } = await env.DB.prepare(
    `SELECT id, run_date, tool, args, reasoning, before, after, created_at
     FROM agent_event WHERE run_date IN (${placeholders}) ORDER BY id ASC`,
  )
    .bind(...runDates)
    .all<EventRow>();

  // Grouped by run_date, preserving the query's ascending id order within
  // each group — a Map insertion-orders its values array per key, so this
  // needs no extra sort.
  const eventsByRun = new Map<string, ChronicleEvent[]>();
  for (const row of eventRows) {
    const list = eventsByRun.get(row.run_date) ?? [];
    list.push({
      id: row.id,
      tool: row.tool,
      args: safeParseJson(row.args, {}),
      reasoning: row.reasoning,
      before: safeParseJson<unknown>(row.before, null),
      after: safeParseJson<unknown>(row.after, null),
      createdAt: row.created_at,
    });
    eventsByRun.set(row.run_date, list);
  }

  const runs: ChronicleRun[] = runRows.map((r) => ({
    runDate: r.run_date,
    status: r.status,
    summary: r.summary,
    lastAttemptAt: r.last_attempt_at,
    stateBefore: parseWorldState(r.state_before),
    stateAfter: parseWorldState(r.state_after),
    events: eventsByRun.get(r.run_date) ?? [],
  }));

  return Response.json({ runs } satisfies ChronicleResponse);
}
