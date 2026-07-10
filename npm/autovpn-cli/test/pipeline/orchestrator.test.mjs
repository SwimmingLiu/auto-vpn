import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resumeNodePipeline, retryNodePipelineStage, runNodePipeline } from '../../dist/pipeline/orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'npm', 'autovpn-cli', 'test', 'fixtures', 'node-migration', 'pipeline', 'orchestrator');

function vmessLink(name, address) {
  return `vmess://${Buffer.from(JSON.stringify({
    v: 2,
    ps: name,
    add: address,
    port: '443',
    id: '11111111-1111-1111-1111-111111111111',
    aid: '0',
    scy: 'auto',
    net: 'ws',
    type: 'dtls',
    host: address,
    path: '/',
    tls: 'tls',
    sni: address
  }), 'utf8').toString('base64url')}`;
}

function vmessName(link) {
  return JSON.parse(Buffer.from(link.replace(/^vmess:\/\//, ''), 'base64url').toString('utf8')).ps;
}

function streamingBody(byteLength) {
  let sent = false;
  return {
    getReader: () => ({
      read: async () => {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: new Uint8Array(byteLength) };
      },
      cancel: async () => {},
      releaseLock: () => {}
    })
  };
}

async function makeProject() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'autovpn-node-run-'));
  await mkdir(path.join(projectRoot, 'templates'), { recursive: true });
  await mkdir(path.join(projectRoot, 'state'), { recursive: true });
  await writeFile(path.join(projectRoot, 'pyproject.toml'), '[project]\nname = "fixture"\n', 'utf8');
  await writeFile(
    path.join(projectRoot, 'state', 'profile.toml'),
    (await readFile(path.join(fixtureDir, 'profile.toml'), 'utf8')).replace('[worker_build]', 'min_final_links = 0\n\n[worker_build]'),
    'utf8'
  );
  await writeFile(path.join(projectRoot, 'templates', 'vmess_node.js'), await readFile(path.join(fixtureDir, 'template.js'), 'utf8'), 'utf8');
  return projectRoot;
}

async function setDeployMinFinalLinks(projectRoot, value) {
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  await writeFile(profilePath, (await readFile(profilePath, 'utf8')).replace(/min_final_links = .+/, `min_final_links = ${value}`), 'utf8');
}

test('runNodePipeline emits compatible events and writes non-deploy artifacts', async () => {
  const projectRoot = await makeProject();
  const events = [];
  const firstLink = vmessLink('first', 'one.example');
  const duplicateFirstLink = vmessLink('duplicate-first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, firstLink, secondLink] }),
      speedtest: async (links) => links.map((link, index) => ({ link, reachable: true, average_download_mb_s: index === 0 ? 3 : 2, latency_ms: 20 + index, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: { custom: { provider: 'custom', passed: true, reason: 'ok', status_code: 200, final_url: 'https://custom.example/', matched_phrase: '' } } })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { main_module: '_worker.js', modules: [] } })
    }
  });

  assert.equal(result.run_status, 'success');
  assert.equal(result.counts.raw_links, 3);
  assert.equal(result.counts.deduped_links, 2);
  assert.equal(result.counts.speedtest_links, 2);
  assert.equal(result.counts.availability_links, 2);
  assert.equal(result.counts.final_links, 2);
  assert.deepEqual(events.map((event) => event.type).filter((type) => type === 'summary'), ['summary']);

  const artifactDir = result.artifact_dir;
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_raw.txt'), 'utf8')).trim().split(/\n/).length, 3);
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_deduped.txt'), 'utf8')).trim().split(/\n/).length, 2);
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_speedtest.txt'), 'utf8')).trim().split(/\n/).length, 2);
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_availability.txt'), 'utf8')).trim().split(/\n/).length, 2);
  const decoratedNames = (await readFile(path.join(artifactDir, 'vpn_node_emoji.txt'), 'utf8')).trim().split(/\n/).map(vmessName);
  assert.deepEqual(decoratedNames, ['\u{1F1FA}\u{1F1F8} US first', '\u{1F1FA}\u{1F1F8} US second']);
  assert.equal(JSON.parse(await readFile(path.join(artifactDir, 'pipeline_report.json'), 'utf8')).run_status, 'success');
});

test('runNodePipeline fails availability before postprocess when speed-qualified links are unavailable', async () => {
  const projectRoot = await makeProject();
  const events = [];
  const firstLink = vmessLink('first', 'one.example');
  let postprocessReached = false;

  await assert.rejects(() => runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtestProbe: async (links) => links.map((link) => ({ link, reachable: true, latency_ms: 20, error: '' })),
      speedtestLink: async (link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' }),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: false, provider_results: {} })),
      countryLookup: () => {
        postprocessReached = true;
        return 'US';
      },
      obfuscate: async () => {
        postprocessReached = true;
        throw new Error('obfuscate must not run');
      },
      deploy: async () => {
        postprocessReached = true;
        throw new Error('deploy must not run');
      }
    }
  }), /No links passed availability/);

  const artifactDir = events.find((event) => event.type === 'run_started').artifact_dir;
  const report = JSON.parse(await readFile(path.join(artifactDir, 'pipeline_report.json'), 'utf8'));
  assert.equal(postprocessReached, false);
  assert.equal(report.stage_status.availability, 'failed');
  assert.equal(report.stage_status.postprocess, 'pending');
  assert.equal(report.run_status, 'failed');
  assert.equal(report.error, 'Error: No links passed availability');
  assert.deepEqual(events.slice(-2).map((event) => event.type), ['summary', 'run_failed']);
  assert.equal(events.at(-1).error, 'Error: No links passed availability');
});

test('runNodePipeline renders with the npm template when the project has no template', async () => {
  const projectRoot = await makeProject();
  await rm(path.join(projectRoot, 'templates', 'vmess_node.js'));
  const firstLink = vmessLink('first', 'one.example');

  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });

  assert.equal(result.run_status, 'success');
  assert.equal(result.stage_status.render, 'success');
});

test('runNodePipeline blocks deploy when final node count is below the configured minimum', async () => {
  const projectRoot = await makeProject();
  await setDeployMinFinalLinks(projectRoot, 10);
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');

  await assert.rejects(() => runNodePipeline({
    projectRoot,
    skipDeploy: false,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, secondLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { main_module: '_worker.js', modules: [] } }),
      deploy: async () => {
        throw new Error('deploy must not run below minimum final links');
      }
    }
  }), /final node count 2 is below deploy minimum 10/);
});

