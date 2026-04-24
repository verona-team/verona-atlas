"""Regression tests for the multi-turn flow-proposal lifecycle.

Covers the pure parts of the design (no Supabase, no LLM):

- `dedupe_and_avoid` renames only *accidental* id collisions (different name)
  and keeps intentional re-emissions (same id, same name).
- `serialize_flows_for_message` carries over approval state iff the new
  flow's id was re-emitted from the prior row; everything else is `pending`.
- The persisted metadata shape is exactly what the React UI expects:
  `type`, `status='active'`, `superseded_by_message_id=None`, `proposals`,
  `flow_states`.

Runnable standalone from the repo root:

    python3 -m runner.chat.test_flow_proposal_lifecycle
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("SUPABASE_URL", "https://x")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "x")
os.environ.setdefault("ANTHROPIC_API_KEY", "x")

from runner.chat.flow_generator import (
    FlowProposals,
    PriorFlowSummary,
    ProposedFlow,
    TemplateStep,
    dedupe_and_avoid,
    serialize_flows_for_message,
)


def _green(s: str) -> str:
    return f"\033[32m{s}\033[0m"


def _red(s: str) -> str:
    return f"\033[31m{s}\033[0m"


def _mk_flow(fid: str, name: str, *, step_text: str = "go") -> ProposedFlow:
    return ProposedFlow(
        id=fid,
        name=name,
        description="desc",
        rationale="rationale",
        priority="high",
        steps=[
            TemplateStep(
                order=1,
                instruction=step_text,
                type="navigate",
                url="https://x",
            )
        ],
    )


def test_bootstrap_no_renames() -> None:
    """With no prior context, dedupe_and_avoid is a pass-through."""
    flows = [_mk_flow("login-happy-path", "Login Happy Path"), _mk_flow("checkout-smoke", "Checkout Smoke")]
    out = dedupe_and_avoid(flows)
    assert [f.id for f in out] == ["login-happy-path", "checkout-smoke"]
    print(_green("  ok: bootstrap passes ids through unchanged"))


def test_within_batch_dedup() -> None:
    """Two new flows with the same id get suffixed."""
    flows = [_mk_flow("dup", "One"), _mk_flow("dup", "Two")]
    out = dedupe_and_avoid(flows)
    assert [f.id for f in out] == ["dup", "dup-2"]
    print(_green("  ok: within-batch dup is suffixed"))


def test_intentional_reemission_kept() -> None:
    """Same id + same name as a prior flow is an intentional preservation."""
    prior = [
        PriorFlowSummary(id="login", name="Login Happy Path", rationale="r", state="approved"),
    ]
    flows = [_mk_flow("login", "Login Happy Path"), _mk_flow("signup", "Signup Funnel Dropoff")]
    out = dedupe_and_avoid(flows, prior_flows=prior, avoid_ids=["login"])
    assert [f.id for f in out] == ["login", "signup"]
    print(_green("  ok: intentional re-emission keeps id"))


def test_accidental_collision_renamed() -> None:
    """Same id but different name is treated as accidental and renamed."""
    prior = [
        PriorFlowSummary(id="login", name="Login Happy Path", rationale="r", state="approved"),
    ]
    flows = [_mk_flow("login", "Signup Funnel Dropoff"), _mk_flow("other", "Other")]
    out = dedupe_and_avoid(flows, prior_flows=prior, avoid_ids=["login"])
    assert out[0].id == "login-2", f"expected login-2, got {out[0].id}"
    assert out[1].id == "other"
    print(_green("  ok: accidental collision (name mismatch) is suffixed"))


def test_name_whitespace_case_insensitive() -> None:
    """Name match is loose: case and collapsed-whitespace insensitive."""
    prior = [
        PriorFlowSummary(id="login", name="Login Happy Path", rationale="r", state="approved"),
    ]
    flows = [_mk_flow("login", "  login   HAPPY path  ")]
    out = dedupe_and_avoid(flows, prior_flows=prior, avoid_ids=["login"])
    assert out[0].id == "login", f"expected login (loose match), got {out[0].id}"
    print(_green("  ok: loose name match preserves id across whitespace/case"))


def test_carry_over_only_on_matched_id() -> None:
    """Approved/rejected state carries iff the new flow's id matches a prior id."""
    prior = [
        PriorFlowSummary(id="a", name="A", rationale="r", state="approved"),
        PriorFlowSummary(id="b", name="B", rationale="r", state="rejected"),
    ]
    prior_states = {"a": "approved", "b": "rejected", "c": "pending"}
    fp = FlowProposals(
        analysis="a",
        flows=[_mk_flow("a", "A"), _mk_flow("newflow", "NewFlow")],
    )
    _, metadata, _ = serialize_flows_for_message(
        fp,
        prior_flow_states=prior_states,
        prior_flows=prior,
        avoid_ids=["a", "b"],
    )
    assert metadata["type"] == "flow_proposals"
    assert metadata["status"] == "active"
    assert metadata["superseded_by_message_id"] is None
    assert metadata["flow_states"] == {"a": "approved", "newflow": "pending"}, metadata["flow_states"]
    print(_green("  ok: only id-matched flows carry over; new flows start pending"))


def test_clean_slate_zero_carry_over() -> None:
    """Fresh-slate regeneration (all new ids) carries over nothing."""
    prior = [
        PriorFlowSummary(id="a", name="A", rationale="r", state="approved"),
        PriorFlowSummary(id="b", name="B", rationale="r", state="approved"),
    ]
    prior_states = {"a": "approved", "b": "approved"}
    fp = FlowProposals(
        analysis="a",
        flows=[_mk_flow("x", "X"), _mk_flow("y", "Y")],
    )
    _, metadata, _ = serialize_flows_for_message(
        fp,
        prior_flow_states=prior_states,
        prior_flows=prior,
        avoid_ids=["a", "b"],
    )
    assert metadata["flow_states"] == {"x": "pending", "y": "pending"}, metadata["flow_states"]
    print(_green("  ok: clean-slate regeneration loses all prior approvals"))


def test_accidental_collision_loses_carry_over() -> None:
    """Renamed accidental collisions must NOT inherit the prior approval state."""
    prior = [
        PriorFlowSummary(id="login", name="Login Happy Path", rationale="r", state="approved"),
    ]
    prior_states = {"login": "approved"}
    # LLM emits a different flow that happens to reuse the "login" id.
    fp = FlowProposals(
        analysis="a",
        flows=[_mk_flow("login", "Signup Funnel Dropoff")],
    )
    _, metadata, _ = serialize_flows_for_message(
        fp,
        prior_flow_states=prior_states,
        prior_flows=prior,
        avoid_ids=["login"],
    )
    # The flow was renamed to login-2 before carry-over, so no state is inherited.
    assert metadata["flow_states"] == {"login-2": "pending"}, metadata["flow_states"]
    print(_green("  ok: renamed collision starts pending (no silent carry-over)"))


def main() -> None:
    print("running flow_proposal lifecycle tests:")
    test_bootstrap_no_renames()
    test_within_batch_dedup()
    test_intentional_reemission_kept()
    test_accidental_collision_renamed()
    test_name_whitespace_case_insensitive()
    test_carry_over_only_on_matched_id()
    test_clean_slate_zero_carry_over()
    test_accidental_collision_loses_carry_over()
    print(_green("all tests passed"))


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(_red(f"ASSERTION FAILED: {e}"))
        sys.exit(1)
    except Exception as e:
        import traceback

        print(_red(f"UNEXPECTED ERROR: {type(e).__name__}: {e}"))
        traceback.print_exc()
        sys.exit(2)
