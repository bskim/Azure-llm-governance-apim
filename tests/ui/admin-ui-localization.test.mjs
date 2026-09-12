import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  MESSAGES,
  SUPPORTED_LOCALES,
  localeTag,
  resolveLocale,
  translate,
} from '../../app/admin-ui/public/i18n.mjs';
import { getOverviewFixture } from '../../app/local-adapters/overview-fixtures.mjs';
import {
  API_FAMILIES,
  LIFECYCLE_STATES,
} from '../../app/governance-domain/registry/model-registry-validator.mjs';
import { PRICE_REFERENCE_MATCHES } from '../../app/governance-domain/registry/price-reference.mjs';
import {
  AUTHORING_REASON_CODES,
  FALLBACK_COMPATIBILITY_REASON_CODES,
} from '../../app/governance-domain/policy/fallback-plan-compiler.mjs';
import {
  LIFECYCLE_COMMANDS,
  LIFECYCLE_STATES as PUBLICATION_STATES,
  TARGET_OUTCOMES,
} from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';
import { NOTIFICATION_KINDS } from '../../app/governance-domain/notification/notification-delivery.mjs';
import {
  ACTOR_KINDS,
  CHANGE_CATEGORIES as AUDIT_CATEGORIES,
  EVIDENCE_KEYS,
} from '../../app/governance-domain/change-log/change-entry.mjs';
import { deriveChangeEntries } from '../../app/governance-domain/change-log/derive-change-entries.mjs';
import { getDeterministicConfigurationRevisions } from '../../app/local-adapters/deterministic-configuration-revisions.mjs';
import { getLocalNotifications } from '../../app/local-adapters/notification-fixtures.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { getUsersGroupsFixture } from '../../app/local-adapters/users-groups-fixtures.mjs';
import { projectUsersGroupsReadModel } from '../../app/control-api/users-groups-read-model-projector.mjs';

const publicRoot = new URL('../../app/admin-ui/public/', import.meta.url);

test('English and Korean catalogs have identical, nonempty key sets', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['en', 'ko']);
  const englishKeys = Object.keys(MESSAGES.en).sort();
  const koreanKeys = Object.keys(MESSAGES.ko).sort();
  assert.deepEqual(koreanKeys, englishKeys);
  for (const locale of SUPPORTED_LOCALES) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) {
      assert.equal(typeof value, 'string', `${locale}:${key}`);
      assert.ok(value.trim().length > 0, `${locale}:${key}`);
    }
  }
});

test('locale resolution and fallback are deterministic', () => {
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale('EN-us'), 'en');
  assert.equal(resolveLocale('ko'), 'ko');
  assert.equal(resolveLocale('ko-KR'), 'ko');
  assert.equal(resolveLocale('fr'), 'en');
  assert.equal(resolveLocale(undefined), 'en');
  assert.equal(localeTag('ko'), 'ko-KR');
  assert.equal(localeTag('invalid'), 'en-US');
  assert.equal(translate('ko', 'missing.key'), '[missing:missing.key]');
  assert.equal(
    translate('ko', 'quality.seconds', { value: '12' }),
    '12초',
  );
  assert.equal(translate('en', 'lifecycleCommand.withdrawDraft'), 'Withdraw draft');
  assert.equal(translate('ko', 'lifecycleCommand.withdrawDraft'), '초안 철회');
});

test('publication copy describes explicit saved-draft self-approval without mislabeling prior denials', () => {
  assert.match(translate('en', 'lifecycle.selfApproval'), /your own saved draft/);
  assert.match(translate('en', 'lifecycle.selfApproval'), /another administrator/);
  assert.match(translate('ko', 'lifecycle.selfApproval'), /다른 관리자/);
  assert.equal(translate('en', 'lifecycleCommand.approvePublish'), 'Approve and publish');
  assert.equal(translate('ko', 'lifecycleCommand.approvePublish'), '승인 및 게시');
  for (const key of ['budgetEdit.proposed', 'accessEdit.proposed']) {
    assert.match(translate('en', key), /saved, not published/);
    assert.match(translate('ko', key), /아직 게시하지 않았습니다/);
  }
  assert.match(translate('en', 'lifecycleReason.separation-of-duties'), /did not have/);
  assert.match(translate('en', 'auditReason.self-approval-granted'), /explicitly approved their own/);
});