test('runNodePipeline globally probes and ranks streamed links before bounded downloads', async () => {
  const projectRoot = await makeProject();
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  await writeFile(profilePath, [
    (await readFile(profilePath, 'utf8')).replace('max_download_candidates = 0', 'max_download_candidates = 2'),
    '',
    '[sources.slow_fixture]',
    'url = "https://fixture.example/slow"',
    'key = "abcdabcdabcdabcd"',
    'enabled = true',
    'max_iterations = 1',
    'min_iterations = 0',
    'plateau_limit = 1',
    'failure_limit = 1',
    ''
  ].join('\n'), 'utf8');

  const firstLink = vmessLink('first', 'one.example');
  const duplicateFirstLink = vmessLink('duplicate-first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const thirdLink = vmessLink('third', 'three.example');
  const probed = [];
  const downloaded = [];
  const availabilityCalls = [];
  const events = [];

  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: profilePath
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async ({ source_name }, stream) => {
        if (source_name === 'fixture') {
          await stream?.onLinks?.([firstLink, duplicateFirstLink]);
          return { source_name, requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, duplicateFirstLink] };
        }
        await stream?.onLinks?.([secondLink, thirdLink]);
        return { source_name, requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [secondLink, thirdLink] };
      },
      speedtest: async () => {
        throw new Error('batch speedtest must not run when streaming is available');
      },
      speedtestProbe: async (links) => {
        probed.push(...links);
        return links.map((link) => ({
          link,
          reachable: true,
          latency_ms: link === firstLink ? 30 : link === secondLink ? 10 : 20,
          error: ''
        }));
      },
      speedtestLink: async (link) => {
        downloaded.push(link);
        return link === thirdLink
          ? { link, reachable: false, average_download_mb_s: 0, latency_ms: 0, error: 'all downloads failed' }
          : { link, reachable: true, average_download_mb_s: 3, latency_ms: 0, error: '' };
      },
      availability: async (results) => {
        availabilityCalls.push(...results.map((result) => result.link));
        return results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} }));
      },
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { main_module: '_worker.js', modules: [] } })
    }
  });

  assert.equal(result.run_status, 'success');
  assert.deepEqual(probed.map(vmessName), ['first', 'second', 'third']);
  assert.deepEqual(downloaded.map(vmessName), ['second', 'third']);
  assert.deepEqual(availabilityCalls.map(vmessName), ['second']);
  assert.equal(downloaded.includes(firstLink), false);
  const selected = events.find((event) => event.type === 'speedtest_selected');
  assert.deepEqual({ reachable_count: selected.reachable_count, candidate_count: selected.candidate_count }, {
    reachable_count: 3,
    candidate_count: 2
  });
  assert.equal(events.filter((event) => event.type === 'speedtest_probe_result').length, 3);
});

test('runNodePipeline keeps unlimited candidates associated across events and artifacts', async () => {
  const projectRoot = await makeProject();
  const links = [
    vmessLink('first', 'one.example'),
    vmessLink('second', 'two.example'),
    vmessLink('third', 'three.example')
  ];
  const events = [];
  const result = await runNodePipeline({ projectRoot, skipDeploy: true, skipVerify: true, output: 'jsonl' }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links }),
      speedtestProbe: async (input) => input.map((link, index) => ({ link, reachable: true, latency_ms: [30, 10, 20][index], error: '' })),
      speedtestLink: async (link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 0, error: '' }),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });

  const ranked = [links[1], links[2], links[0]];
  const selected = events.find((event) => event.type === 'speedtest_selected');
  const resultEvents = events.filter((event) => event.type === 'speedtest_result');
  const report = JSON.parse(await readFile(path.join(result.artifact_dir, 'vpn_node_speedtest_report.json'), 'utf8'));
  assert.equal(selected.candidate_count, 3);
  assert.deepEqual(resultEvents.map((event) => event.link), ranked);
  assert.deepEqual(report.map((entry) => entry.link), ranked);
  assert.deepEqual((await readFile(path.join(result.artifact_dir, 'vpn_node_speedtest.txt'), 'utf8')).trim().split(/\n/), ranked);
  assert.equal(events.at(-1).type, 'summary');
  assert.equal(events.some((event) => event.type === 'run_failed'), false);
});

test('runNodePipeline drains sibling speedtest workers before terminal failure events', async () => {
  const projectRoot = await makeProject();
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  await writeFile(profilePath, (await readFile(profilePath, 'utf8')).replace('concurrency = 1', 'concurrency = 2'), 'utf8');
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const events = [];
  let delayedResourceClosed = false;

  await assert.rejects(() => runNodePipeline({ projectRoot, skipDeploy: true, skipVerify: true, output: 'jsonl' }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: profilePath
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, secondLink] }),
      speedtestProbe: async (links) => links.map((link, index) => ({ link, reachable: true, latency_ms: 10 + index, error: '' })),
      speedtestLink: async (link) => {
        if (link === firstLink) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error('first candidate failed');
        }
        try {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { link, reachable: true, average_download_mb_s: 3, latency_ms: 0, error: '' };
        } finally {
          delayedResourceClosed = true;
        }
      }
    }
  }), /first candidate failed/);

  assert.equal(delayedResourceClosed, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(events.at(-1).type, 'run_failed');
});

test('runNodePipeline forwards native speedtest progress events to the job log', async () => {
  const projectRoot = await makeProject();
  const events = [];
  const firstLink = vmessLink('first', 'one.example');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  await writeFile(
    profilePath,
    (await readFile(profilePath, 'utf8')).replace('min_download_mb_s = 1', 'min_download_mb_s = 0.001'),
    'utf8'
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://www.gstatic.com/generate_204') {
      return { ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (String(url) === 'https://speed.example/10mb') {
      return { ok: true, status: 200, body: streamingBody(5_000_000) };
    }
    throw new Error(`unexpected fetch URL ${url}`);
  };

  try {
    await runNodePipeline({
      projectRoot,
      skipDeploy: true,
      skipVerify: true,
      output: 'jsonl'
    }, {
      env: {
        VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
        VPN_AUTOMATION_PROFILE_PATH: profilePath,
        AUTOVPN_SPEEDTEST_RUNTIME: 'direct'
      },
      now: () => new Date('2026-06-29T01:02:03Z'),
      emit: (event) => events.push(event),
      stages: {
        extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
        availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
        countryLookup: () => 'US',
        obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(events.some((event) => event.type === 'speedtest_runtime' && event.runtime_core === 'direct'));
  assert.ok(events.some((event) => event.type === 'log' && event.message.includes('runtime_core=direct')));
  assert.ok(events.some((event) => event.type === 'speedtest_result' && event.link === firstLink));
});

test('runNodePipeline starts availability only after selected speedtests finish', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  let selectedSpeedtestsFinished = 0;
  let availabilityObservedCompleted = 0;

  await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({
        source_name: 'fixture',
        requested_iterations: 1,
        successful_iterations: 1,
        failed_iterations: 0,
        links: [firstLink, secondLink]
      }),
      speedtestProbe: async (links) => links.map((link, index) => ({ link, reachable: true, latency_ms: 10 + index, error: '' })),
      speedtestLink: async (link) => {
        await new Promise((resolve) => setTimeout(resolve, link === firstLink ? 5 : 10));
        selectedSpeedtestsFinished += 1;
        return { link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' };
      },
      availability: async (results) => {
        availabilityObservedCompleted = selectedSpeedtestsFinished;
        return results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} }));
      },
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });

  assert.equal(selectedSpeedtestsFinished, 2);
  assert.equal(availabilityObservedCompleted, 2);
});

