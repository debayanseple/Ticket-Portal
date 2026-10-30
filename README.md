# S-Watch 360 Desk

SDesk360 manages service tickets for devices across bank branches. HMS owns device-health monitoring and sends fault and restoration events; SDesk360 does not poll or independently determine device health.

## Stack

- React + TypeScript (Vite), Tailwind CSS, React Router, TanStack Query, `@supabase/supabase-js`
- Backend: Supabase only (Postgres, Auth, Row Level Security, Edge Functions, `pg_cron`, `pg_net`)
- Reports use the browser print dialog; choose **Save as PDF** to export.

No Docker anywhere. Runs against a hosted Supabase project.

## Prerequisites

- Node.js 20+
- A hosted Supabase project

## Setup

1. Copy environment variables:
   ```bash
   cp .env.example .env.local
   ```
2. Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from your Supabase project settings (API section). The client also accepts `VITE_SUPABASE_ANON_KEY` for existing local setups.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Apply the database migrations to your hosted project:
   - Open the Supabase SQL Editor and apply unapplied files from `supabase/migrations/` in filename order.
   - Do not run `supabase start`; local development uses the hosted database and does not require Docker.
   Migrations live in `supabase/migrations/`; the initial demo seed is in `0003_seed.sql`.
5. Deploy Edge Functions:
   ```bash
   npx supabase functions deploy send-emails --no-verify-jwt
   npx supabase functions deploy invite-user
   npx supabase functions deploy api --no-verify-jwt
   ```
6. Set Edge Function secrets (from Supabase dashboard → Edge Function → Settings):
   - `EMAIL_SEND_URL` and `EMAIL_API_KEY` for the selected email provider (optional; without them, delivery is recorded as not configured/failed)
   - `TICKETS_API_KEY` (a long random string) for machine ticket ingestion through `api`
   - `HMS_API_TOKEN` (a long random string) for HMS fault and restoration events
   - `SCHEDULED_JOB_SECRET` (a long random string) for scheduled email delivery
7. Enable `pg_cron` and `pg_net` extensions in your Supabase project (SQL editor):
   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;
   ```
8. Run the app:
   ```bash
   npm run dev
   ```
   Open http://localhost:5173

## HMS event API

The `api` Edge Function exposes fault and restoration endpoints. Authentication
uses `Authorization: Bearer <HMS_API_TOKEN>`. Event IDs are unique within the
`hms` source namespace. Replaying the same event ID returns its stored result
without repeating a ticket transition.

Faults create tickets immediately. The current active-ticket rule is one open
ticket per device: a distinct fault received while that ticket remains open is
appended to its issue description and audit history. A new fault after
resolution creates a new ticket. Restoration events must reference the original
fault `event_id` in `correlation_event_id`; unmatched events are recorded and
return a controlled 404 response.

Base URL: `https://<project-ref>.supabase.co/functions/v1/api/v1/hms`

Fault request:

```bash
curl -X POST https://<project>.supabase.co/functions/v1/api/v1/hms/fault \
  -H "Authorization: Bearer $HMS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event_id":"fault-2026-0001","branch_key":"BA","device_key":"BA-TLK","issue_description":"Timelock unreachable","occurred_at":"2026-10-29T08:30:00Z"}'
```

Success returns the event ID, processing result, ticket ID/number, and whether
the event was a retry or appended to an existing open ticket. Mapping failures
are saved to `hms_events` and return `processing_result: unmatched`.

```json
{
  "event_id": "fault-2026-0001",
  "processing_result": "processed",
  "ticket_id": "<ticket-uuid>",
  "ticket_number": "SW-000123",
  "existing_open_ticket": false
}
```

Restoration request:

```bash
curl -X POST https://<project>.supabase.co/functions/v1/api/v1/hms/restoration \
  -H "Authorization: Bearer $HMS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event_id":"restore-2026-0001","correlation_event_id":"fault-2026-0001","occurred_at":"2026-10-29T09:15:00Z"}'
```

The restoration resolves only the ticket created or associated with that fault
event. Replays are safe, and unrelated tickets are never matched by device
alone.

```json
{
  "event_id": "restore-2026-0001",
  "processing_result": "resolved",
  "ticket_id": "<ticket-uuid>",
  "ticket_number": "SW-000123"
}
```

Set `HMS_API_TOKEN` and `SCHEDULED_JOB_SECRET` as Edge Function secrets. For
scheduled email delivery, add these values to Supabase Vault before applying
the lifecycle migration:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'sdesk360_function_url');
select vault.create_secret('<same value as SCHEDULED_JOB_SECRET>', 'sdesk360_scheduled_secret');
```

Escalations are evaluated by hosted `pg_cron` at 24, 48, and 72 hours. Each
ticket/level is recorded once in `ticket_escalations`. Missing SI email is
recorded as `not_configured`; an absent email provider never appears as sent.

## Ticket API (Edge Function `api`)

The `api` function is the REST surface for the portal and external systems. Reads require a
Supabase JWT and are scoped by the existing RLS policies. Writes accept a Head Office JWT or an
`x-api-key` header.

Base URL: `https://<project-ref>.supabase.co/functions/v1/api`

Deploy it with the platform JWT check disabled, because the function verifies tokens itself
(`/auth/login` and `/health` must stay reachable without a token):

```bash
npx supabase functions deploy api --no-verify-jwt
npx supabase secrets set TICKETS_API_KEY=<long-random-secret>
```

