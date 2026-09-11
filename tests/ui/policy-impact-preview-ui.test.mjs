import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalAdminServer } from '../../app/control-api/local-admin-server.mjs';
import { createLatestLoad } from '../../app/admin-ui/public/latest-load.mjs';

async function withServer(action) {
  const server = createLocalAdminServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await action(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the lifecycle entry point compares a stored draft without changing lifecycle state', async () => {
  await withServer(async (origin) => {
    const proposed = await fetch(`${origin}/api/local/entitlements/propose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'local-admin',
        bindingId: 'binding-global-local-001',
        changes: { modelAllowlist: ['coding-fast', 'coding-primary'] },
      }),
    });
    assert.equal(proposed.status, 201);
    const draft = await proposed.json();

    const lifecycleUrl = `${origin}/api/local/lifecycle?persona=governance-admin&scope=global`;
    const before = await (await fetch(lifecycleUrl)).json();
    const record = before.records.find((candidate) => candidate.revisionCode === draft.revisionId);
    assert.equal(record.previewAvailable, true);

    const response = await fetch(
      `${origin}/api/local/policy-impact-preview?persona=governance-admin`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revisionId: record.revisionCode,
          expectedRevisionNumber: record.revisionNumber,
          apiFamily: 'openai-responses',
          target: { kind: 'current-caller' },
        }),
      },
    );
    assert.equal(response.status, 200);
    const comparison = await response.json();
    assert.equal(comparison.state, 'changed');
    assert.equal(comparison.target.evidence, 'local-deterministic-persona');
    assert.ok(comparison.changes.some((change) => change.category === 'allowedModels'));

    const after = await (await fetch(lifecycleUrl)).json();
    assert.deepEqual(after.records, before.records);
    assert.equal(after.summary.activeRevisionCode, before.summary.activeRevisionCode);

    const denied = await fetch(
      `${origin}/api/local/policy-impact-preview?persona=end-user`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revisionId: record.revisionCode,
          expectedRevisionNumber: record.revisionNumber,
          apiFamily: 'openai-responses',
          target: { kind: 'current-caller' },
        }),
      },
    );
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'preview_denied');
  });
});

test('the lifecycle page includes the localized read-only preview controls', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /id="policy-impact-preview"/);
    assert.match(html, /data-i18n="preview\.description"/);

    const messages = await (await fetch(`${origin}/i18n.mjs`)).text();
    assert.match(messages, /'preview\.state\.stale': 'Comparison is stale/);
    assert.match(messages, /'preview\.state\.stale': '비교가 오래되었습니다/);
  });
});

test('preview UI renders structured policy details without raw JSON or narrow-screen overflow', async () => {
  await withServer(async (origin) => {
    const script = await (await fetch(`${origin}/app.mjs`)).text();
    const styles = await (await fetch(`${origin}/styles.css`)).text();
    const messages = await (await fetch(`${origin}/i18n.mjs`)).text();
    const previewRenderer = script.slice(
      script.indexOf('function formatBasisPoints'),
      script.indexOf('async function loadPolicyImpact'),
    );

    assert.doesNotMatch(previewRenderer, /JSON\.stringify/);
    for (const renderer of [
      'renderPreviewModels',
      'renderPreviewLimits',
      'renderPreviewTiers',
      'renderPreviewFallback',
    ]) {
      assert.match(previewRenderer, new RegExp(`function ${renderer}`));
    }
    assert.match(previewRenderer, /budgetThresholds\?\.graceBasisPoints/);
    assert.match(previewRenderer, /translateCode\('budgetAction'/);
    assert.match(previewRenderer, /translateCode\('fallbackReason'/);
    assert.match(previewRenderer, /model\.state === 'no-change' && !outcomesResolved/);
    assert.match(previewRenderer, /apiFamily: model\.apiFamily/);
    assert.match(previewRenderer, /model\.target\.identityBasis === 'control-plane-token'/);
    assert.match(previewRenderer, /\$\{titleKey\}ControlPlane/);
    assert.match(previewRenderer, /preview\.fallbackControlPlane/);
    assert.match(styles, /\.preview-outcomes \{[^}]*minmax\(0, 1fr\)/);
    assert.match(styles, /\.preview-outcome \{[^}]*min-width: 0/);
    assert.match(styles, /@media \(max-width: 1080px\)[\s\S]*\.preview-outcomes \{ grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(messages, /'preview\.noFallbackEdges': 'No permitted fallback edge'/);
    assert.match(messages, /'preview\.noFallbackEdges': '허용된 대체 경로 없음'/);
    assert.match(messages, /current control-plane token subject and client/);
    assert.match(messages, /현재 컨트롤 플레인 토큰의 주체와 클라이언트/);
    assert.match(messages, /Active policy for this control-plane token/);
    assert.match(messages, /Saved draft for this control-plane token/);
    assert.match(messages, /Fallback for this control-plane token/);
    assert.match(messages, /이 컨트롤 플레인 토큰에 대한 활성 정책/);
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('only the newest deferred preview load may render success or error', async () => {
  const coordinator = createLatestLoad();
  const firstResponse = deferred();
  const secondResponse = deferred();
  const rendered = [];

  async function run(response) {
    const load = coordinator.begin();
    try {
      const value = await response.promise;
      if (!load.isCurrent()) return;
      rendered.push(value);
    } catch (error) {
      if (!load.isCurrent()) return;
      rendered.push(`error:${error.message}`);
    } finally {
      load.finish();
    }
  }

  const first = run(firstResponse);
  const second = run(secondResponse);
  firstResponse.resolve('obsolete-success');
  secondResponse.resolve('newest-success');
  await Promise.all([first, second]);
  assert.deepEqual(rendered, ['newest-success']);

  const staleError = deferred();
  const current = deferred();
  const staleRun = run(staleError);
  const currentRun = run(current);
  staleError.reject(new Error('obsolete'));
  current.resolve('current-after-error');
  await Promise.all([staleRun, currentRun]);
  assert.deepEqual(rendered, ['newest-success', 'current-after-error']);
});

test('screen, persona, language, and selection invalidation abort outstanding preview work', async () => {
  const coordinator = createLatestLoad();
  for (const reason of ['screen', 'persona', 'language', 'selection']) {
    const load = coordinator.begin();
    assert.equal(load.signal.aborted, false, reason);
    coordinator.invalidate();
    assert.equal(load.signal.aborted, true, reason);
    assert.equal(load.isCurrent(), false, reason);
  }

  const script = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../../app/admin-ui/public/app.mjs', import.meta.url), 'utf8'));
  assert.match(script, /function setLocale\(nextLocale\) \{\s*previewLoads\.invalidate\(\)/);
  assert.match(script, /async function loadCurrentScreen\(\) \{\s*previewLoads\.invalidate\(\)/);
  assert.match(script, /function openPolicyImpact\(record\) \{\s*previewLoads\.invalidate\(\)/);
  assert.match(script, /signal: load\.signal/);
  assert.match(script, /if \(!load\.isCurrent\(\)\) return;/);
});
