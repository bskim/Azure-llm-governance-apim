import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { selectPublicSnapshotPaths } from '../../tools/distribution/public-boundary-scan.mjs';

const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PAIRS = Object.freeze([
  ['README.md', 'README_ko.md'],
  ['CONTRIBUTING.md', 'CONTRIBUTING_ko.md'],
  ['SECURITY.md', 'SECURITY_ko.md'],
  ['docs/00-quickstart.md', 'docs/00-quickstart_ko.md'],
  ['docs/01-deployment.md', 'docs/01-deployment_ko.md'],
  ['docs/02-administration.md', 'docs/02-administration_ko.md'],
  ['docs/03-operations.md', 'docs/03-operations_ko.md'],
  ['docs/04-connection.md', 'docs/04-connection_ko.md'],
  ['docs/05-notifications.md', 'docs/05-notifications_ko.md'],
]);

function trackedMarkdown() {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.md'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(listed.status, 0, listed.stderr);
  return selectPublicSnapshotPaths(listed.stdout.split(/\r?\n/).filter(Boolean))
    .filter((relativePath) => existsSync(path.join(repositoryRoot, relativePath)));
}

function text(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

test('contribution guidance uses the local public gate without hosted Actions workflows', () => {
  const workflows = path.join(repositoryRoot, '.github', 'workflows');
  const hostedWorkflows = existsSync(workflows)
    ? readdirSync(workflows).filter((file) => /\.ya?ml$/i.test(file))
    : [];
  assert.deepEqual(hostedWorkflows, []);
  for (const guide of ['CONTRIBUTING.md', 'CONTRIBUTING_ko.md']) {
    assert.ok(text(guide).includes('pwsh -NoProfile -File tests/Test-Local.ps1 -PublicOnly -IncludeExternalOpenApiLint'));
    assert.doesNotMatch(text(guide), /\.github\/workflows\//);
  }
});

test('public numbered documentation is exactly 00 through 05 in complete language pairs', () => {
  const numbered = readdirSync(path.join(repositoryRoot, 'docs'))
    .filter((file) => /^\d{2}-.*\.md$/.test(file))
    .map((file) => `docs/${file}`)
    .sort();
  assert.deepEqual(numbered, PAIRS.filter(([english]) => english.startsWith('docs/')).flat().sort());
});

test('local evaluation guidance separates reference and mock evidence from live APIM enforcement', () => {
  for (const guide of ['docs/03-operations.md', 'docs/03-operations_ko.md']) {
    const source = text(guide);
    assert.ok(source.includes('node tools/evaluation/run-local-evaluation.mjs'));
    assert.ok(source.includes('node --test tests/evaluation/*.test.mjs'));
    assert.ok(source.includes('tests/policy/Test-InferencePolicy.ps1'));
    assert.match(source, /HARD/);
    assert.match(source, /SOFT/);
    assert.match(source, /THROTTLE/);
  }
  assert.match(text('docs/03-operations.md'), /not an APIM emulator/);
  assert.match(text('docs/03-operations.md'), /do not provide a live mode/);
  assert.match(text('docs/03-operations_ko.md'), /APIM 에뮬레이터가 아니며/);
  assert.match(text('docs/03-operations_ko.md'), /live 모드를 제공하지 않습니다/);
});

test('impact preview guidance limits the target to the authenticated caller and preserves publication approval', () => {
  const english = text('docs/02-administration.md');
  const korean = text('docs/02-administration_ko.md');
  assert.match(english, /current authenticated caller only/);
  assert.match(english, /including the application identity/);
  assert.match(english, /does not save, approve, publish/);
  assert.match(english, /changed active set or draft revision/);
  assert.match(english, /not a measurement of live budget counters/);
  assert.match(english, /inference-token-identity-not-established/);
  assert.match(english, /does not replace the subject with an object ID/);
  assert.match(korean, /현재 인증된 호출자만/);
  assert.match(korean, /애플리케이션 신원도 포함/);
  assert.match(korean, /저장, 승인, 게시, 토큰 소비 또는 활성 정책 변경을 수행하지 않습니다/);
  assert.match(korean, /실시간 예산 카운터를 측정하거나/);
  assert.match(korean, /inference-token-identity-not-established/);
});

test('redistribution guidance preserves notices without claiming legal approval', () => {
  const notice = text('NOTICE');
  assert.match(notice, /vendor\/THIRD-PARTY-NOTICES\.txt/);
  assert.match(notice, /original license files/);
  assert.match(notice, /not a complete consolidated license/);
  assert.match(notice, /legal or organizational release approval/);
  assert.match(notice, /priorityqueuejs\/blob\/5fc8ac2ea0482277ee8110182e1d743e31cef1aa\/Readme\.md#L85-L87/);
  assert.match(notice, /semaphore\.js\/blob\/88a33875b168cc7b5943d7fe987c36d08321d252\/README\.md#L68-L71/);
  assert.match(notice, /Links do not replace the preservation/);
  for (const readme of ['README.md', 'README_ko.md']) {
    assert.match(text(readme), /\]\(NOTICE\)/);
    assert.match(text(readme), /vendor\/THIRD-PARTY-NOTICES\.txt/);
  }
});

function measureSections(markdown) {
  const sections = [];
  let current = { level: 0, chunks: 0, items: 0, rows: 0, fences: 0 };
  let inFence = false;
  let blank = true;

  for (const line of markdown.split(/\r?\n/)) {
    if (/^```/.test(line)) {
      if (!inFence) current.fences += 1;
      inFence = !inFence;
      blank = true;
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6}) /.exec(line);
    if (heading) {
      sections.push(current);
      current = { level: heading[1].length, chunks: 0, items: 0, rows: 0, fences: 0 };
      blank = true;
      continue;
    }
    if (line.trim() === '') {
      blank = true;
      continue;
    }
    if (blank) current.chunks += 1;
    blank = false;
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) current.items += 1;
    if (/^\s*\|/.test(line)) current.rows += 1;
  }
  sections.push(current);
  return sections;
}

function headingAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (!match) continue;
    const base = match[1]
      .replace(/<[^>]*>/g, '')
      .replace(/[`*_~]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function localLinks(relativePath, markdown) {
  return [...markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|mailto:)/i.test(target));
}

test('every publishable Markdown file follows the public boundary and prose checks', () => {
  const files = trackedMarkdown();
  assert.deepEqual(files, [
    'CONTRIBUTING.md',
    'CONTRIBUTING_ko.md',
    'README.md',
    'README_ko.md',
    'SECURITY.md',
    'SECURITY_ko.md',
    'app/governance-domain/contracts/v1/governance-authorization.md',
    'app/governance-domain/contracts/v1/principal-context.md',
    'docs/00-quickstart.md',
    'docs/00-quickstart_ko.md',
    'docs/01-deployment.md',
    'docs/01-deployment_ko.md',
    'docs/02-administration.md',
    'docs/02-administration_ko.md',
    'docs/03-operations.md',
    'docs/03-operations_ko.md',
    'docs/04-connection.md',
    'docs/04-connection_ko.md',
    'docs/05-notifications.md',
    'docs/05-notifications_ko.md',
    'tools/agent-auth-bridge/README.md',
  ]);

  for (const file of files.filter((candidate) => !candidate.endsWith('_ko.md') && candidate !== 'README_ko.md')) {
    assert.doesNotMatch(text(file), /[—–]/, `${file} contains a dash prohibited by the English prose rules`);
  }
  assert.doesNotMatch(text('docs/04-connection.md'), /more than anything else/i);
  assert.doesNotMatch(text('docs/04-connection_ko.md'), /곉보기엔|깁어 오는|한 시간 단위로 산다/);
});

test('English and Korean documents match section by section', () => {
  for (const [english, korean] of PAIRS) {
    const left = measureSections(text(english));
    const right = measureSections(text(korean));
    assert.deepEqual(
      right.map(({ level, chunks, items, rows, fences }) => ({ level, chunks, items, rows, fences })),
      left.map(({ level, chunks, items, rows, fences }) => ({ level, chunks, items, rows, fences })),
      `${english} and ${korean} differ in section structure or content blocks`,
    );
  }
});

test('Korean public prose uses formal polite sentence endings', () => {
  const plainEnding = /(?:한다|된다|이다|있다|없다|아니다|않는다|준다|둔다|받는다|보낸다|다룬다|다르다|모른다|좋다|필요하다|가능하다|같다)[.!?](?=\s|\*|$)/u;
  const informalPoliteEnding = /(?:세요|해요|돼요|어요|아요|예요|이에요|네요|군요|거든요|죠)(?=[.!?,\s*]|$)/u;
  for (const [, korean] of PAIRS) {
    const lines = text(korean).split(/\r?\n/);
    let inFence = false;
    for (const [index, line] of lines.entries()) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (!inFence) {
        assert.doesNotMatch(line, plainEnding, `${korean}:${index + 1} uses a plain-form sentence ending`);
        assert.doesNotMatch(line, informalPoliteEnding, `${korean}:${index + 1} uses an informal polite sentence ending`);
      }
    }
  }
});

test('relative Markdown links, image targets, and heading anchors resolve', () => {
  for (const file of trackedMarkdown()) {
    const markdown = text(file);
    for (const target of localLinks(file, markdown)) {
      const [encodedPath, encodedFragment] = target.split('#', 2);
      const targetPath = encodedPath.length === 0
        ? file
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(encodedPath)));
      const absoluteTarget = path.join(repositoryRoot, targetPath);
      assert.equal(existsSync(absoluteTarget), true, `${file} links to missing ${targetPath}`);
      if (encodedFragment && path.extname(targetPath).toLowerCase() === '.md') {
        const anchors = headingAnchors(text(targetPath));
        const fragment = decodeURIComponent(encodedFragment).toLowerCase();
        assert.equal(anchors.has(fragment), true, `${file} links to missing #${fragment} in ${targetPath}`);
      }
    }
  }
});

test('document links stay in one language except for the README switch', () => {
  assert.match(text('README.md'), /\(README_ko\.md\)/);
  assert.match(text('README_ko.md'), /\(README\.md\)/);

  for (const [english, korean] of PAIRS.slice(1)) {
    for (const target of localLinks(english, text(english))) {
      if (target.startsWith('0') && target.includes('.md')) assert.doesNotMatch(target, /_ko\.md/);
    }
    for (const target of localLinks(korean, text(korean))) {
      if (target.startsWith('0') && target.includes('.md')) assert.match(target, /_ko\.md/);
    }
  }
});

test('connection and administration guides pin the corrected runtime contracts', () => {
  assert.match(text('docs/04-connection.md'), /client ID is onboarding information, not discovery metadata/);
  assert.match(text('docs/04-connection_ko.md'), /클라이언트 ID는 초기 연결을 위해 관리자가 제공하는 정보이며 자동 검색 메타데이터에 포함되지 않습니다/);
  assert.match(text('docs/02-administration.md'), /subsequent supported change is stored as a draft/);
  assert.match(text('docs/02-administration_ko.md'), /이후 지원되는 변경은 초안으로 저장됩니다/);
  assert.match(text('docs/02-administration.md'), /approval-only request/);
  assert.match(text('docs/02-administration_ko.md'), /승인 전용 요청/);
  assert.match(text('docs/02-administration.md'), /"resume": true, "revisionId"/);
  assert.match(text('docs/02-administration_ko.md'), /"resume": true, "revisionId"/);
  assert.match(text('docs/02-administration.md'), /command": "withdraw"/);
  assert.match(text('docs/02-administration_ko.md'), /command": "withdraw"/);
  assert.match(text('docs/02-administration.md'), /proposal-abandonment-verified-targets/);
  assert.match(text('docs/02-administration_ko.md'), /proposal-abandonment-verified-targets/);
  assert.match(text('docs/02-administration.md'), /legacy-recovery-abandon-required/);
  assert.match(text('docs/02-administration_ko.md'), /legacy-recovery-abandon-required/);
  assert.match(text('docs/02-administration.md'), /draft, approval, failed proposal, or publishing proposal/);
  assert.match(text('docs/02-administration_ko.md'), /draft, approved, failed 또는 publishing 제안/);
  assert.match(text('docs/01-deployment.md'), /--resume --revision-id/);
  assert.match(text('docs/01-deployment_ko.md'), /--resume --revision-id/);
  assert.match(text('docs/01-deployment.md'), /default governance and rollup containers do not set a TTL/);
  assert.match(text('docs/01-deployment_ko.md'), /기본 거버넌스 및 롤업 컨테이너에는 TTL이 설정되지 않으며/);
  assert.match(text('docs/02-administration.md'), /Pseudonymous does not mean anonymous/);
  assert.match(text('docs/02-administration_ko.md'), /가명화는 익명화를 의미하지 않습니다/);
  assert.match(text('docs/02-administration.md'), /does not provide organizational approval or a monitoring notice/);
  assert.match(text('docs/02-administration_ko.md'), /조직의 승인이나 모니터링 안내를 대신 제공하지 않습니다/);
  assert.match(text('app/governance-domain/contracts/v1/governance-authorization.md'), /combine by union/);
});

test('landing pages explain the coding-agent token-governance audience and endpoint contract', () => {
  assert.match(text('README.md'), /Competitive open-weight models[\s\S]*Coding agents/);
  assert.match(text('README.md'), /Token economics[\s\S]*token consumption/);
  assert.match(text('README_ko.md'), /경쟁력 있는 공개 가중치 모델[\s\S]*코딩 에이전트 사용량/);
  assert.match(text('README_ko.md'), /토큰 경제성[\s\S]*토큰 사용량/);
  assert.match(text('README.md'), /`\/v1`[\s\S]*unrelated to the APIM Basic v2 service tier/);
  assert.match(text('README.md'), /do not define `\/openai\/v2` variants/);
  assert.match(text('README_ko.md'), /`\/v1`[\s\S]*APIM Basic v2 서비스 계층과도 관계가 없습니다/);
  assert.match(text('README_ko.md'), /`\/openai\/v2` 변형은 정의하지 않습니다/);

  for (const file of trackedMarkdown()) {
    assert.doesNotMatch(text(file), /Microsoft-internal|Microsoft 직원|Microsoft 내부 서비스|general end-user/i);
  }
});

test('administration guides explain budget actions, authoring and blocking without fallback', () => {
  const english = text('docs/02-administration.md');
  const korean = text('docs/02-administration_ko.md');
  for (const guide of [english, korean]) {
    for (const term of [
      'HARD_BLOCK', 'SOFT_WARNING', 'THROTTLE', 'apim-estimated-total-tokens',
      'warnAtBasisPoints', 'graceBasisPoints', 'atBasisPoints', 'tierCode',
      'tier-reduced', 'tier-minimal', '1,050,000',
      'per-model', 'all-models', 'Hourly', 'Daily', 'Weekly', 'Monthly', 'Yearly',
      '403 token_quota_exceeded', 'Retry-After',
    ]) {
      assert.ok(guide.includes(term), `budget guidance omits ${term}`);
    }
  }
  assert.match(english, /not warning-only, unlimited use/);
  assert.match(korean, /경고만 하고 무제한 허용하는 동작은 아닙니다/);
  assert.match(english, /does not create a hard token quota of its own/);
  assert.match(korean, /자체적으로 토큰 총량을 차단하지는 않지만/);
  assert.match(english, /Saving a draft does not change the active budget/);
  assert.match(korean, /초안을 저장하는 것만으로 활성 예산이 바뀌지는 않습니다/);
  assert.match(english, /scope is not editable/);
  assert.match(korean, /기존 예산의 범위는 편집할 수 없으며/);
  assert.match(english, /does not inherit the previous version's consumption counter/);
  assert.match(korean, /이전 버전의 소비 카운터를 이어받지는 않습니다/);
  assert.match(english, /an unchanged submission is refused/);
  assert.match(korean, /변경 사항이 없는 제출은 거부됩니다/);
  assert.match(english, /Choosing another period does not permit a second budget of the same kind/);
  assert.match(korean, /기간만 다르게 선택해도 같은 종류의 예산을 추가로 만들 수는 없습니다/);
  assert.match(english, /warning thresholds use whole percentages/);
  assert.match(korean, /APIM 경고 임계값은 정수 백분율로 변환/);
  assert.match(english, /fallback plan disabled or unconfigured/);
  assert.match(korean, /폴백 계획은 비활성화하거나 구성하지 않습니다/);
});

test('access and team guidance distinguishes draft submission from verified publication', () => {
  const english = text('docs/02-administration.md').split('## Users And Groups')[1].split('## Notifications')[0];
  const korean = text('docs/02-administration_ko.md').split('## 사용자와 그룹')[1].split('## 알림')[0];
  assert.match(english, /entitlement form saves one change as a draft/);
  assert.match(english, /Saving does not change active access/);
  assert.match(english, /team mapping as a draft, not an active mapping/);
  assert.match(english, /\[Publishing\]\(#publishing\)/);
  assert.doesNotMatch(english, /applies and publishes/);
  assert.match(korean, /이용 권한 폼은 변경 한 건을 초안으로 저장/);
  assert.match(korean, /저장만으로 활성 이용 권한이 바뀌지는 않습니다/);
  assert.match(korean, /팀 매핑을 초안으로 저장하며, 활성 매핑은 바뀌지 않습니다/);
  assert.match(korean, /\[게시\]\(#게시\)/);
  assert.doesNotMatch(korean, /한 단계로 적용되고 게시/);
});

test('entitlement guidance explains editable limits without implying draft activation', () => {
  const english = text('docs/02-administration.md');
  const korean = text('docs/02-administration_ko.md');
  assert.match(english, /requests per minute, tokens per minute, token quota, and quota period/);
  assert.match(english, /clearing its field does not remove the persisted limit/);
  assert.match(english, /subject or application key used by the gateway/);
  assert.match(english, /still shows the active binding, not the draft's proposed values/);
  assert.match(korean, /분당 요청 수, 분당 토큰 수, 토큰 쿼터와 기간/);
  assert.match(korean, /필드를 비워도 저장된 한도는 제거되지 않습니다/);
  assert.match(korean, /게이트웨이가 사용하는 subject 또는 application 키/);
  assert.match(korean, /초안의 제안 값이 아니라 활성 바인딩의 값/);
  for (const guide of [english, korean]) {
    assert.match(guide, /state: revoked/);
    assert.match(guide, /state: active/);
  }
  assert.match(english, /does \*\*not\*\* create Microsoft Entra app-role assignments/);
  assert.match(english, /authoring remains available independently/);
  assert.match(english, /removal validation also checks revoked bindings/);
  assert.match(korean, /Microsoft Entra 앱 역할을 할당하거나 관리 콘솔·API 접근 권한을 부여하지 않습니다/);
  assert.match(korean, /이 조회와 독립적으로 제공되며/);
  assert.match(korean, /제거 검증은 철회된 바인딩도 확인/);
});

test('fallback guidance distinguishes editable single-hop plans from reference-only exhaustion behavior', () => {
  const english = text('docs/02-administration.md');
  const korean = text('docs/02-administration_ko.md');
  for (const guide of [english, korean]) {
    assert.match(guide, /maxDepth: 1/);
    assert.match(guide, /onExhausted: deny/);
    assert.match(guide, /32/);
  }
  assert.match(english, /Reordering unchanged connections is not a policy change/);
  assert.match(english, /not implemented in the deployed effective-policy\/APIM path/);
  assert.match(korean, /같은 연결의 순서만 바꾸는 것은 정책 변경이 아닙니다/);
  assert.match(korean, /배포된 유효 정책·APIM 경로에 구현되어 있지 않으며/);
});