test('runNodePipeline fails fast when no links pass speedtest', async () => {
  const projectRoot = await makeProject();
  const events = [];
  const firstLink = vmessLink('first', 'one.example');

  await assert.rejects(() => runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async () => [
        { link: firstLink, reachable: false, average_download_mb_s: 0, latency_ms: 0, error: 'timeout' }
      ],
      availability: async () => {
        throw new Error('availability must not run');
      },
      deploy: async () => {
        throw new Error('deploy must not run');
      }
    }
  }), /No links passed speed test/);

  assert.equal(events.at(-2).type, 'summary');
  assert.equal(events.at(-2).run_status, 'failed');
  assert.equal(events.at(-1).type, 'run_failed');
  const report = JSON.parse(await readFile(path.join(events.at(-2).artifact_dir, 'pipeline_report.json'), 'utf8'));
  assert.equal(report.run_status, 'failed');
  assert.equal(report.stage_status.speedtest, 'failed');
  assert.match(report.error, /No links passed speed test/);
});

test('runNodePipeline reports when speedtest links are below the minimum speed threshold', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('slow', 'slow.example');
  const events = [];

  await assert.rejects(() => runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async () => [{ link: firstLink, reachable: true, average_download_mb_s: 0.227, latency_ms: 20, error: '' }],
      availability: async () => {
        throw new Error('availability must not run');
      },
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  }), /No links met minimum speed threshold/);

  const artifactDir = events.find((event) => event.type === 'summary')?.artifact_dir;
  const report = JSON.parse(await readFile(path.join(artifactDir, 'pipeline_report.json'), 'utf8'));
  assert.match(report.error, /minimum speed threshold 1MB\/s/);
});

test('runNodePipeline can execute deploy and verify through explicit stage adapters', async () => {
  const projectRoot = await makeProject();
  const events = [];
  const firstLink = vmessLink('first', 'one.example');
  const deployment = {
    returncode: 0,
    stdout: 'deployed https://sub.example/path?token=SECRET',
    stderr: '',
    attempts: [{ mode: 'direct', returncode: 0 }],
    project_name: 'sub-nodes',
    pages_project_url: 'https://sub-nodes.pages.dev',
    subscription_url: 'https://sub.example/path?token=SUBSECRET',
    secret_query: 'serect_key=QUERYSECRET'
  };

  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: false,
    skipVerify: false,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } }),
      deploy: async ({ bundleDir, profile }) => {
        assert.match(bundleDir, /pages_bundle$/);
        assert.equal(profile.deploy.project_name, 'fixture-project');
        return deployment;
      },
      verify: async ({ deployment: deployed }) => {
        assert.equal(deployed.returncode, 0);
        return { pages_domain_ok: true, secret_ok: true, subscription_ok: true };
      }
    }
  });

  assert.equal(result.run_status, 'success');
  assert.equal(result.stage_status.deploy, 'success');
  assert.equal(result.stage_status.verify, 'success');
  assert.equal(result.deployment.stdout, 'deployed https://sub.example/path?token=<redacted>');
  assert.equal(result.deployment.subscription_url, 'set');
  assert.equal(result.deployment.secret_query, 'set');
  assert.equal(events.at(-1).type, 'summary');
  assert.equal(events.at(-1).run_status, 'success');
  assert.equal(events.at(-1).deployment.stdout, 'deployed https://sub.example/path?token=<redacted>');
  assert.equal(events.at(-1).deployment.subscription_url, 'set');
  assert.doesNotMatch(JSON.stringify(events.at(-1)), /SECRET|SUBSECRET|QUERYSECRET/);
});

test('runNodePipeline emits effective skip_verify when deploy is skipped', async () => {
  const projectRoot = await makeProject();
  const events = [];
  const firstLink = vmessLink('first', 'one.example');

  await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: false,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });

  assert.equal(events[0].type, 'run_started');
  assert.equal(events[0].skip_deploy, true);
  assert.equal(events[0].skip_verify, true);
});

test('runNodePipeline writes in-progress reports as running until terminal summary', async () => {
  const projectRoot = await makeProject();
  let checkedReport = false;
  const firstLink = vmessLink('first', 'one.example');

  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => {
        const artifactsRoot = path.join(projectRoot, '.runtime', 'artifacts');
        const [artifactName] = await import('node:fs/promises').then(({ readdir }) => readdir(artifactsRoot));
        const report = JSON.parse(await readFile(path.join(artifactsRoot, artifactName, 'pipeline_report.json'), 'utf8'));
        assert.equal(report.run_status, 'running');
        assert.equal(report.stage_status.extract, 'running');
        checkedReport = true;
        return { source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] };
      },
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });

  assert.equal(checkedReport, true);
  assert.equal(result.run_status, 'success');
  assert.equal(JSON.parse(await readFile(path.join(result.artifact_dir, 'pipeline_report.json'), 'utf8')).run_status, 'success');
});

test('runNodePipeline loads project .env before resolving profile and artifacts paths', async () => {
  const projectRoot = await makeProject();
  const artifactsRoot = path.join(projectRoot, 'env-artifacts');
  await writeFile(path.join(projectRoot, '.env'), [
    `VPN_AUTOMATION_PROFILE_PATH=${path.join(projectRoot, 'state', 'profile.toml')}`,
    `VPN_AUTOMATION_ARTIFACTS_ROOT=${artifactsRoot}`,
    ''
  ].join('\n'), 'utf8');

  const firstLink = vmessLink('first', 'one.example');
  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });

  assert.equal(result.run_status, 'success');
  assert.equal(path.dirname(result.artifact_dir), artifactsRoot);
});

