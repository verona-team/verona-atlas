"""Python port of the TS research agent (`lib/research-agent/*`).

The research agent produces a `ResearchReport` for a given project — a
structured understanding of what's happening in the app (recent commits,
errors, user friction, codebase structure) that downstream flow-proposer
LLM calls use as grounding.

## Two investigation tracks + two synthesis calls

Each track produces a raw `*Transcript` — the full investigation log,
including tool calls and the investigator's natural-language
reasoning. Synthesis happens in a separate stage (see
`runner.research.synthesizer`) so each LLM call can have a narrowly
focused prompt.

- `integration_agent`: hits integration APIs directly (GitHub, PostHog,
  Sentry, LangSmith, Braintrust) via a sandbox-backed ReAct loop.
  Produces an `IntegrationTranscript` carrying preflight results + all
  `execute_code` drill-in calls + orchestrator thoughts.

- `codebase_agent`: walks the linked GitHub repo via tree /
  list-path / read-file tools. Produces a `CodebaseTranscript`
  carrying all tool calls + investigator thoughts + a natural-language
  orientation handoff emitted when the ReAct loop stops.

- `synthesizer`: two parallel LLM calls over the transcripts.
    1. `generate_codebase_exploration(cb)` → `CodebaseExplorationResult`
       (describe the repo).
    2. `generate_flow_report(cb, intg, app_url)` → flow-focused
       structured output (core + risk-focused long-horizon flows,
       findings, drill-in highlights).

- `orchestrator`: drives the two transcripts + two synthesis calls (all
  in parallel pairs) and stitches results into a `ResearchReport`.

## Model choice

Both tracks run on Gemini 3.1 Pro. They are well-scoped tasks with
predictable tool shapes, but they do nuanced cross-provider correlation
(integration_agent) and architectural inference (codebase_agent), so we
want the strongest reasoning model the runner ships with. The chat
orchestrator in `runner.chat.graph` also runs on Gemini 3.1 Pro.

## Output shape parity

`ResearchReport` here is pydantic, but round-trips through `model_dump()`
to the same JSON shape as the TS `researchReportSchema`. The
`chat_sessions.research_report` column is the contract; both readers
(Python + TS `normalizeResearchReport`) must continue to parse what either
side writes.
"""