test('every static HTML translation key exists in both catalogs', async () => {
  const html = await readFile(new URL('index.html', publicRoot), 'utf8');
  const keys = [
    ...html.matchAll(/data-i18n(?:-aria-label|-title|-content)?="([^"]+)"/g),
  ].map((match) => match[1]);
  assert.ok(keys.length > 30);
  for (const key of keys) {
    assert.ok(Object.hasOwn(MESSAGES.en, key), `English missing ${key}`);
    assert.ok(Object.hasOwn(MESSAGES.ko, key), `Korean missing ${key}`);
  }
});

test('every screen has the chrome keys the shell builds from its prefix', async () => {
  // These are composed at runtime from a screen's prefix, so a new screen with a
  // missing one renders `[missing:...]` and no static scan of the HTML sees it.
  const script = await readFile(new URL('app.mjs', publicRoot), 'utf8');
  const prefixes = [...script.matchAll(/prefix: '([^']+)'/g)].map((match) => match[1]);
  const paths = [...script.matchAll(/path: '([^']+)'/g)].map((match) => match[1]);
  assert.equal(prefixes.length, 9, 'every screen declares a prefix');
  assert.equal(paths.length, prefixes.length, 'every screen declares a route');

  for (const prefix of prefixes) {
    for (const suffix of ['eyebrow', 'title', 'filters']) {
      const key = `${prefix}.${suffix}`;
      assert.ok(Object.hasOwn(MESSAGES.en, key), `English missing ${key}`);
      assert.ok(Object.hasOwn(MESSAGES.ko, key), `Korean missing ${key}`);
    }
  }
});

