# shadcn UI Migration Plan

## Current State

**shadcn is already partially installed** (v4, `base-nova` style, Base UI primitives). The `components.json` is configured and 17 UI primitives exist in `components/ui/`. However, **most primitives are not actually used** — the app overwhelmingly relies on raw HTML elements (`<button>`, `<input>`, `<textarea>`, `<select>`, `<label>`) with ad-hoc Tailwind classes. This creates visual inconsistency and makes the UI feel "custom-built" rather than part of a unified design system.

### Existing `components/ui/` primitives (already installed)

| Component | Used in app? |
|-----------|-------------|
| `button.tsx` | Only in `dialog.tsx` close button + `templates/page.tsx` |
| `dialog.tsx` | `new-project-modal.tsx`, `templates/page.tsx` |
| `select.tsx` | `templates/page.tsx` only |
| `switch.tsx` | `templates/page.tsx` only |
| `input.tsx` | **Not used anywhere** |
| `textarea.tsx` | **Not used anywhere** |
| `label.tsx` | **Not used anywhere** |
| `card.tsx` | **Not used anywhere** |
| `badge.tsx` | **Not used anywhere** |
| `avatar.tsx` | **Not used anywhere** |
| `separator.tsx` | **Not used anywhere** |
| `skeleton.tsx` | **Not used anywhere** |
| `tabs.tsx` | **Not used anywhere** |
| `table.tsx` | **Not used anywhere** |
| `dropdown-menu.tsx` | **Not used anywhere** |
| `sheet.tsx` | Custom implementation, **not shadcn** — and **unused** |
| `sonner.tsx` | `app/layout.tsx` (Toaster) |

---

## Migration Scope

### Files requiring changes (by priority)

| Priority | File | Raw elements to replace | Notes |
|----------|------|------------------------|-------|
| **P0** | `components/dashboard/new-project-modal.tsx` | 5× `<input>`, 3× `<button>`, 5× `<label>` | Core modal, most visible |
| **P0** | `components/integrations/integration-cards.tsx` | 12× `<button>`, 8× `<input>`, 6× status `<span>` | Used in modal + settings |
| **P0** | `components/chat/chat-interface.tsx` | 1× `<textarea>`, 1× `<button>` (send), 1× status banner | Main chat view |
| **P0** | `components/chat/flow-proposal-card.tsx` | 2× `<button>` (approve/reject), 1× expand `<button>`, priority `<span>`, state `<span>` | Core chat interaction |
| **P1** | `app/(dashboard)/projects/[projectId]/settings/page.tsx` | 12× `<button>`, 6× `<input>`, 1× custom toggle, `browser confirm()` | Settings panel |
| **P1** | `components/dashboard/panel-page.tsx` | Custom slide-over overlay | Replace with shadcn Sheet |
| **P1** | `components/integrations/github-repo-picker.tsx` | 1× native `<select>`, 1× `<button>` | GitHub setup flow |
| **P1** | `components/dashboard/trigger-run-button.tsx` | 2× `<button>` variants | Header + page actions |
| **P1** | `components/dashboard/run-status-badge.tsx` | 1× `<span>` | Status indicator |
| **P2** | `app/(public)/login/page.tsx` | 2× `<input>`, 1× `<button>`, 2× `<label>` | Auth page, hardcoded hex colors |
| **P2** | `app/(public)/signup/page.tsx` | 3× `<input>`, 1× `<button>`, 3× `<label>` | Auth page, hardcoded hex colors |
| **P2** | `components/dashboard/sidebar.tsx` | 3× `<button>` | Sidebar chrome |
| **P2** | `components/dashboard/topbar.tsx` | Nav buttons | Header nav |
| **P2** | `components/chat/message-bubble.tsx` | Wrapper divs | Low priority, mostly Tailwind |
| **P2** | `app/(dashboard)/projects/[projectId]/templates/page.tsx` | 4× raw `<input>`, 1× raw `<textarea>`, several raw `<button>` | Already partially uses shadcn |
| **P3** | `app/(dashboard)/projects/[projectId]/runs/page.tsx` | Uses PanelPage | Will be fixed by Sheet migration |
| **P3** | `app/(dashboard)/projects/[projectId]/runs/[runId]/page.tsx` | Uses PanelPage, expand buttons | Will be fixed by Sheet migration |