test('AUTOVPN_NO_PYTHON disables default runtime Python stage fallback', async () => {
  const projectRoot = await makeProject();
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  await writeFile(profilePath, [
    '[sources]',
    '[sources.empty]',
    'url = "https://fixture.example/source"',
    'key = "abcdabcdabcdabcd"',
    'enabled = true',
    'max_iterations = 0',
    'min_iterations = 0',
    'plateau_limit = 1',
    'failure_limit = 1',
    'max_runtime_seconds = 0',
    '',
    '[speed_test]',
    'min_download_mb_s = 1',
    'timeout_seconds = 20',
    'concurrency = 1',
    '',
    '[deploy]',
    'project_name = "fixture-project"',
    'subscription_url = "https://sub.example.invalid/?serect_key=fixture"',
    'pages_project_url = "https://fixture-project.pages.dev"',
    'secret_query = "serect_key=fixture"',
    '',
    '[worker_build]',
    'entry_filename = "_worker.js"',
    'bundle_subdir = "pages_bundle"',
    'manifest_filename = "manifest.json"',
    'emit_sidecar_modules = false',
    ''
  ].join('\n'), 'utf8');

  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      AUTOVPN_NO_PYTHON: '1',
      AUTOVPN_NO_INSTALL: '1',
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: profilePath
    },
    now: () => new Date('2026-06-29T01:02:03Z')
  });

  assert.equal(result.run_status, 'success');
  assert.equal(result.counts.raw_links, 0);
});

test('runNodePipeline fails extract when configured sources produce no links', async () => {
  const projectRoot = await makeProject();
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  await writeFile(profilePath, [
    '[sources]',
    '[sources.empty]',
    'url = "https://fixture.example/source"',
    'key = "abcdabcdabcdabcd"',
    'enabled = true',
    'max_iterations = 1',
    'min_iterations = 0',
    'plateau_limit = 1',
    'failure_limit = 1',
    'max_runtime_seconds = 0',
    '',
    '[speed_test]',
    'min_download_mb_s = 1',
    'timeout_seconds = 20',
    'concurrency = 1',
    '',
    '[deploy]',
    'project_name = "fixture-project"',
    'subscription_url = "https://sub.example.invalid/?serect_key=fixture"',
    'pages_project_url = "https://fixture-project.pages.dev"',
    'secret_query = "serect_key=fixture"',
    '',
    '[worker_build]',
    'entry_filename = "_worker.js"',
    'bundle_subdir = "pages_bundle"',
    'manifest_filename = "manifest.json"',
    'emit_sidecar_modules = false',
    ''
  ].join('\n'), 'utf8');
  const events = [];

  await assert.rejects(() => runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: profilePath
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'empty', requested_iterations: 1, successful_iterations: 0, failed_iterations: 1, links: [] })
    }
  }), /No links extracted/);

  assert.equal(events.at(-2).type, 'summary');
  assert.equal(events.at(-2).run_status, 'failed');
  assert.equal(events.at(-2).stage_status.extract, 'failed');
  assert.equal(events.at(-1).type, 'run_failed');
});

test('runNodePipeline extracts enabled sources concurrently while preserving profile order', async () => {
  const projectRoot = await makeProject();
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  await writeFile(profilePath, [
    '[sources]',
    '[sources.leiting]',
    'url = "https://fixture.example/leiting"',
    'key = "abcdabcdabcdabcd"',
    'enabled = true',
    'max_iterations = 1',
    'min_iterations = 0',
    'plateau_limit = 1',
    'failure_limit = 1',
    'max_runtime_seconds = 0',
    '',
    '[sources.heidong]',
    'url = "https://fixture.example/heidong"',
    'key = "abcdabcdabcdabcd"',
    'enabled = true',
    'max_iterations = 1',
    'min_iterations = 0',
    'plateau_limit = 1',
    'failure_limit = 1',
    'max_runtime_seconds = 0',
    '',
    '[speed_test]',
    'min_download_mb_s = 1',
    'timeout_seconds = 20',
    'concurrency = 1',
    '',
    '[deploy]',
    'project_name = "fixture-project"',
    'subscription_url = "https://sub.example.invalid/?serect_key=fixture"',
    'pages_project_url = "https://fixture-project.pages.dev"',
    'secret_query = "serect_key=fixture"',
    '',
    '[worker_build]',
    'entry_filename = "_worker.js"',
    'bundle_subdir = "pages_bundle"',
    'manifest_filename = "manifest.json"',
    'emit_sidecar_modules = false',
    ''
  ].join('\n'), 'utf8');

  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  let activeExtracts = 0;
  let overlapSeen = false;
  const release = {};
  const started = {};
  const startedPromises = ['leiting', 'heidong'].map((sourceName) => new Promise((resolve) => {
    started[sourceName] = resolve;
  }));

  const runPromise = runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: profilePath
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async ({ source_name: sourceName }) => {
        activeExtracts += 1;
        overlapSeen = overlapSeen || activeExtracts >= 2;
        started[sourceName]?.();
        await new Promise((resolve) => {
          release[sourceName] = resolve;
        });
        activeExtracts -= 1;
        return {
          source_name: sourceName,
          requested_iterations: 1,
          successful_iterations: 1,
          failed_iterations: 0,
          links: sourceName === 'leiting' ? [firstLink] : [secondLink]
        };
      },
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });

  await Promise.all(startedPromises);
  release.heidong();
  release.leiting();
  const result = await runPromise;

  assert.equal(overlapSeen, true);
  assert.deepEqual(
    (await readFile(path.join(result.artifact_dir, 'vpn_node_raw.txt'), 'utf8')).trim().split(/\n/),
    [firstLink, secondLink]
  );
});

test('AUTOVPN_NO_PYTHON offline run succeeds when no sources have URL and key configured', async () => {
  const projectRoot = await makeProject();
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  await writeFile(profilePath, [
    '[sources]',
    '[sources.missing_url]',
    'url = ""',
    'key = "abcdabcdabcdabcd"',
    'enabled = true',
    'max_iterations = 1',
    'min_iterations = 0',
    'plateau_limit = 1',
    'failure_limit = 1',
    'max_runtime_seconds = 0',
    '',
    '[speed_test]',
    'min_download_mb_s = 1',
    'timeout_seconds = 20',
    'concurrency = 1',
    'urls = ["https://speed.example/10mb"]',
    'probe_url = "https://www.gstatic.com/generate_204"',
    'max_download_bytes = 1000',
    'startup_wait_seconds = 1',
    'max_download_candidates = 0',
    '',
    '[deploy]',
    'project_name = "fixture-project"',
    'subscription_url = "https://sub.example.invalid/?serect_key=fixture"',
    'pages_project_url = "https://fixture-project.pages.dev"',
    'secret_query = "serect_key=fixture"',
    '',
    '[worker_build]',
    'entry_filename = "_worker.js"',
    'bundle_subdir = "pages_bundle"',
    'manifest_filename = "manifest.json"',
    'emit_sidecar_modules = false',
    ''
  ].join('\n'), 'utf8');

  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      AUTOVPN_NO_PYTHON: '1',
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: profilePath
    },
    now: () => new Date('2026-06-29T01:02:03Z')
  });

  assert.equal(result.run_status, 'success');
  assert.equal(result.counts.raw_links, 0);
  assert.equal(result.counts.availability_links, 0);
  assert.equal(await readFile(path.join(result.artifact_dir, 'vpn_node_raw.txt'), 'utf8'), '');
});

