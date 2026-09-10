import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { bundledPackageNotices } from '../../tools/build-admin-ui.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const testWorkspaceRoot = join(repositoryRoot, 'tests', 'distribution', '.test-work');

async function createFixture(t) {
  await mkdir(testWorkspaceRoot, { recursive: true });
  const root = await mkdtemp(join(testWorkspaceRoot, 'bundle-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createPackage(root, name, version, files = {}) {
  const directory = join(root, 'node_modules', ...name.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version }));
  await Promise.all(Object.entries(files).map(([file, contents]) => writeFile(join(directory, file), contents)));
}

function metafile(inputs) {
  return {
    outputs: {
      'public/vendor/entra-session.js': { inputs },
    },
  };
}

test('bundled notices preserve every upstream notice source for emitted packages', async (t) => {
  const root = await createFixture(t);
  await createPackage(root, '@fixture/multiple', '1.2.3', {
    LICENSE: 'fixture license\n',
    'LICENSE-APACHE': 'fixture apache license\n',
    'NOTICE.md': 'fixture notice\n',
    COPYING: 'fixture copying\n',
    COPYRIGHT: 'fixture copyright\n',
  });

  const notices = await bundledPackageNotices({
    metafile: metafile({
      'node_modules/@fixture/multiple/index.js': { bytesInOutput: 10 },
      'node_modules/not-emitted/index.js': { bytesInOutput: 0 },
    }),
    outputPath: 'public/vendor/entra-session.js',
    absWorkingDir: root,
  });

  assert.match(notices, /Package: @fixture\/multiple\nVersion: 1.2.3/);
  for (const text of ['fixture license', 'fixture apache license', 'fixture notice', 'fixture copying', 'fixture copyright']) {
    assert.match(notices, new RegExp(text));
  }
  assert.doesNotMatch(notices, /not-emitted/);
});

test('bundled notices fail closed for missing license evidence or package metadata', async (t) => {
  const root = await createFixture(t);
  await createPackage(root, 'missing-license', '1.0.0');
  await createPackage(root, 'missing-version', '', { LICENSE: 'license\n' });
  await createPackage(root, 'notice-only', '1.0.0', { NOTICE: 'Attribution only\n' });
  await createPackage(root, 'empty-license', '1.0.0', { LICENSE: ' \n', NOTICE: 'Attribution only\n' });

  await assert.rejects(
    bundledPackageNotices({
      metafile: metafile({ 'node_modules/missing-license/index.js': { bytesInOutput: 1 } }),
      outputPath: 'public/vendor/entra-session.js',
      absWorkingDir: root,
    }),
    /No upstream license or notice file found for bundled package missing-license@1.0.0/,
  );
  await assert.rejects(
    bundledPackageNotices({
      metafile: metafile({ 'node_modules/missing-version/index.js': { bytesInOutput: 1 } }),
      outputPath: 'public/vendor/entra-session.js',
      absWorkingDir: root,
    }),
    /Bundled package metadata must include a name and version/,
  );
  for (const name of ['notice-only', 'empty-license']) {
    await assert.rejects(
      bundledPackageNotices({
        metafile: metafile({ [`node_modules/${name}/index.js`]: { bytesInOutput: 1 } }),
        outputPath: 'public/vendor/entra-session.js',
        absWorkingDir: root,
      }),
      /No nonempty upstream license file found/,
    );
  }
});