### New shadcn components to install

| Component | Why needed |
|-----------|-----------|
| `alert-dialog` | Replace `browser confirm()` in settings page disconnect/delete flows |
| `collapsible` | Replace `<details>` element in new project modal |
| `scroll-area` | Scrollable content in modals, channel picker, repo list |
| `tooltip` | Add tooltips to icon-only buttons (sidebar toggle, send, etc.) |

---

## Step-by-Step Implementation Plan

### Phase 1: Foundation — Install missing components & fix Sheet

**Goal:** Get all needed shadcn primitives in place before migrating consumer code.

#### Step 1.1: Install new shadcn components
```bash
npx shadcn@latest add alert-dialog collapsible scroll-area tooltip
```

#### Step 1.2: Replace custom Sheet with shadcn Sheet
The current `components/ui/sheet.tsx` is a custom implementation (not shadcn). It's also unused. Replace it with the proper shadcn Sheet component:
```bash
npx shadcn@latest add sheet --overwrite
```

#### Step 1.3: Verify all existing components are up to date
Run `npx shadcn@latest add` on any that may be stale. No overwrites needed for components already in use — just ensure they compile.

**Verification:** `npx tsc --noEmit` passes with no new errors.

---

### Phase 2: Dashboard Shell — PanelPage → Sheet

**Goal:** Replace the custom `PanelPage` slide-over with the shadcn `Sheet` component, unifying all overlay patterns.

#### Step 2.1: Create a `SheetPage` wrapper
Create a thin wrapper around shadcn `Sheet` that preserves the `PanelPage` API (project-scoped close navigation, title, children):

```tsx
// components/dashboard/sheet-page.tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
```

It should:
- Accept `open` (always `true` when rendered as a route), `onClose` (router.push back to project), `title`, `children`, `className`.
- Render `SheetContent` with `side="right"` and `className="sm:max-w-2xl w-full"`.
- Use `SheetHeader` + `SheetTitle` for the header.

#### Step 2.2: Migrate all PanelPage consumers
Update the following files to use the new `SheetPage` wrapper:
- `app/(dashboard)/projects/[projectId]/settings/page.tsx`
- `app/(dashboard)/projects/[projectId]/runs/page.tsx`
- `app/(dashboard)/projects/[projectId]/runs/[runId]/page.tsx`

#### Step 2.3: Remove old PanelPage
Delete `components/dashboard/panel-page.tsx` and the old custom `sheet.tsx` (if not already replaced).

**Verification:** Navigate to Settings, Runs, and Run Detail. Panels should slide in from the right with proper shadcn styling, close button works, and backdrop dismisses.

---

### Phase 3: New Project Modal — Full shadcn migration

**Goal:** Make the most visible modal use shadcn components exclusively.

#### Step 3.1: Replace form inputs
In `components/dashboard/new-project-modal.tsx`:
- Replace all `<input>` elements with `<Input>` from `@/components/ui/input`
- Replace all `<label>` elements with `<Label>` from `@/components/ui/label`
- Wrap label+input pairs consistently

#### Step 3.2: Replace buttons
- Replace the "Cancel" button with `<Button variant="ghost">`
- Replace the "Create project" submit button with `<Button type="submit">`
- Replace the "Continue to Chat →" button with `<Button className="w-full">`

#### Step 3.3: Replace `<details>` with Collapsible
Replace the `<details>/<summary>` for "Test account credentials" with shadcn `Collapsible` + `CollapsibleTrigger` + `CollapsibleContent`.

#### Step 3.4: Add DialogFooter
Wrap the form action buttons in `<DialogFooter>` for consistent footer styling.

**Verification:** Open the New Project modal. All inputs, labels, and buttons should match the shadcn design system. Collapsible should animate open/closed.

---

### Phase 4: Integration Cards — Unified card design

**Goal:** Replace ad-hoc integration card styling with shadcn Card + Badge + Button + Input.