test('runNodePipeline marks the active stage failed and writes a summary on errors', async () => {
  const projectRoot = await makeProject();
  const events = [];
  const firstLink = vmessLink('first', 'one.example');

  await assert.rejects(() => runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async () => {
        throw new Error(`speedtest fixture boom token=SECRET serect_key=QUERY ${firstLink}`);
      }
    }
  }), /speedtest fixture boom/);

  const artifactDir = events.find((event) => event.type === 'run_started').artifact_dir;
  const report = JSON.parse(await readFile(path.join(artifactDir, 'pipeline_report.json'), 'utf8'));
  assert.equal(report.run_status, 'failed');
  assert.equal(report.stage_status.speedtest, 'failed');
  assert.match(report.error, /speedtest fixture boom/);
  assert.match(report.error, /token=<redacted>/);
  assert.match(report.error, /serect_key=<redacted>/);
  assert.match(report.error, /vmess:\/\/<redacted>/);
  assert.equal(events.at(-2).type, 'summary');
  assert.equal(events.at(-2).run_status, 'failed');
  assert.equal(events.at(-1).type, 'run_failed');
  assert.equal(events.at(-1).error, report.error);
});

test('runNodePipeline writes event and human logs for Node runs', async () => {
  const projectRoot = await makeProject();
  const eventLog = path.join(projectRoot, 'logs', 'events.jsonl');
  const humanLog = path.join(projectRoot, 'logs', 'human.log');
  const firstLink = vmessLink('first', 'one.example');
  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl',
    eventLog,
    humanLog
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });

  assert.equal(result.run_status, 'success');
  const eventLines = (await readFile(eventLog, 'utf8')).trim().split(/\n/).map((line) => JSON.parse(line));
  assert.equal(eventLines[0].type, 'run_started');
  assert.equal(eventLines.at(-1).type, 'summary');
  assert.match(await readFile(humanLog, 'utf8'), /\[summary\] run_status=success/);
});

test('retryNodePipelineStage retries render from an existing artifact into a fresh artifact', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  const events = [];
  const eventLog = path.join(projectRoot, 'logs', 'retry-events.jsonl');
  const humanLog = path.join(projectRoot, 'logs', 'retry-human.log');
  await writeFile(path.join(projectRoot, 'templates', 'vmess_node.js'), 'export default __MAIN_DATA__;\n// retry render\n', 'utf8');

  const retry = await retryNodePipelineStage({
    projectRoot,
    artifactDir: source.artifact_dir,
    stage: 'render',
    output: 'jsonl',
    eventLog,
    humanLog
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:04Z'),
    emit: (event) => events.push(event),
    stages: {
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } }),
      deploy: async ({ bundleDir }) => ({ returncode: 0, stdout: `deployed ${bundleDir}`, stderr: '', attempts: [{ mode: 'direct', returncode: 0 }] }),
      verify: async () => ({ pages_domain_ok: true, secret_ok: true, subscription_ok: true })
    }
  });

  assert.equal(retry.run_status, 'success');
  assert.notEqual(retry.artifact_dir, source.artifact_dir);
  assert.deepEqual(retry.retry_context, {
    source_artifact_dir: source.artifact_dir,
    source_artifact_name: path.basename(source.artifact_dir),
    start_stage: 'render'
  });
  assert.equal(retry.stage_status.doctor, 'success');
  assert.equal(retry.stage_status.postprocess, 'success');
  assert.equal(retry.stage_status.render, 'success');
  assert.equal(retry.stage_status.obfuscate, 'success');
  assert.equal(retry.stage_status.deploy, 'success');
  assert.equal(retry.stage_status.verify, 'success');
  assert.match(await readFile(path.join(retry.artifact_dir, 'vmess_node.js'), 'utf8'), /retry render/);
  assert.equal((await readFile(path.join(retry.artifact_dir, 'vpn_node_emoji.txt'), 'utf8')).trim(), (await readFile(path.join(source.artifact_dir, 'vpn_node_emoji.txt'), 'utf8')).trim());
  assert.equal(events[0].type, 'run_started');
  assert.equal(events[0].retry_stage, 'render');
  assert.equal(events[0].source_artifact_dir, source.artifact_dir);
  assert.equal(events.at(-1).type, 'summary');
  assert.equal(JSON.parse(await readFile(path.join(retry.artifact_dir, 'pipeline_report.json'), 'utf8')).retry_context.start_stage, 'render');
  assert.equal((await readFile(eventLog, 'utf8')).trim().split(/\n/).at(-1), JSON.stringify(events.at(-1)));
  assert.match(await readFile(humanLog, 'utf8'), /\[summary\] run_status=success/);
});

test('retryNodePipelineStage passes only speedtest winners into availability when retrying speedtest', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, secondLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  const availabilityInputs = [];

  await retryNodePipelineStage({
    projectRoot,
    artifactDir: source.artifact_dir,
    stage: 'speedtest',
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:04Z'),
    stages: {
      speedtest: async () => [
        { link: firstLink, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' },
        { link: secondLink, reachable: false, average_download_mb_s: 0, latency_ms: 0, error: 'timeout' }
      ],
      availability: async (results) => {
        availabilityInputs.push(results.map((result) => result.link));
        return results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} }));
      },
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } }),
      deploy: async ({ bundleDir }) => ({ returncode: 0, stdout: `deployed ${bundleDir}`, stderr: '', attempts: [] }),
      verify: async () => ({ pages_domain_ok: true, secret_ok: true, subscription_ok: true })
    }
  });

  assert.deepEqual(availabilityInputs, [[firstLink]]);
});

test('retryNodePipelineStage emits one final probe event per retried node', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath,
    AUTOVPN_SPEEDTEST_RUNTIME: 'direct'
  };
  await writeFile(profilePath, (await readFile(profilePath, 'utf8')).replace('min_download_mb_s = 1', 'min_download_mb_s = 0.5'), 'utf8');
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, secondLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  const events = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('generate_204')
    ? { ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) }
    : { ok: true, status: 200, body: streamingBody(5_000_000) };
  try {
    await retryNodePipelineStage({
      projectRoot,
      artifactDir: source.artifact_dir,
      stage: 'speedtest',
      output: 'jsonl'
    }, {
      env,
      now: () => new Date('2026-06-29T01:02:04Z'),
      emit: (event) => events.push(event),
      stages: {
        availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
        countryLookup: () => 'US',
        obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } }),
        deploy: async () => ({ returncode: 0, stdout: '', stderr: '', attempts: [] }),
        verify: async () => ({ pages_domain_ok: true, secret_ok: true, subscription_ok: true })
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const probeEvents = events.filter((event) => event.type === 'speedtest_probe_result');
  assert.equal(probeEvents.length, 2);
  assert.deepEqual(probeEvents.map((event) => event.link), [firstLink, secondLink]);
});

