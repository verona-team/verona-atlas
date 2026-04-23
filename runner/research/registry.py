"""Integration registry — credential and docs metadata per integration type.

Port of `lib/integrations/registry.ts`, minus the `buildAuthHeaders` bit:
the TS version returned host-keyed Vercel-Sandbox allow rules so the LLM
could write arbitrary JS with auto-injected auth. The Python runner calls
integration APIs via typed tools (not arbitrary code), so we just need to
know which integrations exist and what credential keys to resolve.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class IntegrationSpec:
    """Metadata for a supported integration type.

    `credential_keys` documents what the tool function will extract from the
    `integrations.config` row (after decryption). Kept declarative so the
    research agent's typed tools can validate upstream before calling.
    """

    docs_url: str
    api_hosts: tuple[str, ...]
    credential_keys: tuple[str, ...]


INTEGRATION_REGISTRY: dict[str, IntegrationSpec] = {
    "github": IntegrationSpec(
        docs_url="https://docs.github.com/en/rest/commits/commits",
        api_hosts=("api.github.com",),
        credential_keys=("installation_id",),
    ),
    "posthog": IntegrationSpec(
        docs_url="https://posthog.com/docs/api",
        api_hosts=(
            "us.posthog.com",
            "eu.posthog.com",
            "us.i.posthog.com",
            "eu.i.posthog.com",
        ),
        credential_keys=("api_key_encrypted", "posthog_project_id", "api_host"),
    ),
    "sentry": IntegrationSpec(
        docs_url="https://docs.sentry.io/api/",
        api_hosts=("sentry.io",),
        credential_keys=("auth_token_encrypted", "organization_slug", "project_slug"),
    ),
    "langsmith": IntegrationSpec(
        docs_url="https://docs.langchain.com/langsmith/reference",
        api_hosts=("api.smith.langchain.com",),
        credential_keys=("api_key_encrypted", "project_name"),
    ),
    "braintrust": IntegrationSpec(
        docs_url="https://www.braintrust.dev/docs/api-reference/introduction",
        api_hosts=("api.braintrust.dev",),
        credential_keys=("api_key_encrypted", "braintrust_project_name"),
    ),
}


def supported_integration_types() -> list[str]:
    return list(INTEGRATION_REGISTRY.keys())
