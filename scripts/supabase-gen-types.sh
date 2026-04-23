#!/usr/bin/env bash
#
# Regenerates lib/supabase/types.ts from the linked Supabase project and
# re-appends our convenience type aliases that `supabase gen types` strips.
#
# Usage: pnpm supabase:types

set -euo pipefail

OUT="lib/supabase/types.ts"
TMP="$(mktemp)"

npx supabase gen types --linked --lang=typescript > "$TMP"

cat >> "$TMP" <<'EOF'

// --- Convenience aliases -----------------------------------------------------
// Auto-appended by scripts/supabase-gen-types.sh after `supabase gen types`
// (the generator overwrites this file, so aliases live here).
export type Project = Database["public"]["Tables"]["projects"]["Row"]
export type ChatSession = Database["public"]["Tables"]["chat_sessions"]["Row"]
export type ChatMessage = Database["public"]["Tables"]["chat_messages"]["Row"]
export type UserGithubIdentity = Database["public"]["Tables"]["user_github_identities"]["Row"]
EOF

mv "$TMP" "$OUT"
echo "Wrote $OUT (with convenience aliases)."
