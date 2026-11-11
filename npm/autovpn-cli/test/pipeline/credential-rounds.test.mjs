import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AreaCursor,
  resolveAreasPerRound,
  resolveRoundPolicy,
  resolveLapRoundPolicy,
  resolveAdvertisedMaxIterations,
  membershipDate,
  isMembershipExpiredMessage,
  isCredentialLoginRejection,
  fetchCredentialSourceLinks,
  createFingerprintMemo,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PLATEAU_LIMIT,
  DEFAULT_AREAS_PER_ROUND,
  DEFAULT_AREA_CONCURRENCY,
  DEFAULT_MAX_LAPS,
  DEFAULT_DRY_LAPS
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
  assert.equal(DEFAULT_MAX_LAPS, 50);
  assert.equal(DEFAULT_DRY_LAPS, 13);
});

test('a row with no lap key resolves to null and keeps the legacy policy', () => {
  // Null is the compatibility contract: production profiles never opted in,
  // so the caller must run the identical legacy path after the upgrade.
  assert.equal(resolveLapRoundPolicy({}, 30), null);
  assert.equal(resolveLapRoundPolicy({ max_iterations: 1000, plateau_limit: 50 }, 30), null);
  assert.equal(resolveLapRoundPolicy({ max_laps: 0 }, 30), null);
  assert.equal(resolveLapRoundPolicy({ max_laps: Number.NaN }, 30), null);
  // The advertised budget matches the legacy resolution for such a row.
  assert.equal(resolveAdvertisedMaxIterations({ max_iterations: 1000 }), 1000);
  assert.equal(resolveAdvertisedMaxIterations({}), DEFAULT_MAX_ITERATIONS);
});

test('any finite lap key opts the row in and one round becomes one lap', () => {
  const lap = resolveLapRoundPolicy({ max_laps: 50, dry_laps: 13 }, 30);
  assert.equal(lap.round_unit, 'lap');
  assert.equal(lap.areas_per_round, 30);
  assert.equal(lap.policy.max_iterations, 50);
  assert.equal(lap.policy.plateau_limit, 13);
  assert.equal(lap.policy.min_iterations, 0);
  // Defaults fill the missing key; a dry-only row still opts in.
  const dryOnly = resolveLapRoundPolicy({ dry_laps: 6 }, 26);
  assert.equal(dryOnly.policy.max_iterations, DEFAULT_MAX_LAPS);
  assert.equal(dryOnly.policy.plateau_limit, 6);
  assert.equal(dryOnly.areas_per_round, 26);
  // min_laps is the floor and is clamped to the cap; min_iterations is not read.
  const floored = resolveLapRoundPolicy({ max_laps: 4, min_laps: 9, min_iterations: 99 }, 30);
  assert.equal(floored.policy.min_iterations, 4);
  // The time budget passes through verbatim for the daily-run rewrite.
  const budgeted = resolveLapRoundPolicy({ max_laps: 5, max_runtime_seconds: 900 }, 30);
  assert.equal(budgeted.policy.max_runtime_seconds, 900);
  // Pre-flight events advertise laps, not the legacy round cap.
  assert.equal(resolveAdvertisedMaxIterations({ max_laps: 50, max_iterations: 1000 }), 50);
  assert.equal(resolveAdvertisedMaxIterations({ dry_laps: 6, max_iterations: 1000 }), DEFAULT_MAX_LAPS);
});

test('the outage and placeholder guards keep their request volume in lap mode', () => {
  // Legacy: 5 empty rounds x 8 areas = 40 requests; 8 placeholder rounds x 8
  // = 64. Lap mode rescales to laps of N with a floor of two laps.
  const at30 = resolveLapRoundPolicy({ max_laps: 5 }, 30);
  assert.equal(at30.empty_round_limit, 2);
  assert.equal(at30.placeholder_round_limit, 3);
  const at2 = resolveLapRoundPolicy({ max_laps: 5 }, 2);
  assert.equal(at2.empty_round_limit, 20);
  assert.equal(at2.placeholder_round_limit, 32);
});

