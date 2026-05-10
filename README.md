# Plane Agent Affluentos

External read/respond-only Plane agent service for the live `affluentos` workspace at `https://plane.affluentos.com`.

## Runtime

- HTTPS service with these endpoints:
  - `GET /health`
  - `GET /setup`
  - `GET /oauth/callback`
  - `POST /webhooks/plane`
- Persistent state is stored in SQLite at `DATABASE_PATH`.
- Plane remains untouched; this service runs separately and only posts agent-run activities back into Plane.

## Required Plane app settings

- Setup URL: `https://plane-agent.affluentos.com/setup`
- Redirect URI: `https://plane-agent.affluentos.com/oauth/callback`
- Webhook URL: `https://plane-agent.affluentos.com/webhooks/plane`
- Enable App Mentions: `on`
- Suggested scopes:
  - `agents.runs:read`
  - `agents.runs:write`
  - `agents.run_activities:read`
  - `agents.run_activities:write`
  - `projects.work_items:read`
  - `projects.work_items.comments:read`
  - `profile:read`

## Environment

See `.env.example`.

Key variables:

- `PLANE_BASE_URL`
- `PLANE_CLIENT_ID`
- `PLANE_CLIENT_SECRET`
- `PLANE_REDIRECT_URI`
- `PLANE_WEBHOOK_SECRET`
- `PLANE_OAUTH_SCOPES`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `DATABASE_PATH`

## Local development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

## Deployment notes

- Deploy as a separate Coolify application with its own domain.
- Mount persistent storage so the SQLite database survives restarts.
- Do not place this service inside the Plane application stack.
- After deployment, create/install the Plane OAuth app in the `affluentos` workspace and copy the generated `client_id`, `client_secret`, and webhook secret into the service environment.
