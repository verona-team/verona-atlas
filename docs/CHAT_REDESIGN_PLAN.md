# Chat-Centric Redesign: Detailed Action Plan

## Overview

Transform the platform from a traditional SaaS multi-page layout into a **Claude Code / ChatGPT-style** conversational interface where:

- Every **project** is a "chat session" in the left sidebar
- The **main content area** is dominated by the chat UI
- **Runs** and **Settings** are accessible from a top header bar (not separate full pages)
- **Project creation** happens via a modal (not a full-page route)
- **First-time users** see the project creation modal immediately after login

---

## Current Architecture Summary

| Aspect | Current State |
|--------|--------------|
| Layout | `app/(dashboard)/layout.tsx` — auth gate + padded scrollable `<main>`, no sidebar, no header |
| Sidebar/Topbar | Exist in `components/dashboard/` but are **not used** anywhere |
| Project list | Full-page `/projects` route (server component) |
| Project creation | Full-page `/projects/new` with Phase 1 (form) + Phase 2 (integrations) |
| Chat | `/projects/[projectId]/chat` — fixed full-viewport layout with top bar + ChatNav |
| Runs | Separate full-page `/projects/[projectId]/runs` and `/projects/[projectId]/runs/[runId]` |
| Settings | Separate full-page `/projects/[projectId]/settings` |
| Context/State | No React context; org/project resolved via Supabase in server components per route |
| DB schema | `chat_sessions` is 1:1 with project (UNIQUE on `project_id`) |

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Top Header Bar                           │
│  [≡ Toggle]  Project Name         [Runs] [Settings] [Sign Out] │
├──────────┬──────────────────────────────────────────────────────┤
│          │                                                      │
│ Sidebar  │              Chat Messages Area                      │
│          │                                                      │
│ [+ New]  │         (scrollable message thread)                  │
│          │                                                      │
│ Project1 │                                                      │
│ Project2 │                                                      │
│ Project3 │                                                      │
│          │                                                      │
│          ├──────────────────────────────────────────────────────┤
│          │           Chat Input Area                             │
│          │  [textarea] [send]                                   │
└──────────┴──────────────────────────────────────────────────────┘
```

When "Runs" or "Settings" is clicked from the header, content renders in the main area (replacing chat temporarily), or opens as a slide-over panel.

---

## Step-by-Step Implementation Plan

### Step 1: Create a Workspace Context Provider

**Why:** The new layout needs client-side awareness of the current org, project list, and active project for the sidebar, header, and modals — without re-fetching on every navigation.

**Files to create:**
- `lib/workspace-context.tsx` — React context + provider

**What it provides:**
- `orgId: string`
- `projects: Project[]` (fetched once, refreshable)
- `activeProjectId: string | null`
- `setActiveProjectId(id: string)`
- `refreshProjects()` — re-fetches the project list
- `user: { email: string }` — basic user info for avatar/display

**Data source:** Initial data SSR-fetched in `app/(dashboard)/layout.tsx` and passed as props to the provider. Client-side refresh calls `GET /api/projects`.

**Dependencies:** None (new file).

---

### Step 2: Redesign the Dashboard Layout

**Why:** The current layout is a bare padded `<main>`. The new layout needs a persistent sidebar + header across all dashboard routes.

**File to modify:**
- `app/(dashboard)/layout.tsx`

**Changes:**
1. Server-side: continue to check auth, but also fetch the user's org, projects list, and membership.
2. Wrap `children` in the `WorkspaceProvider` (from Step 1).
3. Render the new shell structure:
   - `<WorkspaceProvider>` wrapping everything
   - `<AppSidebar>` on the left
   - `<div className="flex-1 flex flex-col">` for header + content
   - `<AppHeader>` at the top
   - `<main>` for page content

**Result:** Every dashboard route automatically gets the sidebar and header.

---

### Step 3: Build the New Sidebar Component

**Why:** The sidebar is the centerpiece of the new UX — it lists projects as "chat sessions" like Claude Code's conversation list.

**File to create/replace:**
- `components/dashboard/sidebar.tsx` (replace existing unused component)

**Design (mirroring Claude Code):**
- **Top section:** App logo/name ("Verona") + "New Chat" button (icon: `Plus` or `MessageSquarePlus`)
- **Middle section:** Scrollable list of projects, each showing:
  - Project name (primary text)
  - App URL or last activity (secondary text, truncated)
  - Active state highlight (background color change)
  - Clicking a project navigates to `/projects/[projectId]`
- **Bottom section:** User email, sign-out button
- **Collapsible:** A toggle button (hamburger or `PanelLeftClose`) collapses the sidebar to icons-only or fully hides it on mobile.

**Styling:**
- Dark sidebar background (using `--sidebar` CSS variables already defined in `globals.css`)
- Width: `w-64` expanded, `w-0` or `w-16` collapsed
- Transition animation on collapse/expand
- Mobile: overlay mode with backdrop

**State:**
- `collapsed: boolean` (persisted in localStorage)
- Project list from `WorkspaceContext`
- Active project from URL (via `useParams`)

---

### Step 4: Build the New Top Header Component

**Why:** The header replaces the current `ChatNav` pill and the per-page back links with a consistent top bar.

**File to create/replace:**
- `components/dashboard/topbar.tsx` (replace existing unused component)

**Design (mirroring Claude Code):**
- **Left:** Sidebar toggle button (when sidebar is collapsed)
- **Center-left:** Active project name (clickable → goes to chat) + app URL as subtitle
- **Right:** Action buttons:
  - `Runs` (icon: `History`) — navigates to runs view for the active project
  - `Settings` (icon: `Settings`) — navigates to settings view for the active project  
  - `Sign Out` or user avatar with dropdown

**Conditional rendering:**
- When no project is active (e.g., `/projects` route with no selection), show "Select a project" or similar
- Runs/Settings buttons are disabled or hidden when no project is active

**Props:** Receives `activeProjectId` and `projectName` from context or parent.

---

### Step 5: Create the New Project Modal

**Why:** Project creation moves from a full-page flow (`/projects/new`) to a modal dialog, matching the "new chat" pattern.

**File to create:**
- `components/dashboard/new-project-modal.tsx`

**Design:**
- Uses the existing `Dialog` component from `components/ui/dialog.tsx`
- **Multi-step wizard inside the dialog:**
  - **Step 1: Project Details**
    - Project name (required)
    - App URL (required)
    - Auth email (optional)
    - Auth password (optional)
    - "Create Project" button → `POST /api/projects`
  - **Step 2: Connect Integrations**
    - Same integration cards as current `/projects/new` Phase 2
    - GitHub (required), PostHog, Sentry, LangSmith, Braintrust, Slack (optional)
    - "Continue to Chat" button (enabled when GitHub + repo are connected)
- **On completion:** 
  - Calls `refreshProjects()` from context
  - Sets active project to the new project
  - Closes modal
  - Navigates to `/projects/[newProjectId]`

**Refactoring from `/projects/new`:**
- Extract the integration card components (`GitHubCard`, `PostHogCard`, `SentryCard`, `LangSmithCard`, `BraintrustCard`, `SlackCard`, `IntegrationCard`) into a shared file: `components/integrations/integration-cards.tsx`
- Both the modal and the settings page can import from there

**Trigger points:**
- "New Chat" button in sidebar
- Automatically on first login when no projects exist (via context check)

---

### Step 6: Make Chat the Default View

**Why:** When a project is selected, the chat should be the primary content.

**File to modify:**
- `app/(dashboard)/projects/[projectId]/page.tsx`

**Changes:**
- Instead of redirecting to `/projects/[projectId]/chat`, render the chat directly on this page.
- Or: keep the redirect, but update the layout so that the chat page renders within the new shell seamlessly (no full-page fixed positioning that fights the layout).

**File to modify:**
- `app/(dashboard)/projects/[projectId]/chat/page.tsx`

**Changes:**
- Remove the `fixed inset-0` positioning (the layout now provides the shell)
- Remove the top bar with project name + ChatNav (the new `AppHeader` handles this)
- The chat page just renders `<ChatInterface>` filling the available main content area

---

### Step 7: Adapt Runs and Settings Pages

**Why:** These pages need to render inside the new shell (sidebar + header) instead of as standalone full pages.

**Files to modify:**
- `app/(dashboard)/projects/[projectId]/runs/page.tsx`
- `app/(dashboard)/projects/[projectId]/runs/[runId]/page.tsx`
- `app/(dashboard)/projects/[projectId]/settings/page.tsx`

**Changes:**
- Remove the back-link (`← Project Name`) — the sidebar and header already provide navigation context
- Remove redundant headings that duplicate header info
- Ensure they render fluidly within the main content area
- Optionally: add a "Back to Chat" link or breadcrumb at the top of each page, or rely on the sidebar click to navigate back

---

### Step 8: Update Routing and Redirects

**Why:** Several redirect guards and the login flow need updating to work with the new architecture.

**Files to modify:**

1. **`app/actions/auth.ts`** — `signIn`:
   - Currently redirects to `/projects`. Change to redirect to `/` or keep `/projects`, but the projects page now shows the chat-centric UI.

2. **`app/(dashboard)/projects/page.tsx`**:
   - Currently redirects to `/projects/new` when empty. Change to:
     - If projects exist: redirect to `/projects/[mostRecentProject]` (so user lands in chat)
     - If no projects: redirect to `/projects/[projectId]` isn't possible, so render an empty state that auto-opens the New Project modal

3. **`app/(dashboard)/projects/[projectId]/page.tsx`**:
   - Currently redirects to chat or setup. Simplify: just render the chat page content directly (or redirect to `/projects/[projectId]/chat` which now renders inside the shell).

4. **`app/(dashboard)/projects/[projectId]/setup/page.tsx`**:
   - Currently redirects to `/projects/new?projectId=...`. Change to redirect to `/projects/[projectId]` and let the page detect that GitHub isn't set up → open the integrations modal/step.

5. **`/projects/new` page**:
   - Can be **deprecated** in favor of the modal. Either:
     - Remove the route entirely and redirect `/projects/new` to `/projects` (which triggers the modal)
     - Or keep as a fallback that opens the modal on mount

---

### Step 9: Handle the First-Time User Experience

**Why:** First-time users (no projects) should immediately see the new project modal.

**Implementation:**
- In `app/(dashboard)/projects/page.tsx`:
  - If `projects.length === 0`: render the main layout with an empty state + auto-trigger the New Project modal
  - Pass a prop or URL param like `?new=true` to signal the modal should auto-open
- In the `WorkspaceProvider`: if `projects` is empty on first load, set a flag `showNewProjectModal: true`
- The modal component reads this flag and opens automatically

---

### Step 10: Dark Theme as Default

**Why:** Claude Code uses a dark theme. The platform already has dark theme variables in `globals.css` but defaults to light.

**File to modify:**
- `app/layout.tsx` — add `dark` class to `<html>` element (or use system preference detection)

**Alternatively:** Apply `class="dark"` to the `<html>` tag and let users toggle. For the initial redesign, defaulting to dark matches the Claude Code aesthetic.

---

### Step 11: Style Refinements

**Why:** Match the Claude Code visual language more closely.

**Changes needed:**

1. **Sidebar styling:**
   - Subtle hover states on project items
   - Active item has a slightly lighter background
   - Project names in regular weight, muted secondary text
   - Clean dividers or none between items

2. **Chat area:**
   - Centered max-width container (like Claude Code's ~720px chat column)
   - Clean message bubbles: user messages right-aligned with primary color, assistant messages left-aligned with no background
   - Monospace code blocks with syntax highlighting
   - Subtle timestamps

3. **Input area:**
   - Rounded input box with placeholder text
   - Attach/action buttons on the left, send on the right
   - Grows vertically as user types (already partially implemented)

4. **Header:**
   - Minimal height (~48-56px)
   - Subtle bottom border
   - Clean icon buttons

5. **Fonts:**
   - Already using Inter (matches well)
   - Ensure proper size hierarchy

---

### Step 12: Mobile Responsiveness

**Why:** Claude Code and ChatGPT both have mobile-friendly layouts.

**Changes:**
- Sidebar: hidden by default on mobile, revealed via hamburger menu as an overlay
- Header: compact version with hamburger + project name
- Chat: full-width on mobile
- Modal: full-screen on mobile, dialog on desktop

---

## Implementation Order & Dependencies

```
Step 1 (Context)
  ↓
