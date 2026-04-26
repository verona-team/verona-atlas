"""Shared mental-model preamble for every LLM in the research-to-flows pipeline.

Every LLM in this codebase that participates in research, synthesis, or
flow proposal generation imports `SYSTEM_PURPOSE_OVERVIEW` and opens its
own system prompt with it. The motivation is concrete: when a single
upstream LLM (e.g. the codebase exploration agent) drifts in its
understanding of *why* it exists, every downstream LLM inherits that
drift. Anchoring all of them to the same one-paragraph product purpose
keeps the pipeline coherent.

Treat this constant as load-bearing — changes to its wording propagate
to four+ prompts in one go, which is intentional. If you need to tweak
the framing for a single call site, customize that prompt's own role
section *after* the overview, don't fork the overview itself.

The wording deliberately avoids generic "QA / testing" framing in favor
of the system's actual product behavior:

- An autonomous AI browser agent walks long-horizon UI flows in a real
  browser against the customer's deployed web app.
- The whole research pipeline exists to choose which long-horizon UI
  flows the agent should bug-bash right now.
- "Long-horizon UI flow" means a multi-step user journey a real human
  would actually walk in a typical session, not a single click or a
  synthetic micro-test.
- Two flow categories matter: load-bearing CORE flows that real users
  walk every session, and RISK-ANCHORED flows routed through code paths
  with fresh evidence of risk (PR churn, errors, rage-clicks).
"""
from __future__ import annotations


SYSTEM_PURPOSE_OVERVIEW = """# What this product does (mental model for every LLM in this pipeline)

This product runs an autonomous AI browser agent that bug-bashes a customer's deployed web app. The customer connects their GitHub repo and observability integrations (PostHog, Sentry, LangSmith, Braintrust); the system continuously decides which long-horizon UI flows the agent should walk, then runs them in a real browser against the live app and reports on what broke.

A "long-horizon UI flow" is a multi-step user journey a real human actually performs in the product — for example "sign in, open a sheet, add three columns, edit a cell, reload, confirm the edit persisted" — NOT a single click, a synthetic stress test, or a "verify the API returns 200" probe. The agent's value comes from walking the same journeys real users walk and catching what those users would hit.

Every LLM in this research-to-flows pipeline (codebase exploration, integration research, codebase synthesis, unified flow synthesis, flow-proposal generation) exists to feed one final decision: which long-horizon UI flows is it most valuable for the autonomous browser agent to bug-bash right now? Two kinds of flows are valuable:

1. CORE flows — load-bearing journeys real users walk every session (auth, the product's main "verb", primary CRUD, settings, billing, sharing). Worth bug-bashing regardless of what changed recently because if they break, every user feels it.
2. RISK-ANCHORED flows — the same multi-step user journey shape, but deliberately routed through code paths or pages that recent evidence flags as risky (heavy PR churn, fresh Sentry errors, PostHog rage-clicks, failing LangSmith traces). Worth bug-bashing right now because something concrete just changed or broke and real users will hit it next.

Both kinds of flow must read as something a real user would actually do in a real session. If a proposed flow looks like a synthetic micro-test, an API smoke check, or a single-click "does the page load" probe, it does NOT belong in this product's output."""