test('retryNodePipelineStage postprocesses only availability winners', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, secondLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  const postprocessInputs = [];

  const retry = await retryNodePipelineStage({
    projectRoot,
    artifactDir: source.artifact_dir,
    stage: 'availability',
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:04Z'),
    stages: {
      availability: async (results) => results.map((speedResult, index) => ({ ...speedResult, all_passed: index === 0, provider_results: {} })),
      countryLookup: (link) => {
        postprocessInputs.push(link);
        return 'US';
      },
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } }),
      deploy: async () => ({ returncode: 0, stdout: '', stderr: '', attempts: [] }),
      verify: async () => ({ pages_domain_ok: true, secret_ok: true, subscription_ok: true })
    }
  });

  assert.deepEqual(postprocessInputs, [firstLink]);
  assert.equal(retry.counts.availability_links, 1);
  assert.equal(retry.counts.final_links, 1);
});

test('retryNodePipelineStage rejects and emits run_failed when retry stage has no winners', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  const events = [];

  await assert.rejects(() => retryNodePipelineStage({
    projectRoot,
    artifactDir: source.artifact_dir,
    stage: 'speedtest',
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:04Z'),
    emit: (event) => events.push(event),
    stages: {
      speedtest: async () => [
        { link: firstLink, reachable: false, average_download_mb_s: 0, latency_ms: 0, error: 'timeout' }
      ]
    }
  }), /No links passed speed test/);

  assert.equal(events.at(-2).type, 'summary');
  assert.equal(events.at(-2).run_status, 'failed');
  assert.equal(events.at(-1).type, 'run_failed');
});

test('retryNodePipelineStage preserves custom bundle subdirectories for deploy retry', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  await writeFile(
    profilePath,
    (await readFile(profilePath, 'utf8')).replace('bundle_subdir = "pages_bundle"', 'bundle_subdir = "custom_bundle"'),
    'utf8'
  );
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  const seenBundleDirs = [];

  const retry = await retryNodePipelineStage({
    projectRoot,
    artifactDir: source.artifact_dir,
    stage: 'deploy',
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:04Z'),
    stages: {
      deploy: async ({ bundleDir }) => {
        seenBundleDirs.push(bundleDir);
        return { returncode: 0, stdout: `deployed ${bundleDir}`, stderr: '', attempts: [] };
      },
      verify: async () => ({ pages_domain_ok: true, secret_ok: true, subscription_ok: true })
    }
  });

  assert.equal(retry.run_status, 'success');
  assert.deepEqual(seenBundleDirs.map((bundleDir) => path.basename(bundleDir)), ['custom_bundle']);
  assert.equal(await readFile(path.join(retry.artifact_dir, 'custom_bundle', '_worker.js'), 'utf8'), await readFile(path.join(source.artifact_dir, 'custom_bundle', '_worker.js'), 'utf8'));
});

test('resumeNodePipeline continues pipeline sessions in the original artifact', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, secondLink] }),
      speedtest: async (links) => links.map((link, index) => ({ link, reachable: true, average_download_mb_s: index === 0 ? 2 : 5, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  const sessionDir = path.join(projectRoot, 'sessions', 'resume-pipeline');
  const eventLog = path.join(sessionDir, 'events.jsonl');
  const humanLog = path.join(sessionDir, 'human.log');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
    artifact_dir: source.artifact_dir,
    event_log: eventLog,
    human_log: humanLog
  }), 'utf8');
  const events = [];

  const resumed = await resumeNodePipeline({
    projectRoot,
    mode: 'pipeline',
    session: sessionDir,
    output: 'jsonl'
  }, {
    env,
    emit: (event) => events.push(event),
    stages: {
      availability: async (results) => {
        assert.deepEqual(results.map((result) => vmessName(result.link)), ['second', 'first']);
        return results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} }));
      },
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } }),
      deploy: async ({ bundleDir }) => ({ returncode: 0, stdout: `deployed ${bundleDir}`, stderr: '', attempts: [{ mode: 'direct', returncode: 0 }] }),
      verify: async () => ({ pages_domain_ok: true, secret_ok: true, subscription_ok: true })
    }
  });

  assert.equal(resumed.artifact_dir, source.artifact_dir);
  assert.equal(resumed.run_status, 'success');
  assert.equal(resumed.stage_status.availability, 'success');
  assert.equal(resumed.stage_status.deploy, 'success');
  assert.equal(resumed.stage_status.verify, 'success');
  assert.equal(events[0].type, 'resume_pipeline_state');
  assert.equal(events[0].speedtest_links, 2);
  assert.equal(events.at(-1).type, 'summary');
  assert.equal(JSON.parse(await readFile(path.join(source.artifact_dir, 'pipeline_report.json'), 'utf8')).run_status, 'success');
  assert.deepEqual((await readFile(path.join(source.artifact_dir, 'vpn_node_emoji.txt'), 'utf8')).trim().split(/\n/).map(vmessName), ['\u{1F1FA}\u{1F1F8} US second', '\u{1F1FA}\u{1F1F8} US first']);
  assert.equal((await readFile(eventLog, 'utf8')).trim().split(/\n/).at(-1), JSON.stringify(events.at(-1)));
  assert.match(await readFile(humanLog, 'utf8'), /\[summary\] run_status=success/);
});

test('resumeNodePipeline emits failed summary when restored speedtest results are empty', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest.txt'), '', 'utf8');
  const sessionDir = path.join(projectRoot, 'sessions', 'empty-speedtest');
  const eventLog = path.join(sessionDir, 'events.jsonl');
  const humanLog = path.join(sessionDir, 'human.log');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
    artifact_dir: source.artifact_dir,
    event_log: eventLog,
    human_log: humanLog
  }), 'utf8');
  const events = [];

  await assert.rejects(() => resumeNodePipeline({
    projectRoot,
    mode: 'pipeline',
    session: sessionDir,
    output: 'jsonl'
  }, {
    env,
    emit: (event) => events.push(event)
  }), /No speedtest results available to continue pipeline/);

  assert.equal(events.at(-2).type, 'summary');
  assert.equal(events.at(-2).run_status, 'failed');
  assert.equal(events.at(-1).type, 'run_failed');
  assert.match(await readFile(humanLog, 'utf8'), /\[summary\] run_status=failed/);
  const report = JSON.parse(await readFile(path.join(source.artifact_dir, 'pipeline_report.json'), 'utf8'));
  assert.equal(report.run_status, 'failed');
  assert.equal(report.stage_status.speedtest, 'failed');
  assert.match(report.error, /No speedtest results available/);
});