#### Step 4.1: Refactor `IntegrationCard` wrapper
In `components/integrations/integration-cards.tsx`:
- Replace the outer `<div className="border border-border rounded-lg p-4">` with `<Card>` + `<CardContent>` (or just `<Card className="p-4">`)
- Replace the status `<span>` ("Connected" / "Not connected") with `<Badge variant="...">`:
  - Connected → `<Badge variant="outline" className="border-green-500/30 text-green-500">`
  - Not connected → `<Badge variant="secondary">`

#### Step 4.2: Replace all raw buttons in integration cards
For each card (GitHub, PostHog, Sentry, LangSmith, Braintrust, Slack):
- Replace `<button className="text-sm underline ...">Connect X →</button>` with `<Button variant="link" size="sm">`
- Replace `<button>Save</button>` with `<Button size="sm">`
- Replace `<button>Cancel</button>` with `<Button variant="ghost" size="sm">`

#### Step 4.3: Replace all raw inputs in integration cards
- Replace `<input className="w-full border-b ...">` with `<Input>` component
- Style them uniformly with proper sizing

#### Step 4.4: Migrate GitHubRepoPicker
In `components/integrations/github-repo-picker.tsx`:
- Replace native `<select>` with shadcn `<Select>` + `<SelectTrigger>` + `<SelectContent>` + `<SelectItem>`
- Replace raw `<button>` with `<Button>`

**Verification:** Open New Project modal → Step 2 (integrations). All cards should have consistent Card styling, proper Badges, and unified Button/Input appearance. Also check Settings page integration cards.

---

### Phase 5: Chat UI — Textarea, Send Button, Flow Cards

**Goal:** Bring the main chat interface into the design system.

#### Step 5.1: Chat input area
In `components/chat/chat-interface.tsx`:
- Replace raw `<textarea>` with `<Textarea>` from `@/components/ui/textarea`
- Replace raw send `<button>` with `<Button variant="outline" size="icon">`
- Wrap the input area in a cleaner container

#### Step 5.2: Flow proposal cards
In `components/chat/flow-proposal-card.tsx`:
- Replace the outer `<div className="border rounded-lg p-4 ...">` with `<Card>` + `<CardContent>`
- Replace priority `<span>` with `<Badge>`
- Replace state `<span>` (approved/rejected) with `<Badge>`
- Replace "Approve" `<button>` with `<Button variant="outline" size="sm">` with green accent
- Replace "Reject" `<button>` with `<Button variant="outline" size="sm">` with red accent
- Replace expand `<button>` with `<Collapsible>` pattern
- Replace step type `<span>` badges with `<Badge variant="secondary">`

#### Step 5.3: Approved flows banner
In `components/chat/chat-interface.tsx`:
- Style the approved flows notification using `<Card>` or a custom alert-like pattern

#### Step 5.4: Message bubble refinement
In `components/chat/message-bubble.tsx`:
- Minimal changes — the current styling works. Optionally:
  - Wrap the "test run started" banner in a `<Card>`
  - Keep user bubble styling as-is (distinctive is good for chat)

**Verification:** Open chat, review flow proposals, approve/reject. Send a message. All elements should feel unified with the shadcn design system.

---

### Phase 6: Settings Page — Full migration

**Goal:** Migrate the complex settings page to shadcn components and replace `browser confirm()`.

#### Step 6.1: Migrate SettingsIntegrationCard
In `app/(dashboard)/projects/[projectId]/settings/page.tsx`:
- Replace the card wrapper with `<Card>` + `<CardContent>`
- Replace status badges with `<Badge>`
- Replace all `<button>` elements with `<Button>`

#### Step 6.2: Migrate ScheduleSection
- Replace custom toggle with shadcn `<Switch>`
- Replace raw `<input type="time">` with `<Input type="time">`
- Replace raw `<input>` for timezone with `<Input>`
- Replace day picker buttons with `<Button variant="outline" size="sm">` (toggle pattern)
- Replace "Save schedule" link-button with `<Button variant="link">`

