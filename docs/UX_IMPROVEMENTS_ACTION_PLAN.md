# UX Improvements — Action Plan

This plan addresses five UX improvements surfaced while using the product:

1. **Auth pages:** loading state on the sign-in / sign-up button.
2. **New-project setup:** autosave the selected GitHub repo (no "Save" click).
3. **Integrations UX:** smoother, optimistic updates; no layout jumping after a popup-OAuth connect.
4. **Chat "thinking" state:** Claude-Code-style cycling messages with motion.
5. **Chat UX redesign:** match Claude Desktop's visual language (light mode, cleaner typography, message layout).

Each section below describes **what's wrong today**, **the target behavior**, **concrete file edits**, and **verification steps**. Implementation order is tracked at the bottom.

---

## 1. Loading state on auth submit

### Today

- `app/(public)/login/page.tsx` and `app/(public)/signup/page.tsx` already maintain a `loading` boolean and `Button disabled={loading}`, but the *only* loading affordance is a text swap (`Sign In` → `Signing in...`). No spinner.
- `app/actions/auth.ts#signIn` calls `redirect('/projects')` on success, so the page unmounts before we reset `loading` — the button should stay in its pending state until navigation. That's correct — we just need a better visible affordance.
- `signUp` returns `{ success, email }` and we already flip to the "check your email" state.
- Forms already use `<form action={handleSubmit}>` — pressing Enter from any input submits the form natively. The browser's default Enter-to-submit already works; we just need the button to **visually show pending** the moment the form is submitted (whether by click or Enter).

### Target

- On submit (click or Enter), the button becomes disabled, shows a `Loader2` spinner to the left of the label, and the label reads `Signing in…` / `Creating account…`.
- Inputs become visually disabled/readonly during submit to prevent double-submission.
- A "Processing…" state is preserved across the server roundtrip until the redirect completes (login) or the confirmation screen renders (signup).

### Changes

**`app/(public)/login/page.tsx`**

- Import `Loader2` from `lucide-react`.
- Replace the submit button body with:

  ```tsx
  <Button type="submit" disabled={loading} className="h-11 w-full">
    {loading ? (
      <>
        <Loader2 className="size-4 animate-spin" />
        Signing in…
      </>
    ) : (
      'Sign In'
    )}
  </Button>
  ```
- Add `aria-busy={loading}` on the `<form>` and set `disabled={loading}` on the two `<Input>`s so they can't be edited mid-request.

**`app/(public)/signup/page.tsx`**

- Same treatment: `Loader2` spinner + `Creating account…`, inputs disabled while pending, `aria-busy` on the form.

**Optional polish (not required):** use `useFormStatus()` from `react-dom` inside a dedicated `<SubmitButton>` to drive pending state from the form itself. This is the more idiomatic Next 16 / React 19 pattern and obviates the manual `loading` state. Low-risk refactor if we want to go there, but not necessary to ship #1.

### Verification

- Throttle the network, click Submit → spinner appears immediately, button disabled.
- Focus the password field and press Enter → same spinner path.
- Bad creds → toast appears, `loading` resets, spinner disappears.
- Good creds → spinner persists until redirect to `/projects`.

---

## 2. Autosave the GitHub target repo

### Today

`components/integrations/github-repo-picker.tsx`:

- Shows a `Select` plus a **"Save" button**.
- `save()` does `PATCH /api/integrations/github/repos` then calls `onSaved()` to refresh.
- `setChoice` is set locally, but **nothing happens** until "Save" is clicked — both on first selection and when changing the repo later.

This is extra friction both in the new-project modal (`components/dashboard/new-project-modal.tsx`) and on the settings page (`app/(dashboard)/projects/[projectId]/settings/page.tsx` → `GitHubDetails`).

### Target

- Picking a repo from the dropdown **auto-persists**. No Save button.
- UI shows optimistic "selected" state immediately; a subtle inline indicator (small spinner or "Saving…" that fades to "Saved") confirms persistence.
- If the PATCH fails, we toast the error and **revert** the select back to the previously saved repo.
- Changing to a different repo later does the same thing.

### Changes

**`components/integrations/github-repo-picker.tsx`** — rewrite the save flow:

1. Remove the **Save** `<Button>` from the returned JSX.
2. Track two pieces of state:
   - `choice` — current select value (optimistic).
   - `savedChoice` — the server-acknowledged value, initialized from the `selected` row.
