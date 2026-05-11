# Plane Agent Affluentos

Plane agent runtime for the live `affluentos` workspace at `https://plane.affluentos.com`.

## Runtime

- One codebase, split roles:
  - `APP_ROLE=ingress` serves `GET /setup`, `GET /oauth/callback`, `POST /webhooks/plane`, health, and admin inspection endpoints.
  - `APP_ROLE=worker` polls queued Agent Run jobs and posts Plane activities asynchronously.
  - `APP_ROLE=all` runs both for local/dev.
- Storage:
  - `DATABASE_URL` is required for split `ingress` and `worker` deployments so both roles share queue and install state.
  - `DATABASE_PATH` is only for local/dev or single-process `APP_ROLE=all`.
- Plane activity support:
  - activity types: `thought`, `action`, `response`, `elicitation`, `error`
  - signals: `continue`, `stop`, `auth_request`, `select`
- Control surfaces:
  - `GET /health`
  - `GET /health/worker`
  - `GET /admin/jobs`
  - `GET /admin/runs/:runId`
  - `GET /admin/installations/:workspaceId`
  - `GET /admin/scope-matrix`

## OAuth and install model

- Bot Token flow is the default install path for autonomous workspace behavior.
- User Token flow is supported for per-user authorization state on the same callback surface.
- Per-user Plane writes prefer a stored user token when one exists for the run creator; otherwise the bot token is used.
- Installation records persist:
  - workspace binding
  - bot token and expiry
  - install status
  - installation health timestamps
- User token records persist:
  - workspace user binding
  - access token, refresh token, and expiry

## Tooling and policy

- Current bounded tool families:
  - `plane.list_projects`
  - `plane.get_work_item`
  - `plane.list_work_items`
  - `plane.create_work_item`
  - `plane.update_work_item`
  - `plane.create_comment`
  - `plane.create_project_page`
  - `plane.create_wiki_page`
  - `plane.create_link`
- Policy controls:
  - destructive deletes blocked by default
  - `WRITE_KILL_SWITCH`
  - `ENABLE_AUTONOMOUS_WRITES`
  - `PROJECT_ALLOWLIST`
  - `PROJECT_BLOCKLIST`
  - `MAX_WRITES_PER_RUN`
- All tool executions are written to the audit log table and exposed through run inspection.

## Scope matrix

- Install-first bot scopes:
  - `agents.runs:read`
  - `agents.run_activities:read`
  - `agents.run_activities:write`
- Later bot expansion families:
  - `projects:read`
  - `projects.work_items:read`
  - `projects.work_items:write`
  - `projects.work_items.comments:read`
  - `projects.work_items.comments:write`
  - `projects.work_items.links:read`
  - `projects.work_items.links:write`
  - `projects.pages:write`
  - `wiki.pages:write`
- User/profile:
  - `profile:read`

Plane app permissions are configured in Plane. The OAuth consent redirect itself does not send a `scope` query parameter; this matches Plane's current app-install example.

`PLANE_OAUTH_SCOPES` remains the runtime's declared capability matrix for policy, audit, and expected bot-token permissions. Keep it aligned with the permissions configured on the Plane app. Start with the install-first bot scope set above, confirm install succeeds, then expand by family only when those tool families are needed.

## Required Plane app settings

- Setup URL: `https://plane-agent.affluentos.com/setup`
- Redirect URI: `https://plane-agent.affluentos.com/oauth/callback`
- Webhook URL: `https://plane-agent.affluentos.com/webhooks/plane`
- Enable App Mentions: `on`

## Environment

See `.env.example`.

Key variables:

- `APP_ROLE`
- `PUBLIC_BASE_URL`
- `PLANE_BASE_URL`
- `PLANE_CLIENT_ID`
- `PLANE_CLIENT_SECRET`
- `PLANE_REDIRECT_URI`
- `PLANE_WEBHOOK_SECRET`
- `PLANE_OAUTH_SCOPES`
  - install-first recommended value: `agents.runs:read agents.run_activities:read agents.run_activities:write`
- `PLANE_USER_OAUTH_SCOPES`
- `DATABASE_URL` or `DATABASE_PATH`
- `DATABASE_URL` is mandatory when `APP_ROLE=ingress` or `APP_ROLE=worker`
- `ENABLE_AUTONOMOUS_WRITES`
- `WRITE_KILL_SWITCH`
- `MAX_WRITES_PER_RUN`
- `OPENAI_API_KEY`
  - required for `APP_ROLE=all` and `APP_ROLE=worker`
  - not required for `APP_ROLE=ingress`
- `OPENAI_MODEL`

## Local development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

## Deployment notes

- Deploy ingress and worker as separate processes using the same image and environment, differing only by `APP_ROLE`.
- Use Postgres in production for shared queue, install, audit, and memory state.
- Keep SQLite only for local/dev or single-node proofs.
- Each role exposes HTTP health endpoints on its own port; the worker process now binds a listener for probes as well.
- Do not place this service inside the Plane application stack.
- After deployment, create/install the Plane OAuth app in the `affluentos` workspace and copy the generated `client_id`, `client_secret`, and webhook secret into the service environment.
