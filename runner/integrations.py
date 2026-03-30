"""
Integration API clients for the Modal runner.
Fetches data from GitHub and PostHog for test planning.
"""
import os
import time
import jwt
import httpx
from datetime import datetime, timezone, timedelta
from runner.encryption import decrypt


async def fetch_recent_commits(config: dict, since_days: int = 7) -> list[dict]:
    """Fetch recent commits from a GitHub repository."""
    installation_id = config.get("installation_id")
    repos = config.get("repos", [])
    
    if not installation_id or not repos:
        return []
    
    # Generate installation access token
    token = await get_github_installation_token(int(installation_id))
    
    since = (datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()
    
    all_commits = []
    async with httpx.AsyncClient() as client:
        for repo in repos[:3]:  # Limit to 3 repos
            response = await client.get(
                f"https://api.github.com/repos/{repo}/commits",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github.v3+json",
                },
                params={"since": since, "per_page": 20},
            )
            
            if response.status_code == 200:
                for c in response.json():
                    all_commits.append({
                        "sha": c["sha"][:8],
                        "message": c["commit"]["message"][:200],
                        "date": c["commit"]["author"]["date"],
                        "author": c["commit"]["author"]["name"],
                        "repo": repo,
                    })
    
    return all_commits


async def get_github_installation_token(installation_id: int) -> str:
    """Generate a GitHub App installation access token via JWT."""
    app_id = os.environ.get("GITHUB_APP_ID")
    private_key_b64 = os.environ.get("GITHUB_APP_PRIVATE_KEY", "")
    
    if not app_id or not private_key_b64:
        raise ValueError("GitHub App credentials not configured")
    
    import base64
    private_key = base64.b64decode(private_key_b64).decode("utf-8")
    
    # Create JWT
    now = int(time.time())
    payload = {
        "iat": now - 60,
        "exp": now + (10 * 60),
        "iss": app_id,
    }
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    
    # Exchange JWT for installation token
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"https://api.github.com/app/installations/{installation_id}/access_tokens",
            headers={
                "Authorization": f"Bearer {encoded_jwt}",
                "Accept": "application/vnd.github.v3+json",
            },
        )
        response.raise_for_status()
        return response.json()["token"]


async def fetch_posthog_sessions(config: dict, limit: int = 30) -> list[dict]:
    """Fetch recent session recordings from PostHog."""
    api_key_encrypted = config.get("api_key_encrypted")
    project_id = config.get("posthog_project_id")
    api_host = config.get("api_host", "https://app.posthog.com")
    
    if not api_key_encrypted or not project_id:
        return []
    
    api_key = decrypt(api_key_encrypted)
    
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{api_host}/api/projects/{project_id}/session_recordings/",
            headers={"Authorization": f"Bearer {api_key}"},
            params={"limit": limit},
        )
        
        if response.status_code != 200:
            return []
        
        data = response.json()
        return data.get("results", [])


async def fetch_posthog_errors(config: dict, since_days: int = 7) -> list[dict]:
    """Fetch recent error events from PostHog using HogQL."""
    api_key_encrypted = config.get("api_key_encrypted")
    project_id = config.get("posthog_project_id")
    api_host = config.get("api_host", "https://app.posthog.com")
    
    if not api_key_encrypted or not project_id:
        return []
    
    api_key = decrypt(api_key_encrypted)
    date_from = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime("%Y-%m-%d")
    
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{api_host}/api/projects/{project_id}/query/",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "query": {
                    "kind": "HogQLQuery",
                    "query": (
                        f"SELECT properties.$current_url, properties.$exception_type, "
                        f"properties.$exception_message, count() as count "
                        f"FROM events "
                        f"WHERE event = '$exception' AND timestamp > '{date_from}' "
                        f"GROUP BY properties.$current_url, properties.$exception_type, "
                        f"properties.$exception_message "
                        f"ORDER BY count DESC LIMIT 30"
                    ),
                }
            },
        )
        
        if response.status_code != 200:
            return []
        
        return response.json().get("results", [])
