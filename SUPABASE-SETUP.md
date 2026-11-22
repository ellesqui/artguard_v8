# ArtGuard Hub — Real Backend Setup

The code is ready for real multi-user accounts, profile discovery, chat, read state, reactions, and online/last-seen presence.

## 1. Create the Supabase project

Create a project in Supabase and open its SQL Editor.

Run the entire file:

`supabase/schema.sql`

That creates:

- `profiles`
- `conversations`
- `conversation_participants`
- `messages`
- auth profile trigger
- `get_or_create_conversation(...)`
- Row Level Security policies
- Realtime publication entries

## 2. Repair/enable profile inserts

If `Table Editor → profiles` is empty, run `supabase/profile-repair.sql` once in SQL Editor. This also adds the safe self-insert RLS policy used immediately after signup.

## 3. Add the frontend environment variables

Create:

`artguard/.env.local`

with:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Use the **publishable** key supplied by Supabase. Do not use a service-role/secret key in a browser app.

## 4. Install the new dependency

From `artguard/`:

```bash
npm install
```

The project now includes:

```json
"@supabase/supabase-js": "^2.115.0"
```

## 5. Authentication

For a classroom/demo build, the easiest path is to temporarily disable email confirmation in Supabase Auth so a new signup immediately receives a session.

With email confirmation enabled:

1. Sign up.
2. Confirm the email.
3. Return to ArtGuard Hub and log in.

The auth trigger automatically creates the matching `profiles` row.

### Password strength policy

The application checks new passwords for an 8-character minimum, uppercase and
lowercase letters, a digit, a symbol, and common/repeated/sequential patterns.
The same check runs before either mock or Supabase signup. This is an
application-side check; it does not configure or prove enforcement by Supabase.

To enforce the character rules at the provider, open **Authentication → Sign In
/ Providers → Email → Password security** in the Supabase Dashboard. Set the
minimum password length to **8** and require **lowercase letters, uppercase
letters, digits, and symbols**. Supabase's current password-security
documentation warns that newly strengthened requirements can also reject
existing users' passwords during `signInWithPassword` ([password security
guide](https://supabase.com/docs/guides/auth/password-security)). Because that could
prevent existing users from logging in, do not enable the stronger provider
policy until its impact on existing accounts has been assessed. The dashboard
setting is not visible to this repository, so provider-side enforcement must
be verified in the project itself.

## 6. Testing multi-user chat

Use two separate browser sessions:

- Browser profile / normal Chrome window = Account A
- Incognito window = Account B

Create two accounts, then:

1. Sign in as A.
2. Open **Messages**.
3. Search B by name.
4. Start a conversation.
5. Send a message.
6. Sign in as B in the second session.
7. Open **Messages**.
8. The conversation and message should be present.
9. Send a reply.
10. Return to A — the reply should arrive through Realtime without manually refreshing.

Presence is also Realtime-based. While B is connected, A sees **Active now**. After B disconnects,
the profile falls back to the saved `last_seen_at` heartbeat, such as **Active 2m ago**.

### Chat profile, mute, and block controls

The conversation menu's **View Profile** action opens the existing safe public
profile page for the other conversation participant. To enable persisted
per-conversation notification mutes and server-enforced user blocking, manually
review and apply `supabase/chat-mute-and-block.sql` in the Supabase SQL Editor.
Apply it only after confirming that the project's existing database already has
the canonical `participant_low` / `participant_high` conversation columns and
the hardened `send_message(uuid, uuid, text, text, text, integer, text, text,
text)` function. Its migration prerequisites are `chat-auth-runtime-fix.sql`,
`chat-stabilization.sql`, `chat-reset-history.sql`, and
`chat-write-security-hardening.sql` in their documented dependency order.
For an existing project, verify those prerequisites are already applied; do
not rerun the base schema, old chat scripts, or unrelated migrations to install
this change.

The migration adds only per-user conversation notification preferences and
directed user-block relationships. It replaces the existing conversation
creation and message-send RPCs with compatible versions that reject a new
conversation or message if either participant has blocked the other. It does
not alter stored messages, unread-message counts, existing notification rows,
commission data, or profile data. The chat mute preference suppresses browser
chat notifications for that conversation; it does not change unread message
counts or unrelated artwork, commission, and system notifications. The app
does not create persistent notification rows for chat messages.

The application never runs this migration automatically. Verify prerequisite
functions and columns in the target project's SQL Editor before applying this
single migration, then test with two development accounts. Without applying
it, the new mute/block controls cannot load or save settings and the server
will not enforce blocking.

## Important scope note

Chat images and documents are uploaded to a private Supabase Storage bucket and referenced by the
existing messages table. They are not stored as PostgreSQL binaries. In mock mode, selected files are
local to the current browser session and are not persisted.

## Secure artwork storage (Batch A)

Run `supabase/artworks.sql` once in the Supabase SQL Editor after the base
schema/profile repair scripts. This creates:

- `public.artworks`, with owner-only RLS for artwork metadata.
- A private `artworks` Storage bucket with owner-scoped object policies.
- JPG/PNG and 40MB server-enforced Storage/database constraints.

The Shield upload path stores originals in a private bucket under an
authenticated user's folder and requests short-lived signed URLs. The current
client generates a protected derivative in the browser: enhanced and maximum
levels add a visible ArtGuard mark, while maximum also repeats a text overlay.
Canvas tiling, dynamic cloaking, and right-click blocking are client-side
deterrents only. They are not encryption, server-side transformation, DRM, or
protection against screenshots, browser tools, or a determined recipient.
Standard level does not add a watermark. Never describe these controls as
preventing copying.

If the migration has not been run, Shield uploads fail with a setup error; the
app does not fall back to local or public storage.

### Artwork publishing and Discover

To enable persisted artwork publication controls and real protected artwork in
Discover, manually review and run `supabase/artwork-publication.sql` in the
Supabase SQL Editor after `artworks.sql`, `protection.sql`,
`artist-public-portfolio.sql`, `artist-verification-admin-preview.sql`, and
`commission-deliverables-foundation.sql` have been applied. This migration is
not run by the application or build.

The migration preserves previously public portfolio entries by assigning
existing ready artworks with a protected derivative to **Protected Portfolio**.
It then defaults new artwork to **Private**, adds the upload categories
Character, Chibi, Concept Art, Portrait, Fanart, Environment, and Other, and
limits portfolio and Discover queries plus protected-derivative storage access
to eligible visibility. Original files remain private, and the existing
verification and commission-deliverable policies remain separate.

### Private chat attachments and protected artwork sharing

After `chat-mute-and-block.sql` and `artwork-publication.sql` and all of their
prerequisites have been applied, manually review and run
`supabase/chat-attachments-and-artwork-sharing.sql`. The chat prerequisite
includes the canonical participant columns, the hardened `send_message`
function, and the `user_blocks` table/functions from the mute-and-block
migration. Artwork sharing requires the published-artwork fields and
`artwork_protection_settings` used by the existing publication system.

This migration adds attachment references and an artwork ID to existing chat
messages, creates a private `chat-attachments` bucket, and installs
participant-scoped policies for uploading, reading sent files, and removing
orphaned uploads. It replaces the existing authenticated `send_message` RPC;
sender identity continues to come from `auth.uid()`, while conversation
membership, block state, attachment type/size/path, and artwork ownership and
publication are validated server-side. The app allows JPG, PNG, WebP, and GIF
images up to 15 MB, plus PDF, text, Office, and ZIP documents up to 20 MB.
HTML, SVG, scripts, and executable file types are not accepted. File links use
short-lived authorized downloads; uploaded content is never rendered as HTML.

The artwork selector only includes ready artwork with a protected derivative
whose current visibility is **Protected Portfolio** or **Discover**. The
message references the artwork record instead of uploading a second copy.
Recipients receive a protected preview only while the artwork remains eligible;
making it private or deleting it prevents further preview signing. The migration
does not change artwork visibility or grant access to private/original files.

The application never runs this migration automatically. Verify the listed
prerequisites in the target project's SQL Editor and apply this migration once.
Do not rerun the base schema or unrelated migrations to enable attachments.

### Correcting per-user chat deletion and canonical threads

The previously applied `supabase/chat-fresh-threads-after-deletion.sql`
migration allowed a new conversation ID when either participant had deleted
their inbox view. That behavior can create duplicate threads for one pair.
After that migration and its prerequisites, the next required step is to
review and apply
`supabase/chat-canonical-per-user-reset-correction.sql` once in the Supabase
SQL Editor. Do not rerun older migrations or the base schema.

The corrective migration chooses the original (oldest) row as the canonical
conversation for each duplicate direct-message pair. It moves existing message
rows to that conversation without changing message IDs or payloads, keeps
superseded conversation rows as aliases, and merges participant-specific
`reset_at` boundaries independently. Attachment storage object paths remain
unchanged; the migration updates the attachment read policy to resolve those
paths through their superseded conversation alias. It restores a unique
constraint for active pair threads and updates conversation resolution to
reuse the canonical ID. A new message reopens only the recipient's inbox
visibility (`hidden_at`); it does not clear that participant's `reset_at`
history boundary. The existing `deleted_at` value is retained as legacy
deletion metadata and is no longer used to create a new thread.

This forward-only correction also restores the recipient-unhide trigger and
ensures `conversation_participants` is in `supabase_realtime` with a policy
allowing users to read their own participant rows. The application does not
run this migration automatically. Review its reconciliation behavior and
apply it only after the already-applied fresh-thread migration; do not claim
the live database is corrected until it has been applied and tested.

### Persistent Discover likes and comments

After all prerequisites for `supabase/artwork-publication.sql` have been applied,
manually review and run `supabase/artwork-engagement.sql` in the Supabase SQL
Editor. Apply it after `artworks.sql`, `artist-public-portfolio.sql`, and
`artwork-publication.sql`; the publication migration itself requires the
protection, artist-verification preview, and commission-deliverable foundation
migrations described above. Neither migration is run automatically by the app.

The engagement migration adds `artwork_likes` with a unique `(artwork_id,
user_id)` primary key and `artwork_comments` with author/artwork foreign keys,
non-empty/2,000-character checks, and artwork/order indexes. RLS is enabled,
direct table privileges are revoked, and authenticated, narrowly scoped RPCs
provide counts, current-user like state, comments, idempotent like changes, and
comment creation. RPCs require `auth.uid()` and accept only ready artwork with
a protected derivative and `visibility = 'discover'`. There is no edit or
delete-comment UI/API in this phase.

Supabase-backed Discover interactions read and write those persisted records.
Mock mode keeps session-only likes/comments and labels them as demo behavior.
There is no Realtime synchronization; another client sees changes after it
fetches the artwork/engagement again. This repository change has not been
verified against a live development Supabase project, and the migration has not
been run against any database. Verify it on a dedicated development project
before deployment; do not apply it to production without review.

To notify artwork owners about new Discover likes and comments, apply
`supabase/artwork-engagement-notifications.sql` manually after `notifications.sql`
and `artwork-engagement.sql`, with the publication migration prerequisites
above installed first. It extends the existing `notifications` table and uses
database triggers on successful engagement inserts; it does not create a second
notification store or emit notifications for existing likes/comments. Existing
recipient-filtered Realtime delivery is reused. Do not run this migration
against production automatically.

Password reset has `/forgot-password` and `/reset-password` routes. The
forgot-password flow requests a Supabase Auth recovery email that redirects to
`/reset-password`; the reset page checks the recovery session and calls
`updateUser({ password })`. Configure and verify the provider's recovery
redirect allow-list for each deployed hostname. In mock mode, password-reset
behavior is demo-only and does not send an email or change a Supabase password.


## Usernames and public profiles update

Run `supabase/add-usernames.sql` once in the Supabase SQL Editor. It adds a `username` column and
backfills it from the email local-part, so `example@gmail.com` is shown as `@example` in ArtGuard.

After this update, the Messages search looks for either a display name or `@username`. Clicking a
person opens their public profile first, where the user can see the person's name, @username, role,
presence/last-seen status, bio/interests, and a **Message @username** button. Desktop Messages search
uses the same People search as mobile/tablet, so the behavior is consistent on wide web screens too.


### Important for the existing project

Because your existing `profiles` table was already created before usernames were added, run
`supabase/add-usernames.sql` once. You do not need to rerun the full `schema.sql`.

## Role-symmetric public commission posts

To enable Client- and Artist-owned public commission posts, run these forward-only SQL files
in the Supabase SQL Editor after the existing public commission-post migrations have been
applied:

1. `supabase/commission-post-role-symmetry.sql`
2. `supabase/commission-post-symmetric-selection.sql`
3. `supabase/commission-start-symmetric-public-post-payment-guard.sql`

The first migration backfills existing posts as Client-owned and existing applications as
Artist-submitted while retaining the legacy `client_id` and `artist_id` columns. It does not
delete or recreate existing post/application rows. The second adds transactional selection
for either owner role. The third preserves public-post provenance and the paid-before-start
requirement for both commission participant mappings. Do not run these migrations before
their existing commission-post, comments, notifications, commissions, and payment
dependencies are installed.

## Phase 0 profile expand/contract and transaction hardening

**None of these corrective migrations has been applied to production.** They
are not run by the application, build, Supabase CLI, or Vercel deployment.
Validate all referenced tables, columns, policies, and exact function
signatures against a disposable Supabase-compatible project before production
approval. Repository SQL files do not prove that the target database has those
objects or migration history.

### Pro entitlement write protection

`artist-verification-foundation.sql` and
`artist-commission-availability.sql` grant authenticated clients column-level
`UPDATE` access to `profiles.is_pro`. Apply
`supabase/pro-entitlement-hardening.sql` after both migrations to revoke that
table- and column-level client write access while preserving ordinary profile
edits and existing `is_pro` values. Validate it in staging before relying on `is_pro` as a
trusted entitlement:

```sql
select has_column_privilege(
  'authenticated', 'public.profiles', 'is_pro', 'UPDATE'
) as authenticated_can_update_is_pro;
```

The result must be `false`; also verify that allowed profile fields remain
editable and that entitlement changes use a trusted backend process. No live
database check or production application of this migration has been performed.

The forward-only database migration order is:

1. `supabase/profile-access-expand.sql`
2. `supabase/commission-transition-hardening.sql`
3. `supabase/phase0-permission-hardening.sql`
4. `supabase/commission-payment-simulation-lockdown.sql` — after the latest
   payment RPC definition/grants, including
   `commission-payment-cancellation-coordination.sql`, and the current
   `start_commission(uuid)` payment guard; this revokes authenticated simulated
   success and direct payment-table writes, and requires provider verification
   before paid-gated commissions can start.
5. `supabase/pro-entitlement-hardening.sql` — after both
   `artist-verification-foundation.sql` and
   `artist-commission-availability.sql`, so neither earlier grant can restore
   authenticated `is_pro` writes.
6. `supabase/profile-access-hardening.sql` — the profile **contract** stage;
   apply only after the frontend and legacy-client gate below.

Google sign-up also depends on `supabase/google-signup-role-rpc.sql`. This
separate authentication prerequisite defines the self-only
`set_my_signup_role(text)` SECURITY DEFINER RPC used to persist the selected
Artist or Client role for an incomplete Google signup without granting direct
client updates to `profiles.role`. Apply it after the core profile schema and
before deploying the Google signup flow. It does not replace
`profile-access-expand.sql`, which supplies `get_my_profile()`, and it does not
change profile SELECT privileges. The migration matrix lists it as a feature
migration rather than part of the Phase 0 corrective sequence.

### Conditional missing-RPC recovery

`supabase/google-auth-profile-rpc-recovery.sql` contains the approved
`get_my_profile()` definition followed by `set_my_signup_role(text)`. The
reported post-run diagnostic found the signup-role function but no
`get_my_profile()` in any schema. Inspection confirms the profile function is
present, executable SQL, correctly dollar-quoted, and matches
`profile-access-expand.sql`; the two definitions are in one transaction. The
reported result therefore does not identify a defect in that file. It cannot
establish whether only part of the file was selected/executed, the transaction
failed or was rolled back, a different project was queried, or the function was
removed later. The signup-role function may also have existed before that file
was run.

For the reported state, use the separate
`supabase/google-auth-get-my-profile-recovery.sql`. This file creates only
`public.get_my_profile()`, applies its minimal function permissions, and
requests a PostgREST schema reload. It does not recreate or modify
`set_my_signup_role(text)`, grant profile table SELECT, change profile RLS, or
modify profile rows. The approved response is the complete JSONB row for the
authenticated caller only, matching the existing `MyProfile`/`AuthContext`
contract; it does not accept another user's ID or replace the explicit safe
projections used for public profile reads.

**Run only the standalone file** after confirming the SQL Editor is connected
to the intended project and schema. Open that file, execute its entire contents
once, then run the read-only verification query below. Do not rerun the previous
combined recovery file. Validate in staging first and use a trusted migration
role; a new SECURITY DEFINER function is owned by the executing role, while
replacing an existing function preserves its owner. Verify the resulting
signature, return type, owner, search path, and ACL in the target database.

```sql
select
  n.nspname as schema_name,
  p.oid::regprocedure as signature,
  pg_get_function_result(p.oid) as result_type,
  p.prosecdef as security_definer,
  p.proconfig as function_settings,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_my_profile', 'set_my_signup_role')
order by p.proname;
```

Expect two rows: `get_my_profile()` returning `jsonb` and
`set_my_signup_role(text)` returning `boolean`; both should be SECURITY
DEFINER, executable by `authenticated`, and not executable by `anon`. The
profile function should have the fixed search path
`pg_catalog, public, pg_temp`.

Do not rerun the full Expand migration after Contract, because Expand restores
table-wide authenticated profile SELECT. This standalone recovery does not
recreate `is_current_user_admin()` or validate the rest of the Phase 0 state.

The expand migration adds `get_my_profile()` and
`is_current_user_admin()` while explicitly retaining authenticated table-wide
profile SELECT and the existing public-profile row policy. This is temporary
backward compatibility for already-deployed bundles that still issue
`SELECT *`. It does not alter profile INSERT grants/policies or the Auth signup
trigger. The new frontend retrieves the signed-in user's full record through
`get_my_profile()` and uses explicit safe projections for other profiles.
Apply Expand once and in order only: rerunning it after Contract would restore
table-wide profile SELECT and reopen sensitive-column access.

The commission transition migration serializes deliverable and milestone
approvals with commission state, rejects NULL or incorrect client roles, and
locks the commission before completion checks. The closed-commission child
mutation guard takes that same lock, preventing late workflow writes from
racing a completion or cancellation. Cancellation voids pending payment
records only; a paid record is not represented as refunded. Refunds remain a
separate simulated action.

The permission migration removes inherited `PUBLIC` and `anon` execution from
the reviewed RPCs and submitted-commission Storage helper while preserving
`authenticated` and `service_role` execution. It leaves the already restricted
`start_commission` grants and the other two Storage-helper grants unchanged.
It standardizes the reviewed `SECURITY DEFINER` lookup paths, including the
profile helpers created by the expand stage.

The payment lockdown migration must follow
`commission-payment-cancellation-coordination.sql`, which also re-grants
authenticated access to the success RPC, and the current
`start_commission(uuid)` payment guard. It removes `PUBLIC`, `anon`, and
`authenticated` execution from `simulate_commission_payment_success(uuid)`,
preserves `service_role` execution, and hardens the function's search path. It
also revokes table- and column-level payment writes from client roles and adds
`provider_verified_at`. A trigger blocks payment-gated commission starts unless
a matching PAID record has that marker. No current frontend or RPC sets it.
Existing `PAID` records remain unchanged and unverified; they cannot authorize
new starts, while already-started commissions are not changed. The migration
does not add a provider or make any payment real. Review payment records and
active commissions using trusted evidence before staging or production use.

The contract migration removes table-wide and sensitive-column profile reads,
then grants authenticated clients only the safe public profile columns.
`get_my_profile()` continues to return the caller's own complete profile.
Admin verification remains behind its authorization-checked RPCs, and the
protected verification-preview policy uses `is_current_user_admin()` rather
than exposing `is_admin`. The signup trigger, self-row fallback insert,
commission, chat, Marketplace, Discover, and Shield flows must be tested before
this stage.

### Required release sequence

1. Apply `profile-access-expand.sql` in the verified non-production project.
   Keep the existing authenticated `SELECT *` behavior during this stage. Also
   verify that `google-signup-role-rpc.sql` has been applied after the core
   profile schema before enabling the Google signup flow.
2. Apply `commission-transition-hardening.sql`, then
   `phase0-permission-hardening.sql`, after their exact prerequisites are
   confirmed. These do not contract profile column access.
3. Apply `commission-payment-simulation-lockdown.sql` after verifying its exact
   function signature and after all migrations that define or grant that
   function, including `commission-payment-cancellation-coordination.sql`.
   Existing frontend bundles may display
   a now-disabled simulation control until refreshed; the database denies the
   call regardless.
4. Deploy the updated frontend. A Vercel deployment does **not** invalidate
   JavaScript already loaded in open tabs.
5. Verify `get_my_profile()` and all public profile consumers, including
   onboarding, account settings, Marketplace/Discover, chat, commission
   workspaces, admin verification, and protected previews. Exercise non-payment
   commission workflows; payment-gated commissions cannot start until a trusted
   provider integration exists.
6. Establish the legacy-client deprecation gate: notify users, allow active
   commission work to reach a safe saved state, and have users close/reopen or
   refresh the app while idle. Review Supabase API logs for legacy
   `profiles?select=*` requests and wait through an owner-defined observation
   period. Do not infer client refresh from Vercel deployment alone.
7. Apply `profile-access-hardening.sql` only after the owner confirms the
   legacy-client gate is satisfied. Verify profile projections, admin review,
   Storage previews, signup, and the active commission/chat workflows again.

There is no existing minimum-frontend-version or forced-refresh mechanism.
No forced reload is added here: an already-loaded legacy bundle cannot receive
new polling code, and reloading during unsaved commission work could disrupt a
user. Log monitoring alone cannot detect a dormant tab, so if the owner cannot
confirm old sessions have been drained, **do not apply the contract migration**.

### Rollback and recovery

The expand stage is additive and can normally remain installed if frontend
deployment is delayed or rolled back. Do not drop its helpers while any
frontend or policy may call them. After a migration commits, there is no
automatic rollback: prepare a reviewed forward correction and a database
backup/recovery plan before production work.

If a contract rollout causes profile failures, keep or redeploy a compatible
frontend and repair forward. Regranting table-wide SELECT may restore legacy
behavior, but it also restores access to sensitive profile columns; treat that
as an explicitly approved, temporary security exception, not the routine
rollback. Do not deploy an old bundle after contract without a separately
reviewed recovery plan.

Before any production change, validate the prerequisite feature migrations
that define the verification RPCs, commission request/review/milestone/
cancellation/completion/start RPCs, and Storage helpers. Then apply each
corrective migration separately and test signup, public profiles/discovery,
chat attachments, protected artwork access, verification administration, and
commission transitions. These files are not replacements for historical SQL,
and their presence in the repository is not proof that production has been
updated.

## Current commission payment boundary

`public.commission_payments` persists participant IDs, amount, currency,
provider/reference placeholders, and a status. The app can create records and
the failure/refund actions remain simulations that update database state only.
After `commission-payment-simulation-lockdown.sql`, authenticated clients can
no longer call the simulated-success RPC or write payment rows directly; only
a trusted `service_role` caller can execute the simulation. The simulation does
not set `provider_verified_at`, so it cannot authorize a commission start.
There is still no checkout provider, verified webhook, idempotency ledger,
escrow, or artist payout integration. A stored `PAID` status is not proof that a
provider charged or settled funds. Existing `PAID` rows remain unchanged and
have no verification marker; reconcile them using trusted evidence.

Before real payment processing, select a provider and add a server-only checkout
creation path, verify webhook signatures and event ownership server-side,
record provider event/transaction IDs with database-enforced idempotency,
validate amount/currency against the locked commission, and implement
reconciled refund and payout records. Provider secrets must remain in trusted
server/Edge Function configuration; browser-supplied payment success must
never set a real payment to `PAID`.

## Profile privacy, avatars, and DOB

The current profile editor converts selected PNG/JPEG avatars to data URLs and
writes the Base64 payload into `profiles.avatar_data_url`; the public-profile
projection includes that field. The file input's `accept` attribute is only a
browser hint, and the current editor does not enforce an upload-size limit.
Large avatar payloads can inflate profile rows and public profile responses.
Before scaling this feature, move avatars to a size-limited private/public
Storage design with server-enforced MIME/size checks; do not treat the browser
hint as validation.

`profile-private-details.sql` creates a separately restricted DOB table and an
Auth-user trigger that reads `raw_user_meta_data.date_of_birth`. The current
signup call does not send that metadata and the UI has no DOB capture, so the
file alone does not collect or backfill DOB values. Mock account types may have
an optional DOB field, but the public-user conversion strips it. Confirm the
intended collection/legal basis before enabling DOB capture.

## Frontend and Edge Function deployment checks

The frontend selects Supabase mode when both `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` are present; otherwise auth falls back to the
browser mock. Only the publishable key belongs in frontend configuration.
`vercel.json` contains the SPA history rewrite, not project/environment
associations. Vercel CLI and authorized project inspection were unavailable
during this review, and `.env.local` values were not read. Verify Vercel's
production/preview variable associations and Supabase project URL in the
provider dashboard before release.

The `google-login-existing` Edge Function is retained for legacy frontend
clients. The repository's current handler returns `{ "accepted": "true" }`
after verification and returns `{ "code": "account_not_found" }` for an
ineligible account. The deployed legacy revision and its exact response
contract have not been independently inspected; do not redeploy this endpoint
during the transition.

The new `google-login-existing-v2` endpoint shares the RS256/JWKS token
verification and existing-account checks with the legacy handler. Its
configuration intentionally sets `verify_jwt = false` because the handler
performs Google ID-token verification itself. On success it returns
`{ "accepted": "true" }`; the frontend then exchanges the same Google ID token
with Supabase Auth using `signInWithIdToken`, which creates a persistent
Supabase session. This flow does not send an email OTP.

Use this staged deployment sequence:

1. Deploy only `google-login-existing-v2`:
   `npx supabase functions deploy google-login-existing-v2 --project-ref tyqyyxhvvszpyvyaagwx --no-verify-jwt`
2. Confirm its deployed version and `verify_jwt` setting in the Supabase
   dashboard. Confirm its required server-side Supabase settings,
   `GOOGLE_CLIENT_ID`, and allowed frontend origins without exposing secret
   values.
3. Deploy the updated frontend, which invokes only `google-login-existing-v2`.
4. Perform one controlled Google login and protected-route browser refresh.
5. Keep `google-login-existing` deployed for rollback compatibility until the
   new frontend is confirmed stable. Do not remove it during this rollout.

The Google OAuth Web client ID used by `VITE_GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_ID`, and the Supabase Auth Google provider must match. Keep the
Google client secret and Supabase service-role key server-side; never put them
in frontend `VITE_*` variables. The local source and configuration do not
prove which revisions or provider settings are deployed.

## Account deactivation and deletion requests

`supabase/account-lifecycle-hardening.sql` is a forward-only migration. Run it
only in staging first, after the profile, commission, payment, artwork, chat,
and notification tables listed at the start of the migration exist. It adds
server-authorized `deactivate_my_account()` and
`request_my_account_deletion()` RPCs, account-state checks for authenticated
table and ArtGuard Storage access, and a private deletion-request status table.
The RPCs derive identity from `auth.uid()`; the frontend supplies no user ID.

Recommended rollout:

1. Reconcile migration history and apply/test the Phase 0 Expand and corrective
   migrations in their documented order. Keep the profile Contract migration
   blocked until the legacy-client gate in the Phase 0 deployment guide is met.
2. Verify all prerequisites and test `account-lifecycle-hardening.sql` in a
   disposable Supabase staging project. Specifically exercise both roles,
   active commission/payment rejection, duplicate requests, RLS, Storage, and
   session revocation.
3. Apply the account-lifecycle migration before deploying the frontend that
   calls `is_my_account_active()` and the account-management RPCs. The new
   frontend fails closed if this migration is missing.
4. Deploy the frontend only after staging checks pass. Existing active clients
   remain compatible; deactivated users are blocked by database triggers and
   restrictive RLS even when using an older frontend.
5. Keep profile Contract rollout separate. Do not infer that Vercel deployment
   refreshes already-open tabs, and do not apply Contract until the legacy
   profile `SELECT *` clients have been retired.

Deactivation is reversible state, not deletion. It is rejected while the
account has an active commission, pending payment, open/selected commission
post, or pending application. A successful request preserves profile,
artwork, chat, commission, and financial records, then asks Supabase Auth to
sign out all sessions. Access tokens already issued may remain valid until
expiry; the database guards are the enforcement boundary during that period.
Reactivation remains a verified support/admin operation.

Deletion is a private request, not an immediate hard delete. It is rejected
until the same active-work checks pass, deduplicated while open, and readable
only by the requesting account through RLS. The additive
`supabase/account-deletion-admin-review.sql` migration requires both
`account-lifecycle-hardening.sql` and the trusted
`public.is_current_user_admin()` helper from `profile-access-expand.sql`. It
adds the `IN_REVIEW` state and a private
`account_deletion_request_reviews` audit table. Its Admin RPCs verify the
caller server-side with the existing Admin helper; they expose only the
requester's name, username, role, relevant business-state counts, and review
history, not messages or unrelated profile data. Review transitions are
`PENDING` → `IN_REVIEW` → `APPROVED` or `REJECTED`; decision reasons are
required and each transition records the Admin and timestamp.

The Admin review UI records a decision only. An approved request remains
blocked from new protected writes and awaits a separate authorized retention
process. No Auth user, profile, artwork, Storage object, commission, payment,
or chat record is deleted or marked complete by this workflow. The repository
does not establish a retention period or implement final deletion.

### Reports & Moderation

`supabase/reports-moderation.sql` adds the authenticated report submission and
Admin review workflow. It requires the existing profile Admin helper, account
lifecycle write guard, published protected-artwork schema, public commission
post table, and real commission table. Apply those foundations first, then run
this migration as a trusted database migration role. Its SECURITY DEFINER
functions have a fixed search path; the migration revokes default function and
table access before granting only authenticated RPC execution and reporter
status-column reads.

The supported report targets are public profiles, published artwork, open
commission posts, and commissions in which the caller is a participant.
Reporters choose a category and may include up to 2,000 characters of details.
Self-reporting is rejected where a target has a single owner. A reporter may
have only one OPEN/IN_REVIEW report for the same target and is limited to ten
reports in a rolling 24-hour window. Reporters can read only their own status
columns; descriptions, target snapshots, and review history are available only
through Admin-authorized RPCs.

Admin transitions are `OPEN` → `IN_REVIEW` → `RESOLVED` or `DISMISSED`.
Resolution and dismissal require an explanation. Each transition records the
reviewing Admin, action, reason, and timestamp. This workflow records decisions
only: it does not hide content, suspend users, delete data, or alter commission
or payment state. Demo-mode report dialogs are previews and do not save or send
reports.

Before any controlled deployment, validate anon, reporter, other authenticated
user, and Admin behavior in an isolated Supabase-compatible environment.
Exercise target visibility, duplicate/rate-limit checks, private detail and
history access, required decision reasons, and conflicting transitions. No
reports migration has been applied to production or verified against a live
Supabase project.

Recommended rollout: validate both lifecycle migrations in a disposable
Supabase staging project, then deploy them before the frontend that uses the
request status and Admin review RPCs. Verify Artist/Client denials, own-request
RLS, direct status-write denial, review transitions and audit history, active
work checks, Storage gating, and the absence of deletion side effects. Keep
profile Contract rollout separate.

Neither lifecycle migration nor the Admin review migration has been applied
to production. Before production use, staging must verify the exact live
table/RPC/policy definitions, Admin helper ownership, Storage behavior, Auth
global sign-out, concurrent account writes versus state transitions, and
every SECURITY DEFINER read RPC that may expose private history. No live
Supabase lifecycle behavior has been verified here.

Prior local validation used a disposable PGlite database with test-only Supabase
roles, `auth.uid()`, Auth users/profiles, the required commission/payment/chat/
artwork/notification tables, and `storage.objects`. Twenty-two assertions passed
across the lifecycle suite and follow-up compatibility checks, including
idempotency, Artist and Client deactivation, deletion-request privacy and
deduplication, active-work rejection, blocked post-deactivation writes,
signup lifecycle-row creation, active Admin profile reads, active Storage
preview reads, and trusted `service_role` state management. PGlite does not
verify Supabase Auth token revocation, actual Storage policy integration,
production RLS definitions, or concurrent sessions.
