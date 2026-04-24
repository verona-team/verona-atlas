"""Verona chat turn orchestration on Modal.

This package owns the full lifecycle of a chat turn:

- `turn.run_chat_turn` is the entry point called from Modal's
  `process_chat_turn` function. It handles session/status plumbing and
  delegates the actual agent loop to `graph.agent_app`.
- `graph` is the compiled LangGraph StateGraph. Nodes live under
  `nodes/` (one file per node) and the edges are wired here.
- `tools.py` defines the LangChain tools exposed to the orchestrator
  LLM (`generate_flow_proposals`, `start_test_run`). The tool schemas
  are what the orchestrator model sees; the actual side-effecting work
  happens in matching nodes under `nodes/`.
- `nightly.py` is the cron-triggered counterpart of `turn.run_chat_turn`
  and shares most of the same plumbing.
- `context.py`, `flow_generator.py`, `prompts.py` are ports of their TS
  counterparts under `lib/chat/`.

Invariants:

- The shape of rows written to `chat_messages` (especially
  `metadata.type = 'flow_proposals' | 'test_run_started' | 'live_session'`)
  is the contract with the React UI. Do NOT change it here without a
  matching client change.
- Supabase is the single source of truth for conversation state. The
  LangGraph is compiled WITHOUT a checkpointer on purpose — state
  persistence is DB-driven, not checkpoint-driven.
"""