test('dynamic codes from every data fixture have translations while stable identifiers remain untranslated', () => {
  const dynamicKeys = new Set();
  for (const fixtureName of ['complete', 'stale', 'partial', 'empty']) {
    for (const scope of ['self', 'team', 'global']) {
      const fixture = getOverviewFixture(fixtureName, { scope });
      for (const metric of fixture.metrics) {
        dynamicKeys.add(`metric.${metric.id}`);
        dynamicKeys.add(`quality.${metric.quality}`);
        dynamicKeys.add(`freshness.${metric.freshness}`);
        dynamicKeys.add(`source.${metric.source}`);
      }
      for (const state of fixture.operatingState) {
        dynamicKeys.add(`operating.${state.id}`);
        dynamicKeys.add(`status.${state.valueCode}`);
      }
      for (const item of fixture.attention) {
        dynamicKeys.add(`attention.${item.titleCode}`);
        dynamicKeys.add(`attention.${item.reasonCode}`);
        dynamicKeys.add(`severity.${item.severity}`);
      }
      for (const item of fixture.recentActivity) {
        dynamicKeys.add(`activity.scope.${item.scopeCode}`);
        dynamicKeys.add(`activity.outcome.${item.outcome}`);
        dynamicKeys.add(`quality.${item.tokenQuality}`);
      }
    }
  }
  const context = {
    subject: { subjectId: 'user-local-admin' },
    memberships: {
      status: 'complete',
      expiresAt: '2026-07-24T10:30:00.000Z',
      groups: [
        {
          groupId: 'group-governance-admin',
          membership: 'direct',
          authorizationRelevant: true,
        },
      ],
    },
  };
  const authorization = {
    contractVersion: 'v1',
    decision: 'allow',
    readAuthority: 'authoritative',
    reasonCode: 'most-restrictive-policy',
    permittedReadScopes: ['self', 'team', 'global'],
    permittedTeamKeys: ['developer-experience', 'platform-engineering'],
  };
  for (const fixtureName of ['complete', 'stale', 'partial', 'empty']) {
    for (const scope of ['self', 'team', 'global']) {
      for (const view of ['users', 'groups']) {
        const readModel = projectUsersGroupsReadModel({
          context,
          authorization,
          entitlementSnapshot: getDeterministicGovernanceSnapshots().entitlementSnapshot,
          fixture: getUsersGroupsFixture(fixtureName),
          selection: {
            scope,
            view,
            teamKey: scope === 'team' ? 'platform-engineering' : null,
          },
        });
        for (const record of readModel.records) {
          dynamicKeys.add(`entity.${record.entityKind}`);
          dynamicKeys.add(`directory.${record.displayCode}`);
          dynamicKeys.add(`lifecycle.${record.lifecycleState}`);
          dynamicKeys.add(`resolution.${record.resolutionState}`);
          for (const source of [
            ...record.policyInspection.direct,
            ...record.policyInspection.inherited,
          ]) {
            dynamicKeys.add(`origin.${source.originCode}`);
            dynamicKeys.add(`sourceKind.${source.sourceKind}`);
            dynamicKeys.add(`directory.${source.sourceCode}`);
            dynamicKeys.add(`decision.${source.decisionCode}`);
          }
          dynamicKeys.add(`decision.${record.policyInspection.effective.decisionCode}`);
          dynamicKeys.add(`reason.${record.policyInspection.effective.reasonCode}`);
        }
      }
    }
  }
  for (const key of dynamicKeys) {
    assert.ok(Object.hasOwn(MESSAGES.en, key), `English missing ${key}`);
    assert.ok(Object.hasOwn(MESSAGES.ko, key), `Korean missing ${key}`);
  }

  const catalogText = JSON.stringify(MESSAGES);
  for (const stable of [
    'cfg-local-003',
        'request-local-1042',
    'attention-membership-001',
    'coding-primary',
    'directory-user-001',
  ]) {
    assert.equal(catalogText.includes(stable), false, stable);
  }
});

test('every code the budget publication can emit has a translation in every locale', () => {
  // The catalogue is enumerated from the publication module rather than from a
  // fixture, because a fixture exercises the codes it happens to reach and the screen
  // has to survive the ones it does not.
  const dynamicKeys = new Set();
  for (const action of ['HARD_BLOCK', 'SOFT_WARNING', 'THROTTLE']) {
    dynamicKeys.add(`budgetAction.${action}`);
  }
  for (const period of ['Hourly', 'Daily', 'Weekly', 'Monthly', 'Yearly']) {
    dynamicKeys.add(`period.${period}`);
  }
  for (const scope of ['organization', 'team', 'subject', 'application']) {
    dynamicKeys.add(`budgetScope.${scope}`);
  }
  for (const intent of ['pinned', 'preferred']) dynamicKeys.add(`intent.${intent}`);
  for (const notice of ['header', 'inline']) dynamicKeys.add(`notice.${notice}`);
  for (const state of ['fresh', 'stale']) dynamicKeys.add(`freshness.${state}`);

  const publication = readFileSync(
    new URL('../../app/governance-domain/policy/budget-publication.mjs', import.meta.url),
    'utf8',
  );
  const quota = readFileSync(
    new URL('../../app/governance-domain/policy/budget-token-quota.mjs', import.meta.url),
    'utf8',
  );
  const codes = [
    ...`${quota}${publication}`.matchAll(/reasonCode: '([a-z-]+)'/g),
    ...`${quota}${publication}`.matchAll(/state: '([a-z-]+)'/g),
  ].map((match) => match[1]);
  assert.ok(codes.length > 3);
  for (const code of codes) dynamicKeys.add(`budgetState.${code}`);

  for (const key of dynamicKeys) {
    assert.ok(Object.hasOwn(MESSAGES.en, key), `English missing ${key}`);
    assert.ok(Object.hasOwn(MESSAGES.ko, key), `Korean missing ${key}`);
  }
});

