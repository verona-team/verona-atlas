"""Bounded GitHub REST access for repository exploration (tree + file reads).

Python port of `lib/github-repo-explorer.ts`. Used by `codebase_agent` as
the backing implementation for its tool functions — all limits are
server-enforced so the LLM cannot accidentally DoS us by asking for huge
listings.

Parity notes vs TS:
- Same skip prefixes and binary-file extensions, same priority scoring for
  `suggest_important_paths`.
- `get_text_file_content` returns a dataclass rather than a tagged union;
  consumers should check `ok` before reading `content`.
- Tree listing uses the Git Trees API with `recursive=1`; identical cap to
  TS (`DEFAULT_MAX_TREE_NODES = 40_000`).
"""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any

import httpx

from .github_client import gh_get


DEFAULT_MAX_TREE_NODES = 40_000
DEFAULT_MAX_LIST_PATHS = 400
DEFAULT_MAX_FILE_CHARS = 100_000
DEFAULT_MAX_PATH_MATCHES = 200

_SKIP_DIR_PREFIXES = (
    "node_modules/",
    ".git/",
    "dist/",
    "build/",
    ".next/",
    "coverage/",
    ".turbo/",
    "vendor/",
    "__pycache__/",
    ".venv/",
    "venv/",
)

_SKIP_FILE_EXT = frozenset(
    {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
        ".pdf", ".zip", ".tar", ".gz",
        ".woff", ".woff2", ".ttf", ".eot",
        ".mp4", ".mp3", ".wasm",
        ".exe", ".dll", ".so", ".dylib",
        ".lock",
    }
)

_PREFERRED_TEXT_EXT = frozenset(
    {
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
        ".json", ".md", ".mdx",
        ".css", ".scss", ".html",
        ".yml", ".yaml", ".toml",
        ".env", ".example",
        ".sql", ".graphql",
        ".rs", ".go", ".py", ".rb", ".java", ".kt", ".swift",
        ".vue", ".svelte",
    }
)


@dataclass(frozen=True)
class RepoRef:
    """Owner/repo split of a `owner/repo` string."""

    owner: str
    repo: str


def parse_repo_full_name(full_name: str) -> RepoRef | None:
    """Parse `owner/repo` into a RepoRef, or None if malformed."""
    parts = [p for p in full_name.split("/") if p]
    if len(parts) != 2:
        return None
    return RepoRef(owner=parts[0], repo=parts[1])


def _should_skip_path(path: str) -> bool:
    lower = path.lower()
    for p in _SKIP_DIR_PREFIXES:
        if f"/{p}" in lower or lower.startswith(p):
            return True
    base = path.split("/")[-1] if "/" in path else path
    dot = base.rfind(".")
    if dot >= 0:
        ext = base[dot:].lower()
        if ext in _SKIP_FILE_EXT:
            return True
    return False


def _get_ext(path: str) -> str:
    base = path.split("/")[-1] if "/" in path else path
    dot = base.rfind(".")
    if dot < 0:
        return ""
    return base[dot:].lower()


@dataclass
class TreeBuildResult:
    paths: list[str]
    default_branch: str
    truncated: bool
    total_nodes_seen: int
    warnings: list[str] = field(default_factory=list)


async def build_filtered_repo_paths(
    client: httpx.AsyncClient,
    token: str,
    ref: RepoRef,
    *,
    max_nodes: int = DEFAULT_MAX_TREE_NODES,
) -> TreeBuildResult:
    """Load full recursive tree for the default branch, filter to source paths.

    Uses the sequence repos.get -> git.getRef -> git.getCommit -> git.getTree
    to match the TS version exactly; this guarantees we hit the same
    truncation boundaries and enables diffing TS vs Python runs if we ever
    want to validate parity.
    """
    warnings: list[str] = []

    repo_resp = await gh_get(client, token, f"/repos/{ref.owner}/{ref.repo}")
    repo_resp.raise_for_status()
    default_branch = repo_resp.json().get("default_branch") or "main"

    ref_resp = await gh_get(
        client, token, f"/repos/{ref.owner}/{ref.repo}/git/ref/heads/{default_branch}"
    )
    ref_resp.raise_for_status()
    commit_sha = ref_resp.json()["object"]["sha"]

    commit_resp = await gh_get(
        client, token, f"/repos/{ref.owner}/{ref.repo}/git/commits/{commit_sha}"
    )
    commit_resp.raise_for_status()
    tree_sha = commit_resp.json()["tree"]["sha"]

    tree_resp = await gh_get(
        client,
        token,
        f"/repos/{ref.owner}/{ref.repo}/git/trees/{tree_sha}",
        params={"recursive": "1"},
    )
    tree_resp.raise_for_status()
    tree = tree_resp.json()

    truncated = bool(tree.get("truncated"))
    if truncated:
        warnings.append(
            "GitHub returned a truncated tree — some paths may be missing. "
            "Prefer targeted reads under app/, src/, packages/."
        )

    raw_tree = tree.get("tree") or []
    paths: list[str] = []
    for entry in raw_tree:
        if entry.get("type") != "blob":
            continue
        p = entry.get("path")
        if not isinstance(p, str):
            continue
        if _should_skip_path(p):
            continue
        paths.append(p)
        if len(paths) >= max_nodes:
            warnings.append(
                f"Stopped indexing after {max_nodes} source-like paths (cap)."
            )
            break

    paths.sort()

    return TreeBuildResult(
        paths=paths,
        default_branch=default_branch,
        truncated=truncated,
        total_nodes_seen=len(raw_tree),
        warnings=warnings,
    )


