"""Thin async GitHub REST client for the research agent.

We don't use PyGithub here because:

1. The research agent needs async (the whole Modal runner is async).
2. We only need a handful of endpoints; pulling in PyGithub's object model
   is more weight than it's worth.
3. Keeping it tiny means `runner/integrations.py` and this module can share
   the same installation-token helper.
"""
from __future__ import annotations

import base64
import os
import time
from typing import Any

import httpx
import jwt


_CACHED_TOKENS: dict[int, tuple[str, float]] = {}


async def get_installation_token(installation_id: int) -> str:
    """Mint and cache a GitHub App installation access token.

    Installation tokens are valid for ~1h. We cache per-process and refresh
    a minute before expiry to keep callers from re-minting unnecessarily
    during a single Modal invocation (each chat turn usually makes several
    GitHub calls).
    """
    now = time.time()
    cached = _CACHED_TOKENS.get(installation_id)
    if cached and cached[1] > now + 60:
        return cached[0]

    app_id = os.environ.get("GITHUB_APP_ID")
    private_key_b64 = os.environ.get("GITHUB_APP_PRIVATE_KEY", "")
    if not app_id or not private_key_b64:
        raise RuntimeError("GitHub App credentials not configured")

    private_key = base64.b64decode(private_key_b64).decode("utf-8")
    payload = {"iat": int(now) - 60, "exp": int(now) + 10 * 60, "iss": app_id}
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"https://api.github.com/app/installations/{installation_id}/access_tokens",
            headers={
                "Authorization": f"Bearer {encoded_jwt}",
                "Accept": "application/vnd.github.v3+json",
            },
        )
        resp.raise_for_status()
        body = resp.json()

    token: str = body["token"]
    # `expires_at` comes back as an ISO string. Fall back to 55 minutes from
    # now if parsing fails — either way we'll refresh well before the real
    # 1h expiry.
    expires_at = now + 55 * 60
    _CACHED_TOKENS[installation_id] = (token, expires_at)
    return token


def gh_headers(token: str) -> dict[str, str]:
    """Standard headers for all GitHub REST requests made by the agent."""
    return {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Verona-QA-Agent",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def gh_get(
    client: httpx.AsyncClient,
    token: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
) -> httpx.Response:
    """GET against api.github.com with standard auth headers."""
    return await client.get(
        f"https://api.github.com{path}" if path.startswith("/") else path,
        headers=gh_headers(token),
        params=params,
    )