Step 2 (Layout) ← depends on Step 1
  ↓
Step 3 (Sidebar) ← depends on Step 1, 2
Step 4 (Header) ← depends on Step 1, 2
  ↓
Step 5 (Modal) ← depends on Step 1, 3 (needs "New Chat" trigger)
  ↓
Step 6 (Chat Default) ← depends on Step 2, 4
Step 7 (Runs/Settings) ← depends on Step 2, 4
  ↓
Step 8 (Routing) ← depends on Steps 5, 6
Step 9 (First-Time UX) ← depends on Steps 5, 8
  ↓
Step 10 (Dark Theme) ← independent, can be done anytime
Step 11 (Styling) ← depends on Steps 3, 4, 6
Step 12 (Mobile) ← final polish, depends on Steps 3, 4
```

**Suggested grouping into implementation phases:**

| Phase | Steps | Description |
|-------|-------|-------------|
| **A** | 1, 2, 10 | Foundation: context, layout shell, dark theme |
| **B** | 3, 4 | Chrome: sidebar + header |
| **C** | 5, 6 | Core UX: project modal + chat-as-default |
| **D** | 7, 8, 9 | Integration: adapt existing pages + routing |
| **E** | 11, 12 | Polish: styling + mobile |

---

## Files Inventory: What Changes Where

### New Files
| File | Purpose |
|------|---------|
| `lib/workspace-context.tsx` | Workspace React context provider |
| `components/dashboard/new-project-modal.tsx` | Project creation modal |
| `components/integrations/integration-cards.tsx` | Shared integration card components (extracted from `/projects/new`) |

### Major Modifications
| File | Changes |
|------|---------|
| `app/(dashboard)/layout.tsx` | Complete rewrite: add sidebar + header + context provider |
| `components/dashboard/sidebar.tsx` | Complete rewrite: project list as chat sessions |
| `components/dashboard/topbar.tsx` | Complete rewrite: project header with runs/settings |
| `app/(dashboard)/projects/[projectId]/chat/page.tsx` | Remove fixed positioning + top bar, integrate with new layout |
| `app/(dashboard)/projects/new/page.tsx` | Deprecate or convert to redirect + modal trigger |
| `app/(dashboard)/projects/page.tsx` | Smart redirect to last project or empty state with auto-modal |

### Minor Modifications
| File | Changes |
|------|---------|
| `app/layout.tsx` | Add `dark` class for default dark theme |
| `app/actions/auth.ts` | Update post-login redirect |
| `app/(dashboard)/projects/[projectId]/page.tsx` | Simplify redirect logic |
| `app/(dashboard)/projects/[projectId]/setup/page.tsx` | Update redirect to use modal |
| `app/(dashboard)/projects/[projectId]/runs/page.tsx` | Remove back-link, adapt to shell |
| `app/(dashboard)/projects/[projectId]/runs/[runId]/page.tsx` | Remove back-link, adapt to shell |
| `app/(dashboard)/projects/[projectId]/settings/page.tsx` | Remove back-link, adapt to shell |
| `components/chat/chat-nav.tsx` | Deprecate (functionality moves to header) |

### Unchanged (no modifications needed)
- All API routes (`app/api/**`)
- `lib/chat/*`, `lib/supabase/*`, `lib/integrations/*`
- `components/chat/chat-interface.tsx` (minor: may need width adjustments)
- `components/chat/message-bubble.tsx`, `flow-proposal-card.tsx`
- `components/ui/*` (all shadcn primitives)
- Database schema (no migrations needed)
- `runner/*` (Python backend unchanged)

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| GitHub OAuth callback redirects to `/projects/new?projectId=...` | Update callback `return_to` to use the new modal trigger URL or handle the param in the new layout |
| Slack OAuth callbacks similarly redirect | Same approach as GitHub |
| Chat page uses `fixed inset-0` positioning | Remove fixed positioning, let it flow within the layout |
| `ChatInterface` auto-sends bootstrap message on empty session | No change needed — this still works within the new layout |
| Mobile sidebar overlay may conflict with chat input | Test thoroughly, use proper z-index layering |
| Integration card components are deeply nested in `/projects/new` | Extract into shared module before building the modal |

---

## Success Criteria

1. **Sidebar shows all projects** as clickable chat sessions
2. **Clicking a project** shows its chat in the main area
3. **"New Chat" button** opens a modal for project creation (name, URL, integrations)
4. **First-time users** automatically see the creation modal
5. **Runs and Settings** are accessible from the top header without leaving the chat context
6. **Dark theme** is the default
7. **Visual language** closely mirrors Claude Code (clean, minimal, dark, chat-centric)
8. **All existing functionality** (chat, runs, settings, integrations, scheduling) continues to work
9. **Mobile** is responsive and usable