test('every code the usage screen can emit has a translation in every locale', () => {
  // Read from the modules that produce the codes, not from a fixture. A fixture only
  // reaches the reasons its own rows happen to trigger, and the screen has to survive
  // an unobserved window it has never been shown.
  const dynamicKeys = new Set(['usageReason.none', 'usageReason.window-not-observed']);
  for (const kind of ['user', 'group']) dynamicKeys.add(`usage.entityKind.${kind}`);
  for (const outcome of ['served', 'refused', 'failed']) dynamicKeys.add(`usage.outcome.${outcome}`);
  for (const state of ['partial', 'degraded']) dynamicKeys.add(`usage.window.${state}`);
  for (const quality of ['reported', 'estimated', 'mixed', 'unknown']) dynamicKeys.add(`quality.${quality}`);

  const rollup = readFileSync(
    new URL('../../app/governance-domain/usage/usage-rollup-projector.mjs', import.meta.url),
    'utf8',
  );
  const windowReasons = [...rollup.matchAll(/reason: '([a-z-]+)'/g)].map((match) => match[1]);
  assert.ok(windowReasons.length >= 4);

  for (const code of windowReasons) {
    dynamicKeys.add(`usageReason.${code}`);
  }

  for (const key of dynamicKeys) {
    assert.ok(Object.hasOwn(MESSAGES.en, key), `English missing ${key}`);
    assert.ok(Object.hasOwn(MESSAGES.ko, key), `Korean missing ${key}`);
  }
});

test('every code the model catalogue can emit has a translation in every locale', () => {
  // Enumerated from the registry contract, so a value the fixture never uses still
  // has to be renderable.
  const dynamicKeys = new Set([
    'models.catalogue.complete',
    'models.catalogue.expiring',
    'models.catalogue.expired',
    'models.catalogue.unavailable',
    'models.quotaState.complete',
    'models.quotaState.expired',
    'models.quotaState.unavailable',
    'models.poolFullyAllocated',
    'models.poolAllocatable',
    'models.allocationNotUsage',
    'source.not-collected',
    'models.providerAgreement.agrees',
    'models.providerAgreement.diverged',
    'models.providerAgreement.deployment-absent',
    'models.providerAgreement.unverified',
  ]);
  for (const field of ['provider-code', 'deployment-name', 'api-families', 'lifecycle', 'safety-policy']) {
    dynamicKeys.add(`models.providerField.${field}`);
  }
  for (const family of API_FAMILIES) dynamicKeys.add(`apiFamily.${family}`);
  for (const state of LIFECYCLE_STATES) dynamicKeys.add(`lifecycle.${state}`);

  // Read from the modules that emit the codes, so a reason the fixture never hits is
  // still renderable.
  const quotaValidator = readFileSync(
    new URL('../../app/governance-domain/registry/provider-quota-validator.mjs', import.meta.url),
    'utf8',
  );
  const modelsProjector = readFileSync(
    new URL('../../app/control-api/models-read-model-projector.mjs', import.meta.url),
    'utf8',
  );
  const quotaReasons = [
    ...quotaValidator.matchAll(/'(pool-[a-z-]+)'/g),
    ...modelsProjector.matchAll(/reasonCode: '([a-z-]+)'/g),
    ...modelsProjector.matchAll(/\? '(quota-snapshot-[a-z-]+)'/g),
  ].map((match) => match[1]);
  assert.ok(quotaReasons.length >= 5);
  for (const reason of quotaReasons) dynamicKeys.add(`quotaReason.${reason}`);

  // Every way a capture can be refused, read from the module that mints the codes: a
  // refusal the local fixture never trips still has to render for a real one.
  const capture = readFileSync(
    new URL('../../app/governance-domain/registry/model-capture.mjs', import.meta.url),
    'utf8',
  );
  const captureReasons = [...capture.matchAll(/: '(model-capture-[a-z-]+)'/g)].map((match) => match[1]);
  assert.ok(captureReasons.length >= 6);
  for (const code of captureReasons) dynamicKeys.add(`accessEditRefusal.${code}`);
  for (const match of PRICE_REFERENCE_MATCHES) dynamicKeys.add(`modelPrices.match.${match}`);

  for (const key of dynamicKeys) {
    assert.ok(Object.hasOwn(MESSAGES.en, key), `English missing ${key}`);
    assert.ok(Object.hasOwn(MESSAGES.ko, key), `Korean missing ${key}`);
  }
});