#### Step 6.3: Replace `browser confirm()` with AlertDialog
- For the disconnect confirmation: wrap the "Disconnect" button in an `<AlertDialog>` with a proper title, description, and Cancel/Confirm actions
- For the delete project flow: replace the inline confirm input with an `<AlertDialog>` pattern, or at minimum use `<Input>` and `<Button variant="destructive">`

#### Step 6.4: Migrate DeleteProjectSection
- Replace the danger zone card with `<Card>` + appropriate destructive styling
- Replace raw `<input>` with `<Input>`
- Replace raw `<button>` elements with `<Button variant="destructive">` and `<Button variant="ghost">`

#### Step 6.5: Slack channel picker
- Replace the channel list buttons with proper `<Button>` components
- Optionally wrap in `<ScrollArea>` for the scrollable list

**Verification:** Open Settings panel. Toggle the schedule. Disconnect an integration (AlertDialog should appear). Test the delete project flow.

---

### Phase 7: Auth Pages — Login & Signup

**Goal:** Replace hardcoded hex colors with CSS variable-based shadcn components.

#### Step 7.1: Login page
In `app/(public)/login/page.tsx`:
- Wrap the form container in `<Card>` + `<CardHeader>` + `<CardContent>` + `<CardFooter>`
- Replace `<input>` elements with `<Input>`
- Replace `<label>` elements with `<Label>`
- Replace submit `<button>` with `<Button className="w-full">`
- Replace hardcoded `text-[#1a1a1a]`, `bg-[#1a1a1a]`, `border-[#1a1a1a]/10` etc. with semantic tokens (`text-foreground`, `bg-primary`, `border-border`)

#### Step 7.2: Signup page
Same treatment as login page. Additionally:
- Style the "Check your email" confirmation state using `<Card>` with proper structure

**Verification:** Visit `/login` and `/signup`. Forms should use shadcn styling with proper focus rings, consistent sizing, and semantic colors (no more hardcoded hex).

---

### Phase 8: Sidebar & Topbar — Button migration

**Goal:** Replace raw buttons in the dashboard shell with shadcn Button.

#### Step 8.1: Sidebar
In `components/dashboard/sidebar.tsx`:
- Replace the collapse toggle `<button>` with `<Button variant="ghost" size="icon-sm">`
- Replace "New project" `<button>` with `<Button variant="outline" className="w-full">`
- Optionally add `<Tooltip>` to the collapse toggle
- Replace the user avatar `<div>` with `<Avatar>` + `<AvatarFallback>`

#### Step 8.2: Topbar
In `components/dashboard/topbar.tsx`:
- Replace `HeaderNavButton` raw `<a>` elements with `<Button variant="ghost" size="sm" asChild>` wrapping a `<Link>`
- This gives proper focus rings, hover states, and accessible semantics

#### Step 8.3: Sidebar toggle
In `components/dashboard/sidebar.tsx` (`SidebarToggle`):
- Replace raw `<button>` with `<Button variant="ghost" size="icon-sm">`
- Add `<Tooltip>` with "Toggle sidebar"

#### Step 8.4: Trigger run button
In `components/dashboard/trigger-run-button.tsx`:
- Replace both button variants with `<Button>`:
  - Header variant: `<Button variant="ghost" size="sm">`
  - Page variant: `<Button variant="link" size="lg">`

**Verification:** Check sidebar toggle, new project button, header nav buttons, and trigger run button all render with proper shadcn styling.

---

### Phase 9: Templates Page — Complete the migration

**Goal:** The templates page already uses some shadcn components. Finish migrating the rest.

#### Step 9.1: Replace remaining raw inputs
In `app/(dashboard)/projects/[projectId]/templates/page.tsx`:
- Replace all `<input className="...border-b...">` with `<Input>`
- Replace all `<textarea>` with `<Textarea>`

#### Step 9.2: Replace remaining raw buttons
- Replace "AI Generate" and "+ Create" link-buttons with `<Button variant="link">`
- Replace step manipulation buttons (↑, ↓, ×) with `<Button variant="ghost" size="icon-xs">`
- Replace "+ Add step" with `<Button variant="link" size="sm">`
- Replace "edit" and "del" template actions with `<Button variant="ghost" size="sm">`

