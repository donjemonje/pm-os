# PMOS — Product Management Operations System

MVP web app for PMs: **Release Notes & User Manuals** from Jira, plus **PRD Q&A** for developers — with a dual chat ↔ web interface.

## Features

- **Organizations (multi-tenant)** — users belong to an organization; members share documents, releases, and integrations, while data is fully isolated between organizations
- **Jira Cloud OAuth** — connect your site, pick projects, read fix versions & issues
- **Release Notes (RN)** — AI draft from Jira fix version, Markdown editor, publish/export
- **User Manuals (UM)** — AI draft from linked epics/stories, editable sections
- **PRD Q&A** — developers ask in chat; answers cite Jira issues with confidence scores
- **Web ↔ Chat** — floating chat panel on any page; live document embeds in chat

## Stack

- Next.js 15 (App Router) + TypeScript
- Tailwind CSS 4
- Prisma + SQLite (local dev, zero infra)
- PMOS AI via Vertex AI (Claude or Gemini models, set with `VERTEX_MODEL`)
- Atlassian OAuth 2.0 (3LO)

## Setup

### 1. Install dependencies

```bash
cd ~/pmos
npm install
```

### 2. Environment

```bash
cp .env.example .env
```

Fill in:

| Variable | Where to get it |
|----------|-----------------|
| `AI_PROVIDER` | `vertex` (only supported value) |
| `VERTEX_PROJECT_ID` | GCP project hosting the model — defaults to `pm-os-9d992` |
| `VERTEX_LOCATION` | Must match the model: `global`/`us`/`eu` for Gemini 3.x, or a region like `us-east5` for Claude |
| `VERTEX_MODEL` | e.g. `gemini-3.5-flash` (global/us/eu) or `claude-opus-4-8@default` (regional) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service-account key JSON with the **Vertex AI User** role (or use `gcloud auth application-default login`) |
| `ATLASSIAN_CLIENT_ID` | [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/) |
| `ATLASSIAN_CLIENT_SECRET` | Same app |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` for local dev |

#### Gemini Enterprise Agent Platform (Vertex AI) — default provider

PMOS defaults to Google's Gemini Enterprise Agent Platform (formerly Vertex AI)
in project `pm-os-9d992`. The Vertex provider supports both Google Gemini models
(via the `@google/genai` SDK) and Anthropic Claude models (via the Anthropic
Vertex SDK), selected automatically from `VERTEX_MODEL`:

- **Gemini** (e.g. `gemini-3.5-flash`) — set `VERTEX_LOCATION=global` (or `us`/`eu`).
  Gemini 3.x is served only on multi-region endpoints, not single regions.
- **Claude** (e.g. `claude-opus-4-8@default`) — set a region like `VERTEX_LOCATION=us-east5`.
  Requires the model enabled in Model Garden and per-model quota approved.

Setup:

1. Enable the model in the Vertex AI Model Garden for the project.
2. Grant the **Vertex AI User** role to the identity PMOS runs as.
3. Provide credentials via Application Default Credentials — either set
   `GOOGLE_APPLICATION_CREDENTIALS` to a service-account key file, or run
   `gcloud auth application-default login` for local dev.
4. Leave `AI_PROVIDER` unset (or set it to `vertex`). Verify usage in the GCP
   console under **Vertex AI → Model Garden / Monitoring** for the project.

### 3. Atlassian OAuth app

1. Create an OAuth 2.0 (3LO) app in the Atlassian Developer Console
2. Set **Callback URL** to: `http://localhost:3000/api/auth/jira/callback`
3. Add scopes: `read:jira-work`, `write:jira-work`, `read:jira-user`, `offline_access`

### 3b. Google OAuth (Sign in + Drive)

Use the OAuth client from GCP project **`pm-os-9d992`** — not a personal GCP project.

1. Open [OAuth consent screen](https://console.cloud.google.com/auth/branding?project=pm-os-9d992)
   - **App name:** `PM-OS`
   - **User support email:** `daniel@pm-os.io`
2. Open [Credentials](https://console.cloud.google.com/apis/credentials?project=pm-os-9d992) → OAuth 2.0 Client ID (Web)
   - Redirect URI (dev): `http://localhost:3000/api/auth/oauth/google/callback`
   - Redirect URI (prod): `https://pm-os.io/api/auth/oauth/google/callback`
3. Enable APIs: Google Drive, Google Docs, Google Slides
4. Copy `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` into `dev-apphosting.yaml`

Verify your local client: `npm run google-oauth:verify`

If Google shows the wrong app name (e.g. "pmos") or developer email during connect, you're using credentials from the wrong GCP project.

### 4. Database

```bash
npm run db:push
```

### 5. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Organizations (multi-tenancy)

PMOS isolates all data by **organization**. Each organization owns one shared
workspace that holds its documents, releases, chat history, and its Jira /
Google Drive connections. Users in the same organization see the same content;
users in different organizations can never see each other's data — and the AI
only ever receives context from the caller's own organization.

- **Create an org:** on sign-up, choose "Create new" and name your organization.
- **Join an org:** on sign-up, choose "Join with code" and enter the invite code.
- **Find your invite code:** open the user menu (bottom-left) → it shows your
  organization name, member count, and a copyable invite code.

### Migrating an existing database

If you have a pre-organization database, back-fill organizations for existing
workspaces (safe to re-run):

```bash
npm run orgs:migrate
```

### Seeding demo organizations

To create two isolated demo orgs (RoomLens + CoffeePlaces), each with a user:

```bash
npm run orgs:seed
```

Then set `DISABLE_LOGIN=false` and sign in. Connect Jira for one org and Google
Drive for the other from **Settings** to see per-organization integrations.

## Usage flow

1. **Settings → Connect Jira** — OAuth, then select projects
2. **Releases → New release** — pick project + fix version, generate RN with AI
3. **Docs** — edit RN/UM in Markdown; use **AI Generate** to refresh from Jira
4. **Chat** (floating button or `/chat`) — ask PRD questions; use `?issues=PROJ-123` for scoped Q&A

### PRD Q&A deep link

```
/chat?issues=PROJ-123,PROJ-456&project=MYPROJ
```

High-confidence answers optionally post a comment back to the Jira issue.

## Project structure

```
src/
├── app/              # Pages & API routes
├── components/       # UI (chat, docs, jira, layout)
└── lib/              # db, jira, ai, types
prisma/schema.prisma # SQLite schema
```

## What's next (post-MVP)

- Confluence PRD fetch
- Realtime sync (SSE/WebSocket) for doc embeds
- Stale-doc badges when linked Jira issues change
- Multi-user auth & teams
- Export to Confluence / customer portal

## License

Private — PMOS startup MVP.