test('every code the fallback screen can emit has a translation in every locale', () => {
  // Enumerated from the modules that produce the codes. A compatibility class the
  // fixture never trips still has to render when a real plan trips it.
  const dynamicKeys = new Set();
  for (const code of FALLBACK_COMPATIBILITY_REASON_CODES) dynamicKeys.add(`fallbackReason.${code}`);
  for (const code of AUTHORING_REASON_CODES) dynamicKeys.add(`fallbackReason.${code}`);
  for (const state of ['complete', 'plan-refused', 'no-plan']) dynamicKeys.add(`fallback.plan.${state}`);
  for (const state of ['permitted', 'refused', 'not-compiled']) dynamicKeys.add(`fallback.hopState.${state}`);
  for (const kind of ['none', 'threshold-breach']) dynamicKeys.add(`fallback.trigger.${kind}`);
  for (const kind of ['global', 'team', 'subject', 'application']) dynamicKeys.add(`fallbackTarget.${kind}`);
  for (const state of ['active', 'revoked', 'expired']) dynamicKeys.add(`recordState.${state}`);
  // Only a plan that is not active reaches the disabled reason, so an active plan has
  // no such code to translate.
  for (const state of ['revoked', 'expired']) dynamicKeys.add(`fallbackReason.fallback-plan-${state}`);

  const compiler = readFileSync(
    new URL('../../app/governance-domain/policy/fallback-plan-compiler.mjs', import.meta.url),
    'utf8',
  );
  const selector = readFileSync(
    new URL('../../app/governance-domain/policy/effective-model-selector.mjs', import.meta.url),
    'utf8',
  );
  const decision = readFileSync(
    new URL('../../app/governance-domain/policy/model-selection-decision.mjs', import.meta.url),
    'utf8',
  );
  const emitted = [
    ...`${compiler}${selector}${decision}`.matchAll(/'(fallback-[a-z-]+|model-pinned|within-budget|requested-model-unregistered|effective-model-unregistered|model-registry-unavailable)'/g),
  ].map((match) => match[1]);
  assert.ok(emitted.length > 15);
  for (const code of emitted) dynamicKeys.add(`fallbackReason.${code}`);
  dynamicKeys.add('fallbackReason.fallback-no-plan-for-scope');
  dynamicKeys.add('fallbackReason.authoring-accepted');

  for (const key of dynamicKeys) {
    assert.ok(Object.hasOwn(MESSAGES.en, key), `English missing ${key}`);
    assert.ok(Object.hasOwn(MESSAGES.ko, key), `Korean missing ${key}`);
  }
});