### Authentication (JWT)

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/login` | `{ email, password }` → access token, refresh token, profile |
| POST | `/auth/refresh` | `{ refresh_token }` → new access token |
| GET | `/auth/me` | Current profile (Bearer) |
| POST | `/auth/logout` | Revoke the session (Bearer) |

Send the access token on every data request: `Authorization: Bearer <access_token>`. Tokens are
normal Supabase Auth JWTs, so the same RLS policies that protect the app protect the API.

### Data endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/tickets` | List, filter, search and paginate tickets |
| GET | `/tickets/:id` | Ticket detail with activity timeline and email history |
| GET | `/tickets/stats` | Total, open, resolved, escalated and today's counts |
| GET | `/tickets/breakdown` | Scoped open/resolved/escalated counts per branch and device |
| GET | `/branches` | Branches visible to the caller (filter dropdown) |
| GET | `/ticket-filters` | Scoped branch, device category, and assigned SI options |
| POST | `/tickets` | Receive a ticket (`x-api-key` or Head Office Bearer) |
| POST | `/v1/hms/fault` | Authenticated HMS fault event |
| POST | `/v1/hms/restoration` | Idempotent HMS restoration event |
| GET | `/health` | Database health check (public) |

`/tickets` query parameters: `status` (`open`/`resolved`, case-insensitive), `escalation_level`
(0–3), `escalated` (`true` for any level above 0), `branch_id`, `device_id`, `device_serial`
(partial serial match), `from` / `to` (ISO lower and exclusive upper bounds on `created_at`), `resolved_from` / `resolved_to`
(ISO lower and exclusive upper bounds on `resolved_at`), `search` (ticket number, branch name or code, device serial), `page`
(default 1), `limit` (default 20, max 100), `sort` (`created_at`, `updated_at`, `ticket_number`,
`escalation_level`, `status`) and `order` (`asc`/`desc`). List responses return
`{ data, page, limit, total, totalPages }`.

Additional filters include `device_type` and `si_user_id`. The current viewer's
RLS scope applies to the list and to filter-option queries.

```bash
# 1. Get a JWT
curl -X POST https://<project>.supabase.co/functions/v1/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ho@swatch.example","password":"SWatch123!"}'

# 2. Read scoped tickets
curl "https://<project>.supabase.co/functions/v1/api/tickets?status=open&page=1&limit=20" \
  -H "Authorization: Bearer <access_token>"

# 3. Push a ticket from an external system
curl -X POST https://<project>.supabase.co/functions/v1/api/tickets \
  -H "x-api-key: <TICKETS_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"branch_id":"33333333-3333-3333-3333-333333333301","device_id":"d0000001-0000-0000-0000-000000000002","note":"ATM offline reported by monitoring"}'
```

`POST /tickets` requires `branch_id`; `device_id` must belong to that branch; `si_user_id` defaults
to the branch's active SI. Ticket numbers come from the existing sequence.

The React app uses this API for login/session, the dashboard, the ticket list and ticket detail.
Ticket notes and resolution still go through the existing Supabase RPCs. Apply migration
`0005_ticket_breakdown.sql` with the other migrations; the dashboard breakdown depends on it.

The HMS lifecycle migration adds stable external keys, immutable source event
records, assignment snapshots, and per-level escalation records. It preserves
existing device and ticket rows. Apply all migrations, including
`20261029060741_sdesk360_hms_event_lifecycle.sql`, before deploying the updated
`api` and `send-emails` functions.

## Product decisions and configuration

- HMS source event IDs are unique per source system; this integration uses the
  single source namespace `hms`.
- A distinct fault received while a device already has an open ticket is
  appended to that ticket's history. This carries forward the existing
  one-open-ticket-per-device behavior. A fault after resolution starts a new
  ticket.
- Dashboard date boundaries use `Asia/Kolkata`; stored timestamps remain UTC.
- The email provider endpoint and credentials are deployment configuration.
  Until configured, escalation records remain visible and delivery is not
  reported as successful.
- Branch/device `external_key` values are optional and preferred for HMS
  mapping. Existing branch codes and device serial numbers remain valid
  fallback keys; production integrations should populate stable external keys.

Unit tests for the API helpers:

```bash
cd supabase/functions/api
deno test
deno check index.ts
```

The database lifecycle regression script is
`supabase/tests/hms_lifecycle.sql`. Run it only against a disposable hosted
development project after migrations; its transaction rolls back its fixtures.

## Demo accounts

Seeded in `supabase/migrations/0003_seed.sql`: one user per role (`head_office`, `nbg`, `zonal`, `branch`, `si`). These shared credentials are for local/demo use only; replace them before production.

| Role | Email |
| --- | --- |
| Head Office | `ho@swatch.example` |
| NBG | `nbg@swatch.example` |
| Zonal | `zonal@swatch.example` |
| Branch | `branch@swatch.example` |
| SI | `si@swatch.example` |

Password for each demo account: `SWatch123!`.

## Create a ticket through the API

The Supabase REST RPC endpoint accepts a JSON body. The caller must have a valid Supabase Auth access token and permission to the branch (Head Office users can access all branches).

```bash
curl -X POST "${SUPABASE_URL}/rest/v1/rpc/create_ticket_api" \
  -H "apikey: ${VITE_SUPABASE_PUBLISHABLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"p_branch_code":"BA","p_note":"ATM is not dispensing cash","p_device_serial":"SN-ATM-001"}'
```

`p_branch_code` is required. `p_note` and `p_device_serial` are optional; a supplied device serial must belong to the branch. The response includes the created ticket ID and ticket number. Obtain the access token by signing in through Supabase Auth; never use a service-role key in a client.

## Build & deploy

```bash
npm run build
```
Deploy the `dist/` folder to any static host (Vercel, Netlify). No Docker involved.

## Project structure

- `src/pages` — route pages
- `src/components` — shared components (layout, route guards)
- `src/lib` — Supabase client
- `src/hooks` — `useAuth`
- `src/types` — TypeScript types
- `supabase/migrations` — SQL schema, RLS, seed
- `supabase/functions` — Edge Functions
