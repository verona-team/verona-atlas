"""Python port of the TS research agent (`lib/research-agent/*`).

The research agent produces a `ResearchReport` for a given project — a
structured understanding of what's happening in the app (recent commits,
errors, user friction, codebase structure) that downstream flow-proposer
LLM calls use as grounding.

## Two tracks

- `integration_agent`: hits integration APIs directly (GitHub, PostHog,
  Sentry, LangSmith, Braintrust) via typed Python tools invoked by a
  Gemini 3.1 Pro ReAct loop. Replaces the TS "LLM writes arbitrary JS and
  we run it in a Vercel Sandbox" pattern — same signal, simpler surface,
  no sandbox dependency.

- `codebase_agent`: walks the linked GitHub repo via tree/list-path/read-file
  tools to build a `CodebaseExplorationResult`, also using Gemini 3.1 Pro.

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