test('every state, command, and refusal the lifecycle can reach has a translation', () => {
  // Enumerated from the reducer's own tables, so a state or refusal added later fails
  // here rather than rendering as a raw code.
  const dynamicKeys = new Set();
  for (const state of PUBLICATION_STATES) dynamicKeys.add(`lifecycleState.${state}`);
  for (const command of LIFECYCLE_COMMANDS) dynamicKeys.add(`lifecycleCommand.${command}`);
  for (const outcome of TARGET_OUTCOMES) dynamicKeys.add(`targetOutcome.${outcome}`);

  const lifecycle = readFileSync(
    new URL('../../app/governance-domain/lifecycle/configuration-lifecycle.mjs', import.meta.url),
    'utf8',
  );
  const refusals = [...lifecycle.matchAll(/refuse\('([a-z-]+)'/g)].map((match) => match[1]);
  assert.ok(refusals.length >= 10);
  for (const code of refusals) dynamicKeys.add(`lifecycleReason.${code}`);

  const fixture = readFileSync(
    new URL('../../app/local-adapters/deterministic-configuration-revisions.mjs', import.meta.url),
    'utf8',
  );
  for (const match of fixture.matchAll(/'([a-z]+-[a-z-]+)'\)/g)) {
    if (match[1].includes('mismatch') || match[1].includes('publish')) {
      dynamicKeys.add(`lifecycleReason.${match[1]}`);
    }
  }

  for (const key of dynamicKeys) {
    assert.ok(Object.hasOwn(MESSAGES.en, key), `English missing ${key}`);
    assert.ok(Object.hasOwn(MESSAGES.ko, key), `Korean missing ${key}`);
  }
});

test('every audit category, actor, evidence field, and chain verdict has a translation', () => {
  const dynamicKeys = new Set(['auditReason.export-permitted', 'auditReason.export-not-permitted']);
  for (const category of AUDIT_CATEGORIES) dynamicKeys.add(`auditCategory.${category}`);
  for (const kind of ACTOR_KINDS) dynamicKeys.add(`auditActor.${kind}`);
  for (const key of EVIDENCE_KEYS) dynamicKeys.add(`auditEvidence.${key}`);
  for (const code of ['message-bodies', 'token-counts', 'credentials']) {
    dynamicKeys.add(`auditExcluded.${code}`);
  }

  // The completeness codes the change log can report, read from the projector rather
  // than from a fixture: a fixture reaches only the codes it happens to hit.
  const projectorSource = readFileSync(
    new URL('../../app/control-api/change-log-read-model-projector.mjs', import.meta.url),
    'utf8',
  );
  const reasons = projectorSource
    .split('\n')
    .filter((line) => line.includes('reasonCode'))
    .flatMap((line) => [...line.matchAll(/'([a-z][a-z0-9-]{2,})'/g)].map((match) => match[1]));
  assert.ok(reasons.includes('change-log-read'));
  assert.ok(reasons.includes('categories-limited-by-scope'));
  for (const code of reasons) dynamicKeys.add(`auditReason.${code}`);

  // Every action and reason the local change log can actually emit must render. A
  // notification-sourced entry is named by the notification vocabulary, because the
  // screen renders it with that and a second wording would drift from it.
  const notificationSourced = new Set(['notification', 'drift']);
  for (const entry of deriveChangeEntries({
    revisions: getDeterministicConfigurationRevisions(),
    notifications: getLocalNotifications(),
  })) {
    dynamicKeys.add(
      notificationSourced.has(entry.category)
        ? `notificationKind.${entry.action}`
        : `auditAction.${entry.action}`,
    );
    if (entry.reasonCode !== null) {
      dynamicKeys.add(
        notificationSourced.has(entry.category)
          ? `notificationReason.${entry.reasonCode}`
          : `auditReason.${entry.reasonCode}`,
      );
    }
  }

  // Every kind the product defines, read from the closed list rather than from the
  // fixtures: a fixture reaches only the kinds it happens to raise, and a new kind
  // would render as a raw code on the screen that exists to be read.
  for (const kind of NOTIFICATION_KINDS) dynamicKeys.add(`notificationKind.${kind}`);

  for (const key of dynamicKeys) {
    assert.ok(Object.hasOwn(MESSAGES.en, key), `English missing ${key}`);
    assert.ok(Object.hasOwn(MESSAGES.ko, key), `Korean missing ${key}`);
  }
});

test('client localization remains in memory and never enters API query construction', async () => {
  const script = await readFile(new URL('app.mjs', publicRoot), 'utf8');
  assert.match(script, /history\.replaceState/);
  assert.match(script, /currentReadModel/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(script, /params\.set\(['"]lang|lang:\s*locale/);
  assert.doesNotMatch(script, /fetch\([^)]*lang/);
});