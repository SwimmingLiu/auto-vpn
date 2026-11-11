import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AreaCursor,
  resolveAreasPerRound,
  resolveRoundPolicy,
  membershipDate,
  isMembershipExpiredMessage,
  isCredentialLoginRejection,
  fetchCredentialSourceLinks,
  createFingerprintMemo,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PLATEAU_LIMIT,
  DEFAULT_AREAS_PER_ROUND,
  DEFAULT_AREA_CONCURRENCY
} from '../../dist/pipeline/credential-source.js';
import { resolveConcurrency } from '../../dist/pipeline/concurrency.js';
import { AccountStore } from '../../dist/pool/account-store.js';
import { FIXTURE_KEY, createControlPlane } from '../fixtures/credential-control-plane.mjs';

const DISCOVERY = {
  apk_url: 'https://apk.example/lt.apk',
  key_candidates: [FIXTURE_KEY],
  package_name: 'com.leiting.lt',
  version_name: '3.17940.98243',
  cert_sha1: '0390D4D33CB1C0E52DEC94D26726249AF384D553',
  seed_domains: ['https://seed.example:20000'],
  protocol: 'v7',
  core_version: '5.12.1',
  lite_version: '5.29.4'
};

function seededStore() {
  const store = new AccountStore({ dbPath: ':memory:' });
  store.importRecords([{
    brand: 'leiting',
    account: 'fixture-account',
    password: 'fixture-password',
    official_site: 'https://www.68123836.com',
    expires_at: '',
    status: 'active',
    note: ''
  }]);
  return store;
}

test('the area cursor walks a frozen list and wraps', () => {
  const cursor = new AreaCursor([10, 20, 30]);
  assert.deepEqual(cursor.take(1), [10]);
  assert.deepEqual(cursor.take(2), [20, 30]);
  assert.deepEqual(cursor.take(2), [10, 20]);
  assert.equal(cursor.length, 3);
  // Taking more than exists clamps to one full lap, never repeating inside a take.
  assert.deepEqual(new AreaCursor([1, 2]).take(9), [1, 2]);
  assert.deepEqual(new AreaCursor([]).take(3), []);
});

test('the cursor snapshots the list, so a later mutation cannot change the run', () => {
  const source = [1, 2, 3];
  const cursor = new AreaCursor(source);
  source.push(4);
  assert.equal(cursor.length, 3);
  assert.deepEqual(cursor.take(9), [1, 2, 3]);
});

test('areas_per_round clamps to the list size and defaults to a sweep slice', () => {
  assert.equal(resolveAreasPerRound(undefined, 31), 8);
  assert.equal(resolveAreasPerRound(0, 31), 8);
  assert.equal(resolveAreasPerRound(8, 31), 8);
  assert.equal(resolveAreasPerRound(99, 31), 31);
  assert.equal(resolveAreasPerRound(5, 0), 1);
});

test('concurrency clamps into a sane range', () => {
  assert.equal(resolveConcurrency(undefined, 4), 4);
  assert.equal(resolveConcurrency(0, 4), 4);
  assert.equal(resolveConcurrency(-3, 4), 4);
  assert.equal(resolveConcurrency(99, 4), 16);
  assert.equal(resolveConcurrency(6, 4), 6);
});

test('membership dates use the local calendar day', () => {
  // Epoch seconds and milliseconds and ISO text all parse.
  assert.match(membershipDate(1798761600), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(membershipDate('2027-01-01 00:00:00'), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(membershipDate(0), '');
  assert.equal(membershipDate('0'), '');
  assert.equal(membershipDate(''), '');
});

test('a lapsed membership is classified as expired, not as a bad password', () => {
  assert.equal(isMembershipExpiredMessage('会员已过期'), true);
  assert.equal(isMembershipExpiredMessage('您的账号已到期'), true);
  assert.equal(isMembershipExpiredMessage('membership expired'), true);
  assert.equal(isMembershipExpiredMessage('密码错误'), false);
  // An expiry wording must not be filed as a credential rejection.
  assert.equal(isCredentialLoginRejection('会员已过期'), false);
  assert.equal(isCredentialLoginRejection('密码错误'), true);
  // Throttling stays transient even when it mentions the account.
  assert.equal(isMembershipExpiredMessage('登录过于频繁，请稍后重试'), false);
});

test('a relabelled duplicate does not reset the early-stop plateau', async () => {
  // Two areas hand back the SAME node identity under different route names, so
  // the raw link strings differ but the fingerprint does not. The old counter
  // treated the second string as a new node and never plateaued.
  const plane = createControlPlane({
    rounds: 2,
    relabel: true,
    perRound: { 2: ['198.51.100.10', '198.51.100.10'], 3: ['198.51.100.10'] }
  });
  const events = [];
  const store = seededStore();
  const memo = createFingerprintMemo(null, 'lt');
  memo.set(DISCOVERY);
  const result = await fetchCredentialSourceLinks(
    {
      source_name: 'leiting',
      source: {
        mode: 'credential',
        official_site: 'https://www.68123836.com',
        platforms: ['android'],
        max_iterations: 8,
        min_iterations: 1,
        plateau_limit: 2,
        areas_per_round: 1,
        key: FIXTURE_KEY
      }
    },
    { accountStore: store, fetchImpl: plane.fetchImpl, memo, eventCallback: (type, payload) => events.push({ type, ...payload }) }
  );
  store.close();

  const iterations = events.filter((event) => event.type === 'extract_iteration');
  // A round can deliver a new raw string while adding no meaningful node.
  const relabelled = iterations.find((event) => event.new_items > 0 && event.new_meaningful_items === 0);
  assert.ok(relabelled, 'a relabelled duplicate must be delivered but not counted as meaningful');
  // The plateau still fired even though raw strings kept appearing.
  assert.ok(result.diagnostics.rounds < 8, `expected an early stop, ran ${result.diagnostics.rounds} rounds`);
  // Several relabelled raw links, one node identity.
  assert.ok(result.links.length >= 2);
  const last = iterations.at(-1);
  assert.equal(last.deduped_links, 1);
});

test('each platform runs its own full round budget', async () => {
  const plane = createControlPlane({ rounds: 6 });
  const store = seededStore();
  const memo = createFingerprintMemo(null, 'lt');
  memo.set(DISCOVERY);
  const result = await fetchCredentialSourceLinks(
    {
      source_name: 'leiting',
      source: {
        mode: 'credential',
        official_site: 'https://www.68123836.com',
        platforms: ['android', 'ios'],
        max_iterations: 6,
        min_iterations: 6,
        plateau_limit: 99,
        areas_per_round: 1,
        key: FIXTURE_KEY
      }
    },
    { accountStore: store, fetchImpl: plane.fetchImpl, memo }
  );
  store.close();
  const byPlatform = Object.fromEntries(result.diagnostics.platform_results.map((entry) => [entry.platform, entry]));
  // The budget is per platform: 6 rounds each, never 3+3.
  assert.equal(byPlatform.android.rounds, 6);
  assert.equal(byPlatform.ios.rounds, 6);
  assert.equal(result.diagnostics.rounds_total, 12);
  assert.equal(result.requested_iterations, 6);
});

test('the shipped defaults are the cursor-run budget', () => {
  const policy = resolveRoundPolicy({});
  assert.equal(policy.max_iterations, DEFAULT_MAX_ITERATIONS);
  assert.equal(policy.plateau_limit, DEFAULT_PLATEAU_LIMIT);
  assert.equal(DEFAULT_AREAS_PER_ROUND, 8);
  assert.equal(DEFAULT_AREA_CONCURRENCY, 4);
});
