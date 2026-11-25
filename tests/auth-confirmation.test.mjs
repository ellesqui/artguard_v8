import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { resolveAuthCallback } from '../src/utils/authCallback.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('email callback parsing recognizes PKCE signup codes and supported token hashes', () => {
  const codeCallback = resolveAuthCallback('?code=pkce-code&type=signup', '', false);
  assert.equal(codeCallback.kind, 'authorization-code');
  assert.equal(codeCallback.emailConfirmation, true);
  assert.equal(codeCallback.code, 'pkce-code');

  const tokenHashCallback = resolveAuthCallback('', '#token_hash=otp-hash&type=email', false);
  assert.equal(tokenHashCallback.kind, 'email-confirmation');
  assert.equal(tokenHashCallback.tokenHash, 'otp-hash');
  assert.equal(tokenHashCallback.type, 'email');
});

test('implicit signup sessions and invalid confirmation tokens are distinguished', () => {
  const implicitCallback = resolveAuthCallback(
    '',
    '#access_token=access&refresh_token=refresh&type=signup',
    false,
  );
  assert.equal(implicitCallback.kind, 'email-confirmation');
  assert.equal(implicitCallback.type, 'signup');

  const invalidCallback = resolveAuthCallback('', '#token_hash=bad&type=recovery', false);
  assert.equal(invalidCallback.kind, 'invalid-email-confirmation');
});

test('Google and existing email-link callbacks retain their separate classifications', () => {
  const googleCallback = resolveAuthCallback('?code=oauth-code', '', true);
  assert.equal(googleCallback.kind, 'authorization-code');
  assert.equal(googleCallback.emailConfirmation, false);

  const existingEmailLogin = resolveAuthCallback(
    '?flow=existing-google-login&code=email-code',
    '',
    false,
  );
  assert.equal(existingEmailLogin.kind, 'existing-google-email-login');
});

test('Staging username-collision function creates a unique suffix and restricts roles', async () => {
  const migration = await readFile(
    resolve(root, 'supabase/migrations/20261125143117_handle_new_user_username_collision_guard.sql'),
    'utf8',
  );
  const db = new PGlite();
  try {
    await db.exec(`
      create schema auth;
      create table auth.users (
        id uuid primary key,
        email text,
        raw_user_meta_data jsonb not null default '{}'::jsonb
      );
      create table public.profiles (
        id uuid primary key references auth.users(id),
        name text not null,
        username text not null unique,
        role text not null check (role in ('artist', 'client'))
      );
    `);
    await db.exec(migration);
    await db.exec(`
      create trigger on_auth_user_created
      after insert on auth.users
      for each row execute function public.handle_new_user();
    `);

    await db.query(
      'insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)',
      ['10000000-0000-4000-8000-000000000001', 'maya@example.test', { name: 'Maya', role: 'artist' }],
    );
    await db.query(
      'insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)',
      ['10000000-0000-4000-8000-000000000002', 'maya@other.test', { role: 'admin' }],
    );

    const { rows } = await db.query(
      'select username, role from public.profiles order by id',
    );
    assert.equal(rows[0].username, 'maya');
    assert.equal(rows[0].role, 'artist');
    assert.match(rows[1].username, /^maya_[a-f0-9]{12}$/);
    assert.equal(rows[1].role, 'client');
  } finally {
    await db.close();
  }
});