3. Change `onValueChange` to an `async function onChange(v: string)` that:
   - Sets `choice = v` immediately (optimistic).
   - Sets a local `saving = true`.
   - PATCHes `/api/integrations/github/repos` with the new repo.
   - On success: `savedChoice = v`, toast success, call `onSaved?.()` to let parent re-fetch.
   - On failure: revert `choice = savedChoice`, toast the error.
4. Render a small inline status to the right of the `Select`:
   - `saving` → `<Loader2 className="size-3 animate-spin" />` + "Saving…"
   - just saved (for ~1.5s) → `<Check />` + "Saved"
   - otherwise → nothing
5. Keep the `load()` effect that lists available repos; that behavior is unchanged.

**Do not remove the callback contract.** The `onSaved` prop is already consumed by `NewProjectModal` (to refresh integrations) and by `GitHubDetails` (to refresh the settings page). Keep calling it after a successful PATCH so downstream state (including `isGitHubComplete`) updates.

**Guard against rapid changes:** if the user opens the dropdown, selects a repo, then quickly selects a different one while the first PATCH is in-flight, we want the *last* selection to win:

- Track a monotonically increasing `requestIdRef`. Each `onChange` increments it and captures the current id. After `await`, only apply the result if `requestIdRef.current === capturedId`. Otherwise, drop the outcome (a newer request is already superseding).

**`components/integrations/integration-cards.tsx` / `new-project-modal.tsx`** — no API changes needed. The "Continue to Chat" button already re-computes `isGitHubComplete` every render from `integrations`, which is refreshed by `onSaved`/`onRefresh`. Autosave → `onSaved` → `loadIntegrations` → `integrations` updates → button enables. This wire-up stays the same.

### Verification

- New project flow: connect GitHub, pick a repo — button enables and modal reflects "Repository: owner/name" without clicking Save.
- Settings: change the repo from the dropdown — new value persists on reload, no Save button present.
- Network offline: pick a repo → toast error, select reverts to previous choice.

---

## 3. Smoother, optimistic integration connect UX

### Today

The root cause of the "load for a while, then jump" is a sequence of re-renders triggered by successful OAuth:

**Files involved:**
- `components/integrations/integration-cards.tsx` → `GitHubCard` and `SlackCard`
- `components/dashboard/new-project-modal.tsx` → owns the integrations list, re-renders on every `loadIntegrations()`.
- `app/(dashboard)/projects/[projectId]/settings/page.tsx` → `SettingsIntegrationCard` does similar polling.

**Why it jumps:**

1. User clicks *Connect GitHub* → `window.open(...)` opens a popup; we render a `<p>Waiting for GitHub authorization...</p>` in place of the CTA button (shorter element).
2. Every 1000 ms we poll `/api/integrations/github/status`. Once `connected: true`, we call `onRefresh` (which refetches the whole integrations list), then flip `waiting = false`.
3. When `integration` finally becomes present, `GitHubCard` switches branches in its JSX: instead of the `<p>Waiting...</p>` line, it renders `<GitHubRepoPicker />`, which is *much taller* (label + select + Save button + loader). The card height jumps.
4. Inside `GitHubRepoPicker`, `loading` starts `true` and the render shows `"Loading repositories…"` (short). Then the fetch resolves and we render the full `<Select>` + button (much taller). The card grows a second time.

So: **two layout jumps** back-to-back, plus the parent modal re-layout. Also the `Waiting...` / `Active` badge flip produces a small color flash.

`SlackCard` has the same shape (waiting-text → channel-picker), and `SettingsIntegrationCard` adds yet another flash because it re-renders as the popup closes.

### Target

- Optimistic transition: the moment the OAuth popup **closes**, we treat the integration as "likely connected," and render the success skeleton (same height as the final state).
- No shrinking/growing. The card's minimum content area is reserved at connect time so the transition from disconnected → waiting → connected → repo-selection is in-place.
- Repo list pre-fetches *in the background* while the OAuth popup is still open (best-effort — the request will 404 until the installation exists but we can retry).
- After a real success: animate content in with a soft fade/slide; never reposition the card.
- Badge transitions via CSS (e.g., 150 ms color transition on the variant classes) instead of a hard swap.

### Changes

**A. Reserve height on the integration card.**

