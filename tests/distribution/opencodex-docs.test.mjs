import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildOpenCodexGatewayConfig } from '../helpers/opencodex-fixture.mjs';

const english = await readFile(new URL('../../docs/04-connection.md', import.meta.url), 'utf8');
const korean = await readFile(new URL('../../docs/04-connection_ko.md', import.meta.url), 'utf8');

function documentedConfig(markdown) {
  const section = markdown.slice(markdown.indexOf('OpenCodex'));
  const matches = [...section.matchAll(/```json\s+(\{[\s\S]*?\})\s+```/g)];
  assert.equal(matches.length, 1, 'the OpenCodex section must own exactly one JSON configuration');
  return JSON.parse(matches[0][1]);
}

test('both connection guides publish the executed OpenCodex configuration', () => {
  const expected = buildOpenCodexGatewayConfig({
    port: 10100,
    bridgeBaseUrl: 'http://127.0.0.1:8788/v1',
    modelAlias: '<gateway-model-alias>',
    claudeCodeModelId: '<claude-code-model-id>',
  });

  assert.deepEqual(documentedConfig(english), expected);
  assert.deepEqual(documentedConfig(korean), expected);
});

test('the optional integration states generic customer-owned validation boundaries', () => {
  for (const guide of [english, korean]) {
    assert.match(guide, /https:\/\/github\.com\/lidge-jun\/opencodex/);
    assert.match(guide, /https:\/\/opencodex\.me\//);
    assert.match(guide, /approved package registry|승인된 패키지 레지스트리/);
    assert.match(guide, /missing or mismatched integrity|무결성 정보가\s+없거나 일치하지 않으면 거부/);
    assert.match(guide, /retryOn429/);
    assert.match(guide, /liveModels/);
    assert.match(guide, /ocx start/);
    assert.match(guide, /ocx stop/);
    assert.match(guide, /agent-auth-bridge\.mjs/);
    assert.doesNotMatch(
      guide,
      /@bitkyc08\/opencodex@|embedded server path|live Azure request|real Codex or Claude Code process|실제 Codex 또는 Claude Code process/,
    );
  }
});

test('the public recipe does not introduce a provider or APIM credential', () => {
  for (const config of [documentedConfig(english), documentedConfig(korean)]) {
    const provider = config.providers['governed-gateway'];
    assert.equal(provider.apiKey, 'placeholder-replaced-by-bridge');
    assert.equal(provider.authMode, undefined);
    assert.equal(provider.retryOn429, undefined);
    assert.equal(provider.liveModels, false);
  }
});