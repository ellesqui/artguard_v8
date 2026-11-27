# ArtGuard Hub Final Delivery — Canonical Deployment Runbook

This document is the canonical, staged deployment procedure for the Original
Supabase project. It is a preparation/runbook document; do not execute it by
accident while reviewing or editing the repository.

## Evidence classification

### Confirmed Original database evidence

- `complete_commission(uuid)` is owned by `postgres`, uses
  `SECURITY DEFINER`, has `search_path = pg_catalog, public, pg_temp`, and
  execute access for `postgres`, `authenticated`, and `service_role`.
- The Original direct-request signature is:
  `create_commission_request(uuid,text,text,date,numeric,text)`.
- The Original public-post applicant signature is:
  `select_commission_post_applicant(uuid,uuid,numeric,text,date,numeric)`.
- The live `complete_commission(uuid)` body was supplied with all existing
  authentication, ownership, locking, milestone, deliverable, revision,
  completion, notification, and return behavior.
- The Original creation ACL evidence is:
  - Direct request: `postgres`/`authenticated`
  - Public-post applicant: `postgres`/`authenticated`
  - Service request: `postgres`/`anon`/`authenticated`/`service_role`
  - Older public-post selection: `postgres`/`authenticated`/`service_role`
  - Legacy `get_or_create_commission`: `postgres`/`PUBLIC`/`anon`/
    `authenticated`/`service_role`

### Confirmed local source verification

- The foundation migration adds `final_delivery_required` with
  `NOT NULL DEFAULT false`.
- The activation migration replaces exactly two supported creator RPCs.
- The deprecated combined migration is a hard guard that raises an error.
- The foundation migration creates and validates the private bucket.
- Only the batch and file trigger names are dropped and recreated.

### Deployment facts still requiring live confirmation

The following have not been deployed or confirmed against the live Original
project:

- Migration application state
- Live function definitions and overloads
- Live Storage bucket and policy inventory
- Project-wide Storage upload limit
- Edge Function deployment state
- Edge Function secret provisioning
- Frontend environment values
- Staged smoke-test results

Do not describe these items as verified until they are checked by the operator
in the confirmed Original project.

## STOP conditions

Stop the staged rollout if any of the following are true:

- The target project reference or URL is not the intended Original project.
- Database backup/PITR is unavailable or snapshot status is unknown.
- Project-wide Storage upload limit is below 40 MiB per file.
- Existing `commission-final-deliveries` bucket settings conflict with the
  exact private, MIME, and byte-limit requirements.
- Live function signatures, overloads, owner, search path, or grants differ
  unexpectedly from the supplied evidence.
- The foundation migration reports duplicate trigger names or a partial
  transaction failure.
- Required Edge Function secrets cannot be provisioned.
- `final-delivery-storage` is not `verify_jwt = true`.
- `final-delivery-cleanup` is not `verify_jwt = false`.
- The frontend is not pointed to Original or has not passed feature-off checks.
- Activation RPC smoke checks fail.

Never apply activation if frontend or Edge Functions are not verified.

## Phase 1 — Foundation

### 1. Confirm project and backup

Before SQL operations:

1. Confirm the Original project reference and Supabase URL.
2. Confirm database backup/PITR/snapshot status and retention.
3. Confirm the operator has read-only and migration access.
4. Confirm project-wide Storage upload limit is at least 40 MiB per file.

Do not proceed with project-wide limits below 40 MiB.

### 2. Apply foundation migration

Apply exactly:

```text
supabase/commission-final-delivery-foundation.sql
```

Never apply:

```text
supabase/commission-final-delivery.sql
```

The deprecated combined migration is an intentional error guard and must not be
executed as a deployment migration.

The foundation migration is transactional and performs the bucket setup itself.
Do not run a separate bucket-creation script or manual bucket-creation step.

### 3. Verify foundation

Run these prepared read-only SQL checks in the Original SQL Editor.

Flag default and existing rows:

```sql
select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'commissions'
  and column_name = 'final_delivery_required';
```

```sql
select
  count(*) as commission_count,
  count(*) filter (where final_delivery_required) as feature_on_count
from public.commissions;
```

The existing commission check must show that no historical rows were opted in
by the foundation migration.

Foundation relations and RLS:

```sql
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'commission_final_deliveries',
    'commission_final_delivery_files'
  );
```

Foundation RPC inventory:

```sql
select
  p.oid::regprocedure as function_signature,
  pg_get_userbyid(p.proowner) as owner,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'is_final_render_approved',
    'can_upload_final_delivery_object',
    'can_read_final_delivery_object',
    'begin_commission_final_delivery',
    'get_final_delivery_upload_targets',
    'get_final_delivery_verification_targets',
    'finalize_commission_final_delivery',
    'abandon_commission_final_delivery_upload',
    'accept_commission_final_delivery',
    'request_commission_final_revision',
    'list_commission_final_deliveries',
    'get_final_delivery_download_target',
    'claim_expired_final_delivery_uploads',
    'complete_final_delivery_storage_cleanup',
    'complete_commission'
  )
order by p.proname;
```

Bucket configuration:

```sql
select
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
from storage.buckets
where id = 'commission-final-deliveries';
```

Required result:

- `public = false`
- `file_size_limit = 41943040`
- `allowed_mime_types` contains exactly:
  - `image/jpeg`
  - `image/png`
  - `application/pdf`

Bucket policies:

```sql
select
  policyname,
  cmd,
  permissive,
  roles,
  qual,
  with_check
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
order by policyname;
```

Inspect every returned policy, including restrictive policies, and determine
whether its `qual` or `with_check` expression applies to
`commission-final-deliveries`. STOP if any unintended policy grants access to
this bucket or permits authenticated `UPDATE` or `DELETE` operations.

Trigger rerun safety:

```sql
select
  event_object_table as table_name,
  trigger_name
from information_schema.triggers
where trigger_schema = 'public'
  and trigger_name in (
    'commission_final_deliveries_guard_transition',
    'commission_final_delivery_files_guard_update'
  )
order by event_object_table, trigger_name;
```

Only the two expected triggers should exist on their intended tables.

Creator-RPC feature-off verification:

```sql
select
  p.oid::regprocedure as function_signature,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'create_commission_request',
    'select_commission_post_applicant',
    'create_service_commission_request',
    'select_commission_post_artist',
    'get_or_create_commission'
  )
order by p.proname, p.oid;
```

At this stage, confirm foundation has not replaced or activated the two
supported creator RPCs. Existing false-default behavior must remain intact for
service, older public-post, legacy order-link, and existing commissions.

Do not deploy activation until foundation verification passes.

## Phase 2 — Edge Functions and frontend

### 1. Provision Edge Function secrets

Required secret names only:

`final-delivery-storage`:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ARTGUARD_ALLOWED_ORIGINS` (optional)

`final-delivery-cleanup`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FINAL_DELIVERY_CLEANUP_TOKEN`

Never print, log, request, or commit secret values.

### 2. Deploy and verify storage function

- Deploy `final-delivery-storage`.
- Confirm `verify_jwt = true`.
- Confirm it uses `SUPABASE_ANON_KEY`, not `SUPABASS_ANON_KEY`.
- Confirm missing/invalid authentication is rejected.
- Confirm no service-role credential reaches browser code or logs.

### 3. Deploy and verify cleanup function

- Deploy `final-delivery-cleanup`.
- Confirm `verify_jwt = false`.
- Confirm cleanup requires the exact header:
  `X-Final-Delivery-Cleanup-Token`.
- Confirm missing or incorrect token handling is safe.
- Confirm missing required service configuration fails closed.
- Confirm cleanup credentials and values are not logged.

### 4. Deploy frontend

- Deploy the updated frontend pointing to the Original project.
- Confirm frontend URL and publishable key correspond to Original.
- Confirm no secret/service-role key is present in browser bundles.

### 5. Phase 2 smoke checks

Before activation, verify:

- Feature-off legacy commissions do not show mandatory Final Delivery.
- Existing WIP and milestone workflows remain separate.
- Existing payment, revision, cancellation, and completion behavior remains.
- Final Delivery RPC/UI is not accidentally active for feature-off creation
  paths.

Do not apply activation unless Phase 2 passes.

## Phase 3 — Activation

Apply exactly, and only after Phase 2 verification passes:

```text
supabase/commission-final-delivery-activation.sql
```

Verify:

- Only `create_commission_request(...)` is replaced.
- Only `select_commission_post_applicant(...)` is replaced.
- The exact function signatures and defaults remain unchanged.
- Each new commission insert sets `final_delivery_required = true`.
- No existing commission rows were bulk-updated.
- Owner remains `postgres`.
- Execute ACL permits only `authenticated` and `postgres` for these two RPCs.
- Service requests remain feature-off.
- Older public-post selection remains feature-off.
- Legacy order-linking remains feature-off.
- `complete_commission`, payments, milestones, WIP deliverables, revisions,
  and cancellation are unchanged.

Read-only function-definition check:

```sql
select
  p.oid::regprocedure as function_signature,
  pg_get_userbyid(p.proowner) as owner,
  pg_get_functiondef(p.oid) as definition,
  has_function_privilege('postgres', p.oid, 'EXECUTE') as postgres_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('public', p.oid, 'EXECUTE') as public_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'create_commission_request',
    'select_commission_post_applicant'
  )
order by p.proname, p.oid;
```

## Phase 4 — Final smoke test

Use dedicated test accounts and test commissions. Do not mutate production
customer records.

Artist:

- Feature-on commission is visible.
- Upload is blocked until Final Render is approved.
- Approved Final Render permits batch creation.
- New signed upload links are issued only while more than 3 hours remain in the
  24-hour reservation. Previously issued links may still be used during part
  of the final 3 hours, but each expires at least 1 hour before reservation
  expiry because its fixed validity is 2 hours.
- Multiple JPEG/PNG/PDF files can be selected.
- Upload, verification, and submission states complete successfully.
- Files already uploaded can still be verified and submitted until the original
  reservation expiry; the 3-hour cutoff applies to new upload authorization,
  not finalization.
- Partial failure does not expose or submit a partial batch.
- A Client revision request allows a new Artist attempt.
- Previous batches remain in history.
- Accepted or historical files cannot be overwritten.

Client:

- Submitted files appear after submission.
- Image and PDF preview use the protected download flow.
- Download uses participant authorization.
- Client can accept only the current submitted batch.
- Client can request revision with a nonblank reason.
- Client cannot submit a Final Delivery batch.
- Artist cannot accept their own delivery.
- Acceptance does not complete the commission.

Compatibility and completion:

- Legacy feature-off commission has no mandatory Final Delivery.
- Existing WIP deliverables and milestone workflow remain separate.
- Completion remains blocked until an accepted current Final Delivery exists
  only for feature-on commissions.
- Accepted files remain accessible after commission completion.
- Service, older public-post, and legacy creation paths remain feature-off.

STOP and activate rollback procedures if any of these checks fail.

## Rollback and recovery

### Activation rollback

- Roll back the two activation creator replacements first if only activation
  behavior is defective.
- Restore only the reviewed feature-off creator definitions.
- Do not update existing commissions.
- Do not remove the foundation migration.

### Edge Function rollback

- Redeploy the previous verified function revision if a storage or cleanup
  function is defective.
- Preserve existing cleanup token configuration until diagnosis is complete.
- STOP cleanup traffic if missing configuration or authentication behavior is
  uncertain.

### Database and Storage rollback

- Do not delete historical commissions.
- Do not delete WIP deliverables or revision records.
- Do not delete submitted, revision-requested, or accepted Final Delivery
  records.
- Do not delete accepted or historical Final Delivery files.
- Do not remove the private bucket solely to roll back activation.
- If a policy defect is found, change only the narrowly scoped policy.
- If creator activation must be reversed, restore only the two creator RPC
  definitions; leave unrelated RPCs and existing data untouched.

## Deployment sign-off

Deployment owner: ____________________

Date/time: ____________________________

Original project reference: ______________

- [ ] Original project confirmed
- [ ] Backup/PITR confirmed
- [ ] Project-wide upload limit is at least 40 MiB
- [ ] Foundation migration applied in one transaction
- [ ] Flag default verified false
- [ ] Existing commission feature-on count verified unchanged
- [ ] Foundation tables/RPCs/RLS verified
- [ ] Exact two trigger names/tables verified
- [ ] Private bucket verified
- [ ] Exact 41943040-byte limit verified
- [ ] Exactly JPEG/PNG/PDF allowlist verified
- [ ] Storage update/delete policy absence verified
- [ ] Storage secrets provisioned without values disclosed
- [ ] Cleanup secret provisioned without values disclosed
- [ ] `SUPABASE_ANON_KEY` spelling verified
- [ ] `final-delivery-storage verify_jwt = true`
- [ ] `final-delivery-cleanup verify_jwt = false`
- [ ] Cleanup token header verified
- [ ] Frontend deployed and pointed to Original
- [ ] Feature-off legacy smoke checks passed
- [ ] Activation migration applied last
- [ ] Only two creator RPCs opt in
- [ ] Existing commission rows were not bulk-updated
- [ ] Service/older-public-post/legacy paths remain feature-off
- [ ] Final Artist/Client smoke tests passed
- [ ] Completion guard passed
- [ ] Post-completion file access passed
- [ ] Rollback owner and recovery point identified