- In `components/integrations/integration-cards.tsx`, give `GitHubCard`'s body a stable `min-h-[88px]` (or whatever fits `GitHubRepoPicker`'s final height). Do the same for `SlackCard`.
- Apply this only when the user has started the connect flow, not while the card is in its default "Connect GitHub →" state. Pattern:

  ```tsx
  const reserveHeight = waiting || !!integration
  <div className={reserveHeight ? 'min-h-[96px]' : ''}>
    …branches…
  </div>
  ```

**B. Unify the three branches into a single transitional layout.**

In `GitHubCard` today we render one of:

- `<Button>Connect GitHub →</Button>`
- `<p>Waiting for GitHub authorization...</p>`
- `<GitHubRepoPicker …/>`

Replace with a single container that always renders the repo picker placeholder skeleton, overlaid with a "Waiting for GitHub…" label when `waiting && !integration`. That way:

- The height is stable from the moment the popup opens.
- When `integration` arrives, the overlay fades out and the picker fades in — no reflow.

Concrete structure:

```tsx
<div className="relative min-h-[96px]">
  {!integration && !waiting && <Button>Connect GitHub →</Button>}

  {waiting && !integration && (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      <span>Waiting for GitHub authorization…</span>
    </div>
  )}

  {integration && <GitHubRepoPicker projectId={…} onSaved={…} />}
</div>
```

and wrap the branches in a small framer-motion `AnimatePresence` **or** use CSS transitions (`opacity`, `transform`) with `data-*` attributes. Framer-motion is not currently a dep — prefer CSS + Tailwind's `transition-opacity duration-150` to stay dependency-light.

**C. Close the popup eagerly on `focus`.**

Today we rely on `setInterval(checkStatus, 1000)`. Instead, listen for `window` `focus` / `message` events: most OAuth callbacks navigate to a server route that we control — we can have that route `postMessage('github-connected', '*')` and `window.close()` itself. Then `GitHubCard` registers a `message` listener and refreshes immediately, no polling.

- Check what callback routes exist under `app/api/integrations/github/` and `app/api/integrations/slack/` — the installation/callback handlers should return a tiny HTML page that posts a message and closes itself. If they already redirect to a `return_to` that doesn't live inside the popup window, we can have the callback render a small "Connected — you can close this tab" page that posts a message to `window.opener`.
- Keep the 1-second polling as a fallback (popup blockers, third-party cookie issues).

**D. Skeleton the repo list pre-fetch.**

- When `waiting` becomes true, kick off a background pre-fetch of `/api/integrations/github/repos?project_id=…`. It will 400/404 until the installation exists — swallow errors. Cache the result on success so `GitHubRepoPicker` can hydrate instantly when it mounts.
- Optionally lift repo-loading into `GitHubCard` and pass the list into `GitHubRepoPicker` as a prop, so mounting the picker doesn't trigger another loading spinner.

**E. Make the "Connecting…" badge a soft transition.**

- Apply `transition-colors duration-200` to the `Badge` to kill the color snap.
- Settle on three states: `default` (Not connected), `pending` (Connecting…), `success` (Connected). Pending uses a muted foreground color, not yellow — matches Claude's minimalism.

**F. Apply the same pattern to `SlackCard` and `SettingsIntegrationCard`.**

- `SlackCard`: reserve height for the channel picker, pre-fetch channels in the background once `integration` is present.
- `SettingsIntegrationCard`: swap the nested `onRefresh` polling (currently runs every 3 s) for the same `message`-driven refresh.

**G. Debounce `loadIntegrations` in `NewProjectModal` and the settings page.**

- Today `handleVisibilityChange` + `focus` + polling can all trigger `loadIntegrations` in rapid succession, each triggering a re-render of every card. Debounce to at most one call per 500 ms and short-circuit if the payload hasn't changed (shallow-compare `integrations` by id+status+meta.updated_at).

### Verification

- Open the new-project modal on a project without GitHub; click Connect GitHub.
- The card height stays constant from click → popup close → repo picker render.
- The `Waiting…` → repo-picker transition is a soft fade.
- Complete the OAuth and verify the popup closes itself (if callback change lands).
- Repeat for Slack.
- Reload the settings page and confirm no more 3-second "flashes".

---

## 4. Dynamic "thinking" state in the chat

### Today

`components/chat/chat-interface.tsx` renders a single static line:

```tsx
{isProcessing && (…) && (
  <div className="flex items-center gap-3 text-base text-muted-foreground">
    <Loader2 className="w-5 h-5 animate-spin" />
    <span>Verona is thinking...</span>
  </div>
)}
```

