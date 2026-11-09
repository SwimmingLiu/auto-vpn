import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchCredentialSourceLinks } from '../../dist/pipeline/credential-source.js';
import { AccountStore } from '../../dist/pool/account-store.js';
import { createFingerprintMemo, resolveCredentialPlatforms } from '../../dist/pipeline/credential-source.js';
import { FIXTURE_KEY, createControlPlane } from '../fixtures/credential-control-plane.mjs';

/**
 * The dashboard's raw and dedupe cards are fed by `extract_iteration`. The URL
 * mode has always emitted it; the credential mode only reported at the end, so
 * a live run stayed at 0 until the brand finished and looked stalled.
 */
test('a credential source reports per-round progress to the dashboard', async () => {
  const plane = createControlPlane({ rounds: 3 });
  const events = [];
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

  const discovery = {
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
  const memo = createFingerprintMemo(null, 'lt');
  memo.set(discovery);

  const result = await fetchCredentialSourceLinks(
    {
      source_name: 'leiting',
      source: {
        mode: 'credential',
        official_site: 'https://www.68123836.com',
        platforms: ['android'],
        max_iterations: 3,
        min_iterations: 3,
        plateau_limit: 1,
        key: FIXTURE_KEY
      }
    },
    {
      accountStore: store,
      fetchImpl: plane.fetchImpl,
      memo,
      eventCallback: (type, payload) => events.push({ type, ...payload })
    }
  );
  store.close();

  assert.ok(result.links.length > 0, 'the fixture must produce links');
  const substages = events.filter((event) => event.type === 'extract_substage');
  assert.ok(substages.some((event) => event.substage === 'apk_download' && event.status === 'cached'));
  assert.ok(substages.some((event) => event.substage === 'apk_analysis' && event.status === 'cached'));
  assert.ok(substages.some((event) => event.substage === 'domain_discovery' && event.status === 'success'));


  const iterations = events.filter((event) => event.type === 'extract_iteration');
  assert.ok(iterations.length >= 2, `expected one progress event per round, got ${iterations.length}`);
  // Every round has to reach the dashboard, including a round that found
  // nothing new: that update is what tells the user the loop is still alive.
  assert.equal(iterations.length, 3);
  assert.deepEqual(iterations.map((event) => event.iteration), [1, 2, 3]);

  // Totals are cumulative and never move backwards.
  for (let index = 1; index < iterations.length; index += 1) {
    assert.ok(iterations[index].total_links >= iterations[index - 1].total_links);
    assert.ok(iterations[index].deduped_links >= iterations[index - 1].deduped_links);
  }
  const last = iterations.at(-1);
  assert.equal(last.total_links, result.links.length);
  assert.equal(last.deduped_links <= last.total_links, true);

  // Fingerprints are what the dedupe card counts, so they must be present on a
  // round that found links, and must not leak the link itself.
  const productive = iterations.filter((event) => event.new_items > 0);
  assert.ok(productive.length > 0);
  assert.ok(productive[0].new_item_fingerprints.length > 0);
  assert.match(productive[0].new_item_fingerprints[0], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(iterations), /vmess:\/\//);

  const completed = events.find((event) => event.type === 'extract_source_completed');
  assert.equal(completed.raw_links, result.links.length);
});

/**
 * Both channels run at once and answer the same rounds, so the merged stream
 * must count one link once. Summing the per-platform totals instead reported
 * more raw links than the run ever produced, and the renderer clamps totals
 * upward, so that number stayed on screen for the rest of the run.
 */
test('merged android and ios progress counts each link once', async () => {
  const plane = createControlPlane({ rounds: 3 });
  const events = [];
  const store = new AccountStore({ dbPath: ':memory:' });
  store.importRecords([{
    brand: 'leiting',
    account: 'fixture-account-dual',
    password: 'fixture-password',
    official_site: 'https://www.68123836.com',
    expires_at: '',
    status: 'active',
    note: ''
  }]);
  const memo = createFingerprintMemo(null, 'lt');
  memo.set({
    apk_url: 'https://apk.example/lt.apk',
    key_candidates: [FIXTURE_KEY],
    package_name: 'com.leiting.lt',
    version_name: '3.17940.98243',
    cert_sha1: '0390D4D33CB1C0E52DEC94D26726249AF384D553',
    seed_domains: ['https://seed.example:20000'],
    protocol: 'v7',
    core_version: '5.12.1',
    lite_version: '5.29.4'
  });

  const result = await fetchCredentialSourceLinks(
    {
      source_name: 'leiting',
      source: {
        mode: 'credential',
        official_site: 'https://www.68123836.com',
        platforms: ['android', 'ios'],
        max_iterations: 3,
        min_iterations: 3,
        plateau_limit: 1,
        key: FIXTURE_KEY
      }
    },
    {
      accountStore: store,
      fetchImpl: plane.fetchImpl,
      memo,
      eventCallback: (type, payload) => events.push({ type, ...payload })
    }
  );
  store.close();

  const iterations = events.filter((event) => event.type === 'extract_iteration');
  // Each channel reports its own round against the shared running totals, so a
  // round can appear twice; what matters is that the totals never double-count.
  assert.equal(iterations.length, 6, 'one event per platform per round');
  for (let index = 1; index < iterations.length; index += 1) {
    assert.ok(iterations[index].total_links >= iterations[index - 1].total_links);
    assert.ok(iterations[index].deduped_links >= iterations[index - 1].deduped_links);
  }
  // Both channels served the same nodes, so the union is the per-channel count,
  // never the sum of both.
  const peak = Math.max(...iterations.map((event) => event.total_links));
  const last = iterations.at(-1);
  assert.equal(peak, result.links.length);
  assert.equal(last.total_links, result.links.length);
  assert.equal(last.deduped_links, result.links.length);

  const completed = events.find((event) => event.type === 'extract_source_completed');
  assert.equal(completed.raw_links, result.links.length);
  assert.doesNotMatch(JSON.stringify(iterations), /vmess:\/\//);
});

test('a round that adds nothing still reports the running total', async () => {
  const plane = createControlPlane({ rounds: 2 });
  const events = [];
  const store = new AccountStore({ dbPath: ':memory:' });
  store.importRecords([{
    brand: 'leiting',
    account: 'fixture-account-2',
    password: 'fixture-password',
    official_site: 'https://www.68123836.com',
    expires_at: '',
    status: 'active',
    note: ''
  }]);
  const memo = createFingerprintMemo(null, 'lt');
  memo.set({
    apk_url: 'https://apk.example/lt.apk',
    key_candidates: [FIXTURE_KEY],
    package_name: 'com.leiting.lt',
    version_name: '3.17940.98243',
    cert_sha1: '0390D4D33CB1C0E52DEC94D26726249AF384D553',
    seed_domains: ['https://seed.example:20000'],
    protocol: 'v7',
    core_version: '5.12.1',
    lite_version: '5.29.4'
  });

  const result = await fetchCredentialSourceLinks(
    {
      source_name: 'leiting',
      source: {
        mode: 'credential',
        official_site: 'https://www.68123836.com',
        platforms: ['android'],
        max_iterations: 4,
        min_iterations: 4,
        plateau_limit: 9,
        key: FIXTURE_KEY
      }
    },
    {
      accountStore: store,
      fetchImpl: plane.fetchImpl,
      memo,
      eventCallback: (type, payload) => events.push({ type, ...payload })
    }
  );
  store.close();

  const iterations = events.filter((event) => event.type === 'extract_iteration');
  // Four requested rounds, but the fixture only has two distinct addresses, so
  // rounds 3 and 4 repeat round 2. They must still be reported.
  assert.equal(iterations.length, 4);
  const plateau = iterations.slice(2);
  for (const event of plateau) {
    assert.equal(event.new_items, 0);
    assert.equal(event.total_links, result.links.length);
  }
  assert.equal(iterations[0].total_links < iterations[1].total_links, true);
});

test('an invalid downloaded APK reports analysis failure instead of leaving it running', async (t) => {
  const store = new AccountStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const events = [];
  await fetchCredentialSourceLinks({ source_name: 'leiting', source: {
    mode: 'credential', official_site: 'https://example.test', account: 'fixture', password: 'fixture', platforms: ['android']
  } }, {
    accountStore: store, loadApk: async () => Buffer.from('invalid APK'),
    fetchImpl: async () => { throw new Error('network must not be used'); },
    eventCallback: (type, payload) => events.push({ type, ...payload })
  });
  const analysis = events.filter((event) => event.type === 'extract_substage' && event.substage === 'apk_analysis');
  assert.deepEqual(analysis.map((event) => event.status), ['running', 'failed']);
});