test('resumeNodePipeline rejects sessions without an artifact directory', async () => {
  const projectRoot = await makeProject();
  const sessionDir = path.join(projectRoot, 'sessions', 'missing-artifact-dir');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({}), 'utf8');

  await assert.rejects(() => resumeNodePipeline({
    projectRoot,
    mode: 'pipeline',
    session: sessionDir,
    output: 'jsonl'
  }), /session artifact_dir is required/);
});

test('resumeNodePipeline restores Python-compatible speedtest events when report file is absent', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, secondLink] }),
      speedtest: async (links) => links.map((link, index) => ({ link, reachable: true, average_download_mb_s: index === 0 ? 2 : 5, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest_report.json'), '[]', 'utf8');
  const sessionDir = path.join(projectRoot, 'sessions', 'python-events');
  const eventLog = path.join(sessionDir, 'events.jsonl');
  const humanLog = path.join(sessionDir, 'human.log');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(eventLog, [
    JSON.stringify({ type: 'speedtest_result', link: firstLink, reachable: true, average_download_mb_s: 2, latency_ms: 20, error: '' }),
    JSON.stringify({ type: 'speedtest_result', link: secondLink, reachable: true, average_download_mb_s: 5, latency_ms: 20, error: '' })
  ].join('\n'), 'utf8');
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
    artifact_dir: source.artifact_dir,
    event_log: eventLog,
    human_log: humanLog
  }), 'utf8');

  const resumed = await resumeNodePipeline({
    projectRoot,
    mode: 'pipeline',
    session: sessionDir,
    output: 'jsonl'
  }, {
    env,
    stages: {
      availability: async (results) => {
        assert.deepEqual(results.map((result) => vmessName(result.link)), ['second', 'first']);
        return results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} }));
      },
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } }),
      deploy: async ({ bundleDir }) => ({ returncode: 0, stdout: `deployed ${bundleDir}`, stderr: '', attempts: [{ mode: 'direct', returncode: 0 }] }),
      verify: async () => ({ pages_domain_ok: true, secret_ok: true, subscription_ok: true })
    }
  });

  assert.equal(resumed.run_status, 'success');
  assert.equal(resumed.counts.speedtest_links, 2);
});

test('resumeNodePipeline resumes speedtest sessions from partial event logs', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const thirdLink = vmessLink('third', 'three.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, secondLink, thirdLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 1, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest.txt'), '', 'utf8');
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest_report.json'), '[]', 'utf8');
  const sessionDir = path.join(projectRoot, 'sessions', 'resume-speedtest');
  const eventLog = path.join(sessionDir, 'events.jsonl');
  const humanLog = path.join(sessionDir, 'human.log');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(eventLog, [
    JSON.stringify({ type: 'speedtest_probe_result', completed: 1, total: 3, link: firstLink, reachable: true, latency_ms: 80, error: '' }),
    JSON.stringify({ type: 'speedtest_result', completed: 1, total: 3, link: firstLink, reachable: true, average_download_mb_s: 2, latency_ms: 80, error: '' })
  ].join('\n'), 'utf8');
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
    artifact_dir: source.artifact_dir,
    event_log: eventLog,
    human_log: humanLog
  }), 'utf8');
  const events = [];
  const probed = [];
  const tested = [];

  const resumed = await resumeNodePipeline({
    projectRoot,
    mode: 'speedtest',
    session: sessionDir,
    output: 'jsonl'
  }, {
    env,
    emit: (event) => events.push(event),
    stages: {
      speedtestProbe: async (links) => {
        probed.push(...links);
        return links.map((link) => ({ link, reachable: true, latency_ms: link === secondLink ? 30 : 60, error: '' }));
      },
      speedtestLink: async (link) => {
        tested.push(link);
        return { link, reachable: true, average_download_mb_s: link === secondLink ? 4 : 3, latency_ms: link === secondLink ? 30 : 60, error: '' };
      }
    }
  });

  assert.deepEqual(probed.map(vmessName), ['second', 'third']);
  assert.deepEqual(tested.map(vmessName), ['second', 'third']);
  assert.equal(resumed.artifact_dir, source.artifact_dir);
  assert.equal(resumed.run_status, 'success');
  assert.equal(resumed.stage_status.speedtest, 'success');
  assert.equal(resumed.counts.speedtest_links, 3);
  assert.equal(events[0].type, 'speedtest_resume_state');
  assert.equal(events[0].resumed_probe_count, 1);
  assert.equal(events[0].resumed_full_count, 1);
  assert.equal(events.at(-1).type, 'summary');
  assert.deepEqual((await readFile(path.join(source.artifact_dir, 'vpn_node_speedtest.txt'), 'utf8')).trim().split(/\n/).map(vmessName), ['second', 'third', 'first']);
  const report = JSON.parse(await readFile(path.join(source.artifact_dir, 'vpn_node_speedtest_report.json'), 'utf8'));
  assert.deepEqual(report.map((result) => vmessName(result.link)), ['second', 'third', 'first']);
  assert.match(await readFile(humanLog, 'utf8'), /\[summary\] run_status=success/);
});

test('resumeNodePipeline reads speedtest resume state from session log when output log is overridden', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, secondLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 1, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest.txt'), '', 'utf8');
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest_report.json'), '[]', 'utf8');
  const sessionDir = path.join(projectRoot, 'sessions', 'resume-speedtest-override-log');
  const sessionEventLog = path.join(sessionDir, 'events.jsonl');
  const overrideEventLog = path.join(sessionDir, 'override-events.jsonl');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionEventLog, [
    JSON.stringify({ type: 'speedtest_probe_result', completed: 1, total: 2, link: firstLink, reachable: true, latency_ms: 80, error: '' }),
    JSON.stringify({ type: 'speedtest_result', completed: 1, total: 2, link: firstLink, reachable: true, average_download_mb_s: 2, latency_ms: 80, error: '' })
  ].join('\n'), 'utf8');
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
    artifact_dir: source.artifact_dir,
    event_log: sessionEventLog,
    human_log: path.join(sessionDir, 'human.log')
  }), 'utf8');
  const probed = [];
  const tested = [];

  await resumeNodePipeline({
    projectRoot,
    mode: 'speedtest',
    session: sessionDir,
    output: 'jsonl',
    eventLog: overrideEventLog
  }, {
    env,
    stages: {
      speedtestProbe: async (links) => {
        probed.push(...links);
        return links.map((link) => ({ link, reachable: true, latency_ms: 30, error: '' }));
      },
      speedtestLink: async (link) => {
        tested.push(link);
        return { link, reachable: true, average_download_mb_s: 4, latency_ms: 30, error: '' };
      }
    }
  });

  assert.deepEqual(probed.map(vmessName), ['second']);
  assert.deepEqual(tested.map(vmessName), ['second']);
  assert.match(await readFile(overrideEventLog, 'utf8'), /speedtest_resume_state/);
});