It never changes — no variation, no feedback on what the agent is doing.

### Target (mirroring Claude Code)

Claude Code's loading is roughly:

- A small shimmer/spinner glyph on the left
- A single whimsical verb that cycles every ~1.5–2.5 s ("Pondering", "Scheming", "Investigating", "Brewing", …)
- An ellipsis that animates (`. → .. → …`)
- Elapsed-time counter (`↑ 12s · 420 tokens`) — in our case, time is what we can cheaply surface.

### Changes

**New component: `components/chat/thinking-indicator.tsx`**

```tsx
'use client'
import { useEffect, useState } from 'react'

const VERBS = [
  'Investigating',
  'Mapping flows',
  'Cross-referencing events',
  'Skimming your repo',
  'Drafting proposals',
  'Considering edge cases',
  'Consulting PostHog',
  'Weaving tests',
  'Thinking',
  'Reviewing your UI',
  'Prioritizing critical paths',
]

export function ThinkingIndicator({ startedAt }: { startedAt: number }) {
  const [verbIdx, setVerbIdx] = useState(() => Math.floor(Math.random() * VERBS.length))
  const [elapsed, setElapsed] = useState(0)
  const [dots, setDots] = useState('')

  useEffect(() => {
    const vId = setInterval(
      () => setVerbIdx((i) => (i + 1 + Math.floor(Math.random() * (VERBS.length - 1))) % VERBS.length),
      2200,
    )
    const tId = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    const dId = setInterval(() => setDots((d) => (d.length >= 3 ? '' : d + '·')), 400)
    return () => { clearInterval(vId); clearInterval(tId); clearInterval(dId) }
  }, [startedAt])

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono">
      <span className="inline-flex h-2 w-2 rounded-full bg-foreground/50 animate-pulse" />
      <span className="tabular-nums">
        {VERBS[verbIdx]}{dots}
      </span>
      <span className="text-muted-foreground/60">· {elapsed}s</span>
    </div>
  )
}
```

**`components/chat/chat-interface.tsx`** — swap the thinking JSX for the new component:

- Maintain a `thinkingStartedAt` ref (`useRef<number | null>`). Set it when `isProcessing` transitions `false → true`, clear it on `true → false`.
- Render `<ThinkingIndicator startedAt={thinkingStartedAt} />` where the old `Verona is thinking...` line was.

**Styling decisions:**

- Monospace font for the indicator (we already have `--font-geist-mono` loaded) to match Claude Code's terminal vibe.
- Verb rotation is randomized + non-repeating so users don't see the same word twice in a row.
- Pulse bullet (no spinning `Loader2`). Claude Code uses a subtle bullet, not a spinner.

**Accessibility:**

- Add `role="status"` and `aria-live="polite"` on the wrapper. Screen readers announce changes without interrupting.

### Verification

- Send a message and watch the indicator cycle words every ~2 s with the elapsed counter incrementing once per second.
- Kill the stream mid-thought: indicator disappears immediately.
- Refresh while thinking: `backendThinking` is hydrated from session status; indicator re-appears with a fresh start time.

---

## 5. Chat UX redesign to match Claude Desktop

### Today

`components/chat/chat-interface.tsx` + `components/chat/message-bubble.tsx`:

- Light mode ✅ (already the default — no theme changes needed).
- User messages right-aligned in a dark `bg-primary` bubble, `rounded-2xl rounded-br-sm`.
- Assistant messages left-aligned, no bubble, just prose.
- Empty state: centered `<h2>Welcome to Verona</h2>` oversized.
- Max width: `max-w-[85%]` per bubble, `max-w-4xl` on the input wrapper.
- Textarea: min-height 52 px, rounded, shares row with a `Button variant="outline" size="icon"` containing a `Send` or spinner.
- "Approved N flow(s)" banner card floats above the input.
- `MarkdownContent` renders with good prose defaults already.

### Target (Claude Desktop light mode)

Claude Desktop's distinguishing visual characteristics:

- **Column width:** content lives in a ~760 px centered column. Generous side padding on larger screens.
- **User messages:** right-aligned, **light gray** bubble (`bg-neutral-100` / `oklch(0.97 0 0)`), text is foreground (not inverted), rounded-2xl, slight shadow or none.
- **Assistant messages:** no bubble, prose flows edge-to-edge in the column. A small subtle leading "avatar" indicator or just the text block. More vertical breathing room (`space-y-8`).
- **Typography:** assistant prose slightly larger / more generous line-height (roughly `text-[15px] leading-[1.65]`). Headings inside markdown use tighter weights, smaller steps.
- **Input:** a single rounded "card" at the bottom. Textarea borderless, placeholder muted. Send button is a circular icon in the bottom-right corner of the card. Optionally a small attachment/`+` button bottom-left (for future tools).
- **Empty state:** smaller welcome heading, below a centered app glyph. Claude shows a muted greeting like "Good morning. What shall we test today?" with a subtle gradient.
- **Scroll:** smooth, momentum-y; bottom edge fades into the input (a gradient mask).
- **Code blocks:** slightly off-white background (we already do), but tighten the copy affordance and collapse padding.
- **Flow proposal cards:** adopt the same "subtle bordered card" look as Claude's artifacts — white bg, 1 px border, small shadow. Already close; just soften borders and match corner radius.

### Changes

**A. Chat layout shell — `components/chat/chat-interface.tsx`**

- Change outer scroll container to `max-w-[760px] mx-auto w-full px-6` + `space-y-8`.
- Replace the static welcome block with a smaller, softer empty state:

  ```tsx
  <div className="flex flex-col items-center justify-center gap-4 h-full text-center">
    <div className="size-10 rounded-full bg-foreground/10" /> {/* logo placeholder */}
    <h2 className="text-2xl font-normal text-foreground/80">
      What shall we test in {projectName}?
    </h2>
    <p className="text-sm text-muted-foreground max-w-sm">
      I'll analyze your app, PostHog events, and repo to propose flows worth testing.
    </p>
  </div>
  ```
  (Do not change `ChatInterface`'s existing auto-bootstrap behavior — it still fires when `dbMessages` is empty. The empty state only briefly shows before the bootstrap kicks in.)

- Remove the approved-flows banner's heavy green tint; use `bg-foreground/[0.04]` and a dot accent (mirror Claude's neutral callouts).