test('a lap run requests every area exactly once per lap', async () => {
  // All three fixture areas answer (the group header cid=1 included), so no
  // domain retry perturbs the request order.
  const plane = createControlPlane({
    rounds: 6,
    perRound: {
      1: ['198.51.100.30', '198.51.100.31', '198.51.100.32'],
      2: ['198.51.100.10', '198.51.100.11', '198.51.100.12'],
      3: ['198.51.100.20', '198.51.100.21', '198.51.100.22']
    }
  });
  const store = seededStore();
  const memo = createFingerprintMemo(null, 'lt');
  memo.set(DISCOVERY);
  const events = [];
  const result = await fetchCredentialSourceLinks(
    {
      source_name: 'leiting',
      source: {
        mode: 'credential',
        official_site: 'https://www.68123836.com',
        platforms: ['android'],
        // The legacy keys are present but must be ignored in lap mode.
        max_iterations: 999,
        plateau_limit: 999,
        areas_per_round: 1,
        max_laps: 3,
        dry_laps: 99,
        min_laps: 3,
        key: FIXTURE_KEY
      }
    },
    { accountStore: store, fetchImpl: plane.fetchImpl, memo, eventCallback: (type, payload) => events.push({ type, ...payload }) }
  );
  store.close();
  // The fixture serves 3 areas (the group header cid=1 plus its two children,
  // open=1 keeps the header clickable): 3 laps x 3 areas = 9 requests, and each
  // lap asked every area exactly once.
  assert.equal(result.diagnostics.requests, 9);
  assert.deepEqual(plane.requestedAreas, [1, 2, 3, 1, 2, 3, 1, 2, 3]);
  assert.equal(result.diagnostics.rounds, 3);
  assert.equal(result.diagnostics.areas_per_round, 3);
  const completed = events.find((event) => event.type === 'extract_source_completed');
  assert.equal(completed.requested_iterations, 3);
  assert.equal(completed.area_count, 3);
  assert.equal(completed.round_unit, 'lap');
  const started = events.find((event) => event.type === 'extract_source_started');
  assert.equal(started.requested_iterations, 3);
});

test('a dry lap streak stops the channel at dry_laps, not at the legacy plateau', async () => {
  // Every area keeps answering, but after lap 1 it is the same node identity
  // under a new label: the meaningful-novelty plateau reaches 2 and the
  // channel stops at lap 3, far below the 50-lap cap.
  const plane = createControlPlane({
    rounds: 3,
    relabel: true,
    perRound: {
      1: ['198.51.100.30', '198.51.100.30', '198.51.100.30'],
      2: ['198.51.100.10', '198.51.100.10', '198.51.100.10'],
      3: ['198.51.100.20', '198.51.100.20', '198.51.100.20']
    }
  });
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
        max_laps: 50,
        dry_laps: 2,
        key: FIXTURE_KEY
      }
    },
    { accountStore: store, fetchImpl: plane.fetchImpl, memo }
  );
  store.close();
  assert.equal(result.diagnostics.rounds, 3);
  assert.equal(result.diagnostics.requests, 9);
});

test('a tiny lap list clamps the workers to the list length', async () => {
  const plane = createControlPlane({
    rounds: 4,
    perRound: {
      1: ['198.51.100.30', '198.51.100.31'],
      2: ['198.51.100.10', '198.51.100.11'],
      3: ['198.51.100.20', '198.51.100.21']
    }
  });
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
        max_laps: 2,
        min_laps: 2,
        dry_laps: 99,
        area_concurrency: 16,
        key: FIXTURE_KEY
      }
    },
    { accountStore: store, fetchImpl: plane.fetchImpl, memo }
  );
  store.close();
  // The concurrency knob is clamped by mapWithConcurrency to the batch width;
  // in lap mode the width is the whole (tiny) list, so nothing is starved.
  assert.equal(result.diagnostics.area_concurrency, 16);
  assert.equal(result.diagnostics.requests, 6);
  assert.deepEqual(plane.requestedAreas, [1, 2, 3, 1, 2, 3]);
});