def filter_paths(
    all_paths: list[str],
    *,
    prefix: str | None = None,
    substring: str | None = None,
    glob_suffix: str | None = None,
    max_results: int = DEFAULT_MAX_LIST_PATHS,
) -> tuple[list[str], bool]:
    """Filter a precomputed path list; returns (paths, truncated)."""
    cur = all_paths

    if prefix and prefix.strip():
        p = prefix.lstrip("/")
        cur = [x for x in cur if x == p or x.startswith(f"{p}/")]
    if substring and substring.strip():
        s = substring.lower()
        cur = [x for x in cur if s in x.lower()]
    if glob_suffix and glob_suffix.strip():
        suf = glob_suffix if glob_suffix.startswith(".") else f".{glob_suffix}"
        suf = suf.lower()
        cur = [x for x in cur if x.lower().endswith(suf)]

    truncated = len(cur) > max_results
    return cur[:max_results], truncated


@dataclass
class FileReadResult:
    ok: bool
    content: str | None = None
    size: int | None = None
    truncated: bool = False
    error: str | None = None


async def get_text_file_content(
    client: httpx.AsyncClient,
    token: str,
    ref: RepoRef,
    path: str,
    git_ref: str,
    *,
    max_chars: int = DEFAULT_MAX_FILE_CHARS,
) -> FileReadResult:
    """Fetch one text file via the GitHub Contents API (base64-decoded UTF-8)."""
    normalized = path.lstrip("/")
    try:
        resp = await gh_get(
            client,
            token,
            f"/repos/{ref.owner}/{ref.repo}/contents/{normalized}",
            params={"ref": git_ref},
        )
        if resp.status_code == 404:
            return FileReadResult(ok=False, error=f"Not found: {path}")
        resp.raise_for_status()
        data: Any = resp.json()
    except httpx.HTTPError as e:
        return FileReadResult(ok=False, error=str(e))

    if isinstance(data, list):
        return FileReadResult(ok=False, error="Path is a directory, not a file")
    if not isinstance(data, dict) or data.get("type") != "file":
        return FileReadResult(ok=False, error="Not a file")

    size = int(data.get("size") or 0)
    if size > max_chars * 2:
        return FileReadResult(
            ok=False,
            error=f"File is too large ({size} bytes). Max approx {max_chars} characters.",
        )

    content_b64 = data.get("content")
    if data.get("encoding") != "base64" or not isinstance(content_b64, str):
        return FileReadResult(ok=False, error="Could not decode file content")

    try:
        raw = base64.b64decode(content_b64.replace("\n", ""))
    except Exception as e:
        return FileReadResult(ok=False, error=f"Base64 decode failed: {e}")

    if b"\x00" in raw:
        return FileReadResult(ok=False, error="Binary file — skipped")

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return FileReadResult(ok=False, error="Non-UTF8 content")

    truncated = len(text) > max_chars
    if truncated:
        text = text[:max_chars]
    return FileReadResult(ok=True, content=text, size=len(raw), truncated=truncated)


def suggest_important_paths(paths: list[str]) -> list[str]:
    """Return up to 25 likely-important paths (configs, routes, README).

    Same scoring heuristic as the TS version so both sides produce the same
    ordering given the same tree.
    """
    scored: list[tuple[int, str]] = []
    for p in paths:
        lower = p.lower()
        score = 0
        if "package.json" in lower:
            score += 50
        if "readme" in lower:
            score += 20
        if "/app/" in lower or lower.startswith("app/"):
            score += 15
        if "/src/" in lower or lower.startswith("src/"):
            score += 12
        if "/pages/" in lower or lower.startswith("pages/"):
            score += 12
        if "routes" in lower:
            score += 10
        if "next.config" in lower:
            score += 8
        if "vite.config" in lower:
            score += 8
        if _get_ext(p) in _PREFERRED_TEXT_EXT:
            score += 3
        if score > 0:
            scored.append((score, p))

    scored.sort(key=lambda t: (-t[0], t[1]))
    return [p for _, p in scored[:25]]