- Input row restyle:
  - Wrap the textarea + send button in a single "card":

    ```tsx
    <div className="border-t bg-background/80 backdrop-blur">
      <div className="mx-auto max-w-[760px] px-6 py-4">
        <form onSubmit={…} className="relative rounded-2xl border border-border bg-card shadow-sm focus-within:border-foreground/20 transition-colors">
          <Textarea
            className="resize-none border-0 bg-transparent min-h-[52px] max-h-[200px] pr-14 pl-4 py-3 text-[15px] focus-visible:ring-0 focus-visible:ring-offset-0"
            placeholder="Message Verona…"
          />
          <Button
            type="submit"
            size="icon"
            className="absolute bottom-2 right-2 size-8 rounded-full"
            disabled={isProcessing || !input.trim()}
          >
            {isProcessing ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </Button>
        </form>
      </div>
    </div>
    ```
  - Replace `Send` icon with `ArrowUp` (matches Claude Desktop's send affordance).
  - Add a soft gradient mask above the input so scrolling content fades into the input edge:
    ```tsx
    <div className="pointer-events-none absolute inset-x-0 bottom-[72px] h-8 bg-gradient-to-t from-background to-transparent" />
    ```

**B. Message bubbles — `components/chat/message-bubble.tsx`**

- **User bubble:**
  - `bg-muted` (which is `oklch(0.97 0 0)` — Claude's exact shade in light mode)
  - `text-foreground` (not inverted)
  - `rounded-2xl` with no corner-flattening; keep slight `rounded-br-sm` if we want the tail, otherwise drop it for a cleaner look.
  - `px-4 py-3`
  - Max width `max-w-[80%]`
  - `text-[15px] leading-relaxed` — slightly smaller than current `text-lg`.

- **Assistant:**
  - Remove the `max-w-[85%]` cap — let prose fill the 760 px column.
  - Wrap in `space-y-4`.
  - Use `text-[15px] leading-[1.7] text-foreground` for `MarkdownContent`.
  - Streaming caret: keep, but shrink to `w-1.5 h-4` so it's less visually dominant.

- **Flow proposal section:** tighten spacing (`space-y-4` instead of `space-y-5`), drop the oversized `text-lg` analysis copy in favor of `text-[15px] leading-[1.65]` that matches the rest of the prose.

- **Run-started callout:** replace the green tint with a neutral `bg-foreground/[0.04]` + small green dot. Matches Claude's "artifact" callouts.

**C. Markdown refinements — `components/chat/markdown-content.tsx`**

- Bump list spacing: `space-y-1.5`.
- Reduce heading step: `h1 → text-lg`, `h2 → text-base font-semibold`, `h3 → text-sm font-semibold`. Claude's markdown feels flatter.
- Code block background: `bg-muted` (lighter). Language chip: `text-[10px] uppercase tracking-wide`.
- Inline code: `bg-muted px-1 py-0.5 rounded text-[13px]`.

**D. Flow proposal cards — `components/chat/flow-proposal-card.tsx`**

- Swap `Card size="sm"` border from colored (`border-green-500/40` etc.) to a single-weight neutral border that only *tints* based on state (`ring-1 ring-inset ring-green-500/20` for approved, `opacity-60` for rejected).
- Priority badges: use neutral tones except for `critical` (muted red). Claude keeps things understated.
- Step list inside Collapsible: monospace, `text-[13px]`.

**E. Layout width — `app/(dashboard)/projects/[projectId]/chat/page.tsx`**

- Change `max-w-4xl` to `max-w-[760px]` (or lift the cap into `ChatInterface` itself so the shell and input share it).

**F. Scroll-to-bottom UX**

- Already have the `stickToBottomRef` logic in `ChatInterface`. Add a small floating "↓ Jump to latest" pill when the user has scrolled up and new messages arrive — Claude Desktop has this. Button click scrolls the pane to bottom and re-sticks.

**G. Dark mode not required**

- We're light-mode only per the brief. No `dark:` variants needed. All tokens used are already light-aware.

### Verification

- Load an existing chat with long history. Column is centered at ~760 px, clearly narrower than today.
- User bubble: light gray, dark text. Assistant: full-width prose, no bubble.
- Empty state is understated, not a giant centered h2.
- Send button is a round up-arrow in the input card corner.
- Markdown renders with tighter heading hierarchy; inline code and blocks feel lighter.
- Flow proposal cards feel neutral; only critical ones use color.
- Stickiness to bottom still works; a "Jump to latest" pill appears if you scroll up during streaming.

---

## Implementation order

| Phase | Items | Rationale |
|-------|-------|-----------|
| **1 — Quick wins** | §1 (auth spinner), §2 (autosave repo) | Self-contained, low-risk, high-visibility polish. Unblocks users immediately. |
| **2 — Integration UX** | §3 | Touches several files and needs careful testing of GitHub/Slack OAuth popups. Must land before §5 ships, since the new-project modal is a high-frequency touchpoint. |
| **3 — Thinking indicator** | §4 | Isolated new component, one swap in `chat-interface.tsx`. Can ship in parallel with any other phase. |
| **4 — Chat redesign** | §5 | Largest visual change; easier to review on top of the other three so we aren't touching the same files twice. |

Each phase is a separate PR so review stays focused, and we can ship and user-test incrementally.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Autosave fires a PATCH on every dropdown open/select (including unchanged re-selection) | Skip the PATCH when `v === savedChoice`. |
| OAuth popup callback change (§3-C) requires updating the server route | Keep the interval-poll fallback intact; treat popup message as a "fast path." |
| Removing the Save button breaks users who hit Enter to save | The dropdown doesn't have an Enter-to-save affordance today; dropping the button changes nothing for keyboard users. Tab + arrows + Enter on a `<Select>` item auto-commits, which now auto-saves. |
| Chat redesign widths conflict with the sidebar layout | `ChatPage` already wraps content in `max-w-4xl`. Migrating to `max-w-[760px]` shrinks it; verify on the settings/runs pages that no unrelated layout relies on the 4xl cap. |
| Thinking messages feel off-brand | Verbs list is edit-friendly — copy review before merge. |
| Light-mode-only regression | All tokens used (`bg-muted`, `text-foreground`, etc.) are defined for both `:root` and `.dark` — future dark mode is still trivially enableable. |

---

## Open questions (not blocking)

- Do we want a future-proof dark mode toggle? Cheap to add, but out of scope for this plan.
- Should the thinking indicator surface *why* it's working (e.g., `Reading PostHog events`, `Reviewing repo tree`)? That requires the agent to emit step metadata — separate change, not required here. A simple verb cycle is enough to address the user's request.
- Should we add a "Retry" affordance on assistant errors? Possibly out of scope, not mentioned by the user.
