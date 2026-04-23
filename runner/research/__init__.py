"""Python port of the TS research agent (`lib/research-agent/*`).

The research agent produces a `ResearchReport` for a given project — a
structured understanding of what's happening in the app (recent commits,
errors, user friction, codebase structure) that downstream flow-proposer
LLM calls use as grounding.

## Two tracks

- `integration_agent`: hits integration APIs directly (GitHub, PostHog,
  Sentry, LangSmith, Braintrust) via typed Python tools invoked by a
  Claude Sonnet ReAct loop. Replaces the TS "LLM writes arbitrary JS and
  we run it in a Vercel Sandbox" pattern — same signal, simpler surface,
  no sandbox dependency.

- `codebase_agent`: walks the linked GitHub repo via tree/list-path/read-file
  tools to build a `CodebaseExplorationResult`.

## Why Sonnet, not Opus

Both tracks are well-scoped tasks with predictable tool shapes. Sonnet gets
them done cost-effectively and is fast enough that research doesn't
bottleneck chat bootstrap turns. Opus is reserved for the orchestrator in
`runner.chat.graph`.

## Output shape parity

`ResearchReport` here is pydantic, but round-trips through `model_dump()`
to the same JSON shape as the TS `researchReportSchema`. The
`chat_sessions.research_report` column is the contract; both readers
(Python + TS `normalizeResearchReport`) must continue to parse what either
side writes.
"""