test('resumeNodePipeline rejects explicit direct runtime for native speedtest resume without injected stages', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath,
    AUTOVPN_SPEEDTEST_RUNTIME: 'direct'
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 1, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest.txt'), '', 'utf8');
  const sessionDir = path.join(projectRoot, 'sessions', 'resume-speedtest-direct-runtime');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
    artifact_dir: source.artifact_dir,
    event_log: path.join(sessionDir, 'events.jsonl'),
    human_log: path.join(sessionDir, 'human.log')
  }), 'utf8');

  await assert.rejects(() => resumeNodePipeline({
    projectRoot,
    mode: 'speedtest',
    session: sessionDir,
    output: 'jsonl'
  }, {
    env
  }), /Node resume speedtest cannot use AUTOVPN_SPEEDTEST_RUNTIME=direct/);
});

test('resumeNodePipeline rejects partial speedtest stage injection with explicit direct runtime', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath,
    AUTOVPN_SPEEDTEST_RUNTIME: 'direct'
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 1, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest.txt'), '', 'utf8');
  const sessionDir = path.join(projectRoot, 'sessions', 'resume-speedtest-partial-injection');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
    artifact_dir: source.artifact_dir,
    event_log: path.join(sessionDir, 'events.jsonl'),
    human_log: path.join(sessionDir, 'human.log')
  }), 'utf8');

  await assert.rejects(() => resumeNodePipeline({
    projectRoot,
    mode: 'speedtest',
    session: sessionDir,
    output: 'jsonl'
  }, {
    env,
    stages: {
      speedtestProbe: async (links) => links.map((link) => ({ link, reachable: true, latency_ms: 20, error: '' }))
    }
  }), /Node resume speedtest cannot use AUTOVPN_SPEEDTEST_RUNTIME=direct/);
});

test('resumeNodePipeline emits concurrent speedtest results as each link completes', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  await writeFile(profilePath, (await readFile(profilePath, 'utf8')).replace('concurrency = 1', 'concurrency = 2'), 'utf8');
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, secondLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 1, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest.txt'), '', 'utf8');
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest_report.json'), '[]', 'utf8');
  const sessionDir = path.join(projectRoot, 'sessions', 'resume-speedtest-concurrent');
  const eventLog = path.join(sessionDir, 'events.jsonl');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(eventLog, [
    JSON.stringify({ type: 'speedtest_probe_result', completed: 1, total: 2, link: firstLink, reachable: true, latency_ms: 10, error: '' }),
    JSON.stringify({ type: 'speedtest_probe_result', completed: 2, total: 2, link: secondLink, reachable: true, latency_ms: 20, error: '' })
  ].join('\n'), 'utf8');
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
    artifact_dir: source.artifact_dir,
    event_log: eventLog,
    human_log: path.join(sessionDir, 'human.log')
  }), 'utf8');
  const events = [];
  let releaseSlow;
  const slowResultAllowed = new Promise((resolve) => { releaseSlow = resolve; });
  let fastResultReturned;
  const fastResultReturnedPromise = new Promise((resolve) => { fastResultReturned = resolve; });

  const resumePromise = resumeNodePipeline({
    projectRoot,
    mode: 'speedtest',
    session: sessionDir,
    output: 'jsonl'
  }, {
    env,
    emit: (event) => events.push(event),
    stages: {
      speedtestProbe: async () => {
        throw new Error('probe stage should be restored from the resume event log');
      },
      speedtestLink: async (link) => {
        if (link === firstLink) {
          fastResultReturned();
          return { link, reachable: true, average_download_mb_s: 5, latency_ms: 10, error: '' };
        }
        await slowResultAllowed;
        return { link, reachable: true, average_download_mb_s: 4, latency_ms: 20, error: '' };
      }
    }
  });

  await fastResultReturnedPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === 'speedtest_result' && event.link === firstLink));
  assert.equal(events.some((event) => event.type === 'speedtest_result' && event.link === secondLink), false);
  releaseSlow();
  const resumed = await resumePromise;

  assert.equal(resumed.run_status, 'success');
  assert.deepEqual(events.filter((event) => event.type === 'speedtest_result').map((event) => vmessName(event.link)), ['first', 'second']);
});

test('resumeNodePipeline marks speedtest failed when resumed results do not pass threshold', async () => {
  const projectRoot = await makeProject();
  const firstLink = vmessLink('first', 'one.example');
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const profilePath = path.join(projectRoot, 'state', 'profile.toml');
  const env = {
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
    VPN_AUTOMATION_PROFILE_PATH: profilePath
  };
  const source = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env,
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 1, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest.txt'), '', 'utf8');
  await writeFile(path.join(source.artifact_dir, 'vpn_node_speedtest_report.json'), '[]', 'utf8');
  const sessionDir = path.join(projectRoot, 'sessions', 'resume-speedtest-failed');
  const eventLog = path.join(sessionDir, 'events.jsonl');
  const humanLog = path.join(sessionDir, 'human.log');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
    artifact_dir: source.artifact_dir,
    event_log: eventLog,
    human_log: humanLog
  }), 'utf8');
  const events = [];

  await assert.rejects(() => resumeNodePipeline({
    projectRoot,
    mode: 'speedtest',
    session: sessionDir,
    output: 'jsonl'
  }, {
    env,
    emit: (event) => events.push(event),
    stages: {
      speedtestProbe: async (links) => links.map((link) => ({ link, reachable: true, latency_ms: 20, error: '' })),
      speedtestLink: async (link) => ({ link, reachable: true, average_download_mb_s: 0.5, latency_ms: 20, error: '' })
    }
  }), /No links met minimum speed threshold/);

  assert.equal(events.at(-2).type, 'summary');
  assert.equal(events.at(-2).run_status, 'failed');
  assert.equal(events.at(-1).type, 'run_failed');
  const report = JSON.parse(await readFile(path.join(source.artifact_dir, 'pipeline_report.json'), 'utf8'));
  assert.equal(report.run_status, 'failed');
  assert.equal(report.stage_status.speedtest, 'failed');
  assert.match(report.error, /minimum speed threshold 1MB\/s/);
});
