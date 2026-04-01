# Slack App Configuration Guide

Step-by-step instructions for configuring your Slack app at [api.slack.com/apps](https://api.slack.com/apps) so users can install it and receive Atlas test-run notifications.

---

## 1. Create a Slack App

1. Go to **https://api.slack.com/apps** and click **Create New App**.
2. Choose **From scratch**.
3. Enter an app name (e.g. "Atlas QA") and select the workspace you'll use for development.
4. Click **Create App**.

---

## 2. Configure OAuth & Permissions

Navigate to **OAuth & Permissions** in the left sidebar.

### Redirect URLs

Add the following redirect URL:

```
{YOUR_APP_URL}/api/integrations/slack/callback
```

Replace `{YOUR_APP_URL}` with the value of your `NEXT_PUBLIC_APP_URL` environment variable (e.g. `https://atlas.example.com`). This must match exactly — no trailing slash.

> The app constructs this URL at runtime in `lib/slack.ts` via `getSlackRedirectUri()`.

### Bot Token Scopes

Under **Scopes → Bot Token Scopes**, add all of the following:

| Scope | Purpose |
|-------|---------|
| `channels:history` | Read message history in public channels (used by runner for context) |
| `channels:read` | List public channels so users can pick a notification target |
| `chat:write` | Send messages to channels the bot is a member of |
| `chat:write.public` | Send messages to public channels the bot has **not** been invited to |
| `users:read` | Resolve user display names in reports |
| `team:read` | Read workspace name/ID stored alongside the integration |

### User Token Scopes

**Leave empty** — the app only uses a bot token (`user_scope` is set to `''` in the OAuth URL).

---

## 3. Set Your Environment Variables

In your `.env.local` (or deployment environment), populate:

```env
SLACK_CLIENT_ID=<from Basic Information → App Credentials>
SLACK_CLIENT_SECRET=<from Basic Information → App Credentials>
NEXT_PUBLIC_APP_URL=https://your-deployed-domain.com
```

Both `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` are on the **Basic Information** page of your Slack app under **App Credentials**.

---

## 4. Display Information (Optional but Recommended)

Navigate to **Basic Information → Display Information** and configure:

- **App name**: Atlas QA (or your preferred name)
- **Short description**: Autonomous QA test-run notifications
- **App icon**: Upload your Atlas logo (minimum 512×512 px)
- **Background color**: Match your brand

This is what users see on the OAuth consent screen when they install the app.

---

## 5. Manage Distribution

If you want **anyone** (not just your own workspace) to install the app:

1. Go to **Manage Distribution** in the left sidebar.
2. Under **Share Your App with Other Workspaces**, make sure all checklist items are green:
   - Redirect URL is set ✓
   - Bot scopes are configured ✓
   - App description is filled in ✓
3. Click **Activate Public Distribution**.

If the app is internal-only (single workspace), you can skip this step.

---

## 6. Verify the OAuth Flow

The full flow works like this:

1. A user in your dashboard hits **Connect Slack** which calls:
   ```
   GET /api/integrations/slack/authorize?project_id={uuid}
   ```
2. The server builds an OAuth URL and redirects the user to Slack's consent screen.
3. The user approves, and Slack redirects back to:
   ```
   GET /api/integrations/slack/callback?code={code}&state={project_id}
   ```
4. The server exchanges the code for a bot token via `oauth.v2.access`, encrypts it, and stores it in the `integrations` table.
5. The user is redirected to `/projects/{projectId}/settings?slack=connected`.

### Quick Verification Checklist

- [ ] `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` are set in your environment
- [ ] `NEXT_PUBLIC_APP_URL` matches the origin of your redirect URL exactly
- [ ] The redirect URL in the Slack dashboard matches `{NEXT_PUBLIC_APP_URL}/api/integrations/slack/callback`
- [ ] All six bot token scopes are added
- [ ] User token scopes section is empty
- [ ] (If public distribution) Manage Distribution is activated

---

## Summary

| Setting | Value |
|---------|-------|
| **Redirect URL** | `{NEXT_PUBLIC_APP_URL}/api/integrations/slack/callback` |
| **Bot Scopes** | `channels:history`, `channels:read`, `chat:write`, `chat:write.public`, `users:read`, `team:read` |
| **User Scopes** | _(none)_ |
| **Env Vars** | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `NEXT_PUBLIC_APP_URL` |
| **OAuth Version** | V2 (`oauth/v2/authorize` + `oauth.v2.access`) |