#### Step 9.3: Template list cards
- Wrap each template in a `<Card>` for consistent appearance

**Verification:** Open Templates page. Create, edit, and delete templates. All controls should use shadcn components.

---

### Phase 10: Run Status Badge → shadcn Badge

**Goal:** Replace the custom `RunStatusBadge` with shadcn `Badge`.

#### Step 10.1: Refactor RunStatusBadge
In `components/dashboard/run-status-badge.tsx`:
- Import `Badge` and `badgeVariants` from `@/components/ui/badge`
- Map each status to an appropriate Badge variant + color class

**Verification:** Check Runs list and Run Detail pages. Badges should render consistently.

---

### Phase 11: Cleanup & Dead Code Removal

**Goal:** Remove unused components and ensure consistency.

#### Step 11.1: Remove dead components
- Delete `components/chat/chat-nav.tsx` (unused, not imported anywhere)
- Delete `components/landing/metis-logo.tsx` (unused, not imported anywhere)
- Delete old `components/dashboard/panel-page.tsx` (replaced by Sheet in Phase 2)

#### Step 11.2: Remove unused UI primitives
After migration, audit which `components/ui/` primitives are still unused and consider removing them to reduce clutter. Keep only what's actually imported.

#### Step 11.3: Consistency pass
- Grep for any remaining raw `<button>`, `<input>`, `<textarea>`, `<select>`, `<label>` in `components/` and `app/(dashboard)/` directories
- Replace any stragglers with shadcn equivalents
- Ensure all colors use CSS variable tokens (no hardcoded hex in dashboard)

#### Step 11.4: ThemeProvider
- The `sonner.tsx` component calls `useTheme()` but `ThemeProvider` from `next-themes` is not mounted in `app/layout.tsx`. If dark mode support is desired, add `<ThemeProvider>` to the root layout. Otherwise, remove `useTheme()` from sonner.

**Verification:** Full `npx tsc --noEmit` passes. Visual review of all pages for consistency.

---

## Summary of New Components to Install

```bash
npx shadcn@latest add alert-dialog collapsible scroll-area tooltip sheet --overwrite
```

## Files Changed Per Phase

| Phase | Files modified | Files created | Files deleted |
|-------|---------------|---------------|---------------|
| 1 | 0 | 4-5 (new UI components) | 1 (old sheet.tsx) |
| 2 | 4 | 1 (sheet-page.tsx) | 1 (panel-page.tsx) |
| 3 | 1 | 0 | 0 |
| 4 | 2 | 0 | 0 |
| 5 | 3 | 0 | 0 |
| 6 | 1 | 0 | 0 |
| 7 | 2 | 0 | 0 |
| 8 | 4 | 0 | 0 |
| 9 | 1 | 0 | 0 |
| 10 | 1 | 0 | 0 |
| 11 | 1-2 | 0 | 2-3 |
| **Total** | **~20** | **~6** | **~4** |

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Sheet component API differs from PanelPage | Medium | Build a thin wrapper that matches the existing API |
| Base UI Select has different behavior than native `<select>` | Low | Already used in templates page — proven to work |
| Auth pages use hardcoded light-mode colors | Low | Simply map hex values to semantic tokens |
| Dialog close behavior changes | Low | Already using shadcn Dialog — no change |
| Forms lose autofocus/validation after migration | Medium | Test each form after migration, preserve native attributes |
| Collapsible animation differs from `<details>` | Low | Cosmetic difference, likely an improvement |

## Key Principles During Migration

1. **One phase at a time.** Each phase should be a self-contained PR that can be reviewed independently.
2. **Preserve all existing behavior.** This is a visual/structural refactor, not a functional change. All form submissions, API calls, navigation, and state management must remain identical.
3. **Use shadcn components as-is.** Avoid over-customizing the primitives. The goal is to converge on the design system, not create new bespoke patterns.
4. **Maintain accessibility.** shadcn components have built-in ARIA attributes. Ensure labels, roles, and focus management are preserved or improved.
5. **Test visually after each phase.** Before moving to the next phase, verify the changed pages render correctly and all interactions work.
