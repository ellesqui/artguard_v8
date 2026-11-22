# Phase 0 Deployment and Recovery Guide

## Status

This is a local release-preparation guide. **No Phase 0 migration has been
applied to production, and no frontend or Edge Function has been deployed.**
Repository SQL is not proof of the live schema or migration history. See the
[complete SQL inventory](./PHASE0-DATABASE-MIGRATION-MATRIX.md) for all 77
current SQL files and their source-declared dependencies.

## Required rollout

Use a dedicated non-production Supabase project first. Do not apply every SQL
file in the repository; reconcile the target project's migration history,
tables, exact RPC signatures, roles, grants, RLS policies, Storage policies,
and active payment rows before each stage.

1. **Profile expand:** apply `supabase/profile-access-expand.sql`. This adds
   the own-profile RPC/helpers and intentionally preserves broad authenticated
   profile reads for older bundles.
2. **Commission and RPC hardening:** apply
   `supabase/commission-transition-hardening.sql`, then
   `supabase/phase0-permission-hardening.sql`, only after confirming every
   prerequisite function, table, column, trigger, and policy. Validate
   approvals, completion, cancellation, notification deduplication, and role
   restrictions in non-production.
3. **Payment lockdown:** after verifying
   the latest payment RPC definition and grants (including
   `commission-payment-cancellation-coordination.sql`) and the exact
   `simulate_commission_payment_success(uuid)` signature and current
   `start_commission(uuid)` payment guard, apply
   `supabase/commission-payment-simulation-lockdown.sql`. The database denies
   authenticated success simulation and direct payment-table writes, even from
   old cached clients. Paid-gated commissions require the new
   `provider_verified_at` marker; no current function sets it. Existing `PAID`
   rows remain unchanged with a NULL marker and cannot authorize a new start.
   Already-started commissions are not changed. The UI removes the success
   control and identifies paid-but-unverified records.
4. **Frontend release:** deploy the updated frontend only after testing against
   the expanded non-production schema. Verify sign-up/profile fallback,
   `get_my_profile()`, safe public projections, marketplace/discovery/chat
   profile reads, and the payment-blocked UI. Vercel deployment does not
   refresh already-open tabs.
5. **Legacy-client gate:** notify users and allow active unsaved work to reach
   a safe state. Have users close/reopen or refresh while idle. Review API
   logs for old `profiles?select=*` calls and wait through an owner-defined
   observation period. Dormant tabs are not proven drained by a deployment or
   by logs alone.
6. **Profile contract:** only after the owner confirms the legacy-client gate,
   apply `supabase/profile-access-hardening.sql`. Recheck safe projections,
   own-profile reads, signup/fallback creation, admin verification, Storage
   previews, chat, marketplace, discovery, and active commission workflows.

The expand migration must precede the frontend release. The profile contract
must remain last. The payment lockdown is forward-only and can make older UI
payment-success buttons fail with permission errors; that is intentional and
does not authorize those clients to set `PAID`. Existing `PAID` records must
be reconciled using trusted provider evidence; until then their new-start
eligibility is blocked.

## Recovery

- **Before applying:** use a reviewed backup and record the current schema,
  grants, policies, and payment rows. Confirm the exact deployment target and
  secrets without copying secret values into tickets or logs.
- **Expand only:** it is additive and can normally remain installed if frontend
  rollout is delayed. Do not remove helper functions while any policy or
  frontend may call them. Do not reapply Expand after Contract: its compatibility
  grant restores table-wide profile SELECT.
- **Payment lockdown:** do not restore authenticated execution of simulated
  success or direct payment-table writes as a rollback. If paid-gated work
  cannot proceed, pause that path until a provider-verified payment flow exists.
  Do not remove the provider-verification gate or infer settlement from stored
  `PAID` status; reconcile existing rows using trusted records. The marker is
  intentionally NULL for old rows and no status is rewritten.
- **Commission/RPC hardening:** do not reverse grants or triggers ad hoc.
  Correct forward with a reviewed migration and re-test the affected workflow.
- **Profile contract:** if reads fail, repair forward and keep/redeploy a
  compatible frontend. Regranting table-wide `SELECT` exposes sensitive
  columns again and is not a routine rollback. Do not deploy a stale bundle
  after contract without a separately approved recovery plan.

## Environment and operational limits

The frontend uses `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`; no service-role key belongs in frontend
configuration. Local `.env.local` values were not inspected. `vercel.json`
only contains the SPA rewrite, and Vercel project/environment associations
were not verifiable here. Supabase CLI, Docker, PostgreSQL client tools, and
Vercel CLI were unavailable; no remote connection or production SQL was
attempted. The exact deployed Edge Function revision also remains unverified.

Current payment success is intentionally disabled for authenticated clients
until trusted provider verification exists. Payment failure/refund UI actions
remain simulated and do not move money. Shield uses private originals,
short-lived signed URLs, and client-side preview deterrents; those deterrents
are not DRM or screenshot protection. Profile avatars are currently stored as
data URLs in profile rows, and current signup does not collect DOB despite the
optional private-details migration.

## Final Phase 0 closure review

| Requirement | Status | Evidence / remaining limitation |
|---|---|---|
| Local payment lockdown and frontend fail-closed behavior | COMPLETED | Client success simulation and direct payment-table writes are denied; payment-gated starts require `provider_verified_at`. The marker is not set by any current client RPC. |
| Corrective migration sequence | TESTED LOCALLY | 71 PGlite assertions passed for Expand, commission hardening, permission hardening, payment lockdown, and Contract, including safe reapplication of the contract-stage migrations. |
| Profile access across Expand and Contract | TESTED LOCALLY | Legacy `SELECT *` succeeded during Expand and was denied after Contract; safe projections, own-profile JSONB RPC, signup/fallback insertion, Admin RPC stubs, and Storage-policy stub passed. |
| Commission and payment workflows | TESTED LOCALLY | Approval, duplicate-notification prevention, completion guards, cancellation of pending-only payments, preserved paid rows, denied client writes/success RPC, pending creation/history, and start rejection for unverified `PAID` rows passed. |
| SQL migration inventory | COMPLETED | The matrix contains 77 unique SQL rows, matching all 77 files in `supabase/`. |
| Confirmed production profile exposure | VERIFIED LIVE | Earlier supplied live privilege evidence confirmed broad profile reads. The Contract migration remains unapplied, so treat that exposure as ongoing; no fresh live query was made. |
| Production migration application state | UNVERIFIED | No production SQL was run in this review. Prior local records say the migrations remain unapplied, but that was not independently verified against the live project. |
| Existing production `PAID` payment records | UNVERIFIED | No live payment rows were queried or reconciled. Treat every stored `PAID` row as unverified until supported by trusted provider evidence. The new migration leaves those rows unchanged and blocks new payment-gated starts without the verification marker. |
| Legacy-client deprecation gate | BLOCKED | No evidence establishes that old bundles or open browser sessions using profile `SELECT *` have been retired. Do not apply the profile Contract migration until the documented gate is completed. |
| Deployed Edge Function revision | UNVERIFIED | No live deployment inspection was performed. |
| Vercel production environment | UNVERIFIED | Project association, deployed bundle, and production environment values were not verified. |
| Real Supabase workflows and concurrency | UNVERIFIED | PGlite is not Supabase/PostgREST, and this run used a single database session. No live RLS/Storage/Auth integration or concurrent-session race test was performed. |
| Production readiness | BLOCKED | Non-production Supabase staging validation, live migration reconciliation, payment-row reconciliation, client retirement, and deployment verification are still required. No production changes are authorized by this report. |

### Local test record

The disposable PGlite baseline used test-only `anon`, `authenticated`, and
`service_role` roles; `auth.uid()`; `auth.users`; profile, commission,
milestone, deliverable, revision, payment, notification, and Storage objects;
and minimal signup, verification, Storage-helper, and pre-existing trigger
stubs. Supabase-managed Auth, PostgREST, Storage, and live Admin function
behavior were simulated, not verified.

The source SQL dependencies applied before the corrective sequence were:

1. `commission-payments-foundation.sql`
2. `commission-payment-cancellation-coordination.sql`
3. `commission-payment-refunds.sql`
4. `commission-start-symmetric-public-post-payment-guard.sql`

The tested corrective order was:

1. `profile-access-expand.sql`
2. `commission-transition-hardening.sql`
3. `phase0-permission-hardening.sql`
4. `commission-payment-simulation-lockdown.sql`
5. `profile-access-hardening.sql` (Contract)

The profile RPC returns one scalar `jsonb` object for `auth.uid()`; the frontend
uses the Supabase RPC `data` as that object, not as an array. Public profile
consumers use explicit safe projections. `provider_verified_at` is checked by
the frontend and start guard; unverified `PAID` rows are excluded from revenue
metrics and displayed as unverified. The mock/local workspace path was not
changed by these Supabase-only payment checks.
The Expand migration is intentionally excluded from reapplication checks after
Contract because rerunning it would reopen broad profile access.

Final local validation: TypeScript passed; targeted Oxlint passed; Vite build
passed; the temporary production bundle had no checked service-role/provider
secret patterns; all 77 SQL inventory rows matched; and the non-Git whitespace
check found no trailing whitespace. Vite emitted existing Ionic `host-context`
CSS and large-chunk warnings. Temporary PGlite and build files were kept
outside the repository and removed after validation.
