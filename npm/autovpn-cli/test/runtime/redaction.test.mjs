import assert from 'node:assert/strict';
import test from 'node:test';

import { redactText } from '../../dist/runtime/redaction.js';

test('redactText covers query params and vmess links', () => {
  const redacted = redactText('url=https://example.test?a=1&token=SECRET&serect_key=QUERY vmess://abcdef');

  assert.match(redacted, /token=<redacted>/);
  assert.match(redacted, /serect_key=<redacted>/);
  assert.match(redacted, /vmess:\/\/<redacted>/);
  assert.doesNotMatch(redacted, /SECRET|QUERY|vmess:\/\/abcdef/);
});

test('redactText covers colon JSON and TOML-shaped secret fields', () => {
  const raw = [
    '"cloudflare_api_token":"CF_TOKEN"',
    'api_token: PLAIN_TOKEN',
    'subscription_url = "https://sub.example/path?token=SUB_TOKEN"',
    'verify_subscription_url: https://verify.example/path',
    'secret_query = QUERY_VALUE',
    'Authorization: Bearer BEARER_TOKEN'
  ].join('\n');

  const redacted = redactText(raw);

  assert.match(redacted, /"cloudflare_api_token":"<redacted>"/);
  assert.match(redacted, /api_token: <redacted>/);
  assert.match(redacted, /subscription_url = "<redacted>"/);
  assert.match(redacted, /verify_subscription_url: <redacted>/);
  assert.match(redacted, /secret_query = <redacted>/);
  assert.match(redacted, /Bearer <redacted>/);
  assert.doesNotMatch(redacted, /CF_TOKEN|PLAIN_TOKEN|SUB_TOKEN|verify\.example|QUERY_VALUE|BEARER_TOKEN/);
});
