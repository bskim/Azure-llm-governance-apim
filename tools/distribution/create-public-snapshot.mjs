import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  formatFindings,
  isPublicSnapshotPath,
  readEntry,
  resolveSupplement,
  scanEntries,
  selectPublicSnapshotPaths,
} from './public-boundary-scan.mjs';

function readGitPaths(root, args, run, operation) {
  const listed = run('git', args, {
    cwd: root,
    encoding: 'utf8',
  });
  if (listed.status !== 0) {
    throw new Error(`git ${operation} failed: ${listed.stderr?.trim() || 'unknown error'}`);
  }
  return listed.stdout.split('\0').filter(Boolean);
}

/**
 * The snapshot is always sourced from Git's tracked inventory. Untracked files are
 * checked separately so a likely release input cannot be silently omitted.
 */
export function readSnapshotCandidatePaths(root, run = spawnSync) {
  return readGitPaths(root, ['ls-files', '-z', '--cached'], run, 'snapshot inventory');
}

export function readReleaseBoundaryState(root, run = spawnSync) {
  return Object.freeze({
    modified: Object.freeze(readGitPaths(root, ['diff', '--name-only', '-z'], run, 'working-tree check')),
    staged: Object.freeze(readGitPaths(root, ['diff', '--cached', '--name-only', '-z'], run, 'index check')),
    untracked: Object.freeze(readGitPaths(
      root,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      run,
      'untracked-file check',
    )),
  });
}

export function assertReleaseBoundaryClean(root, run = spawnSync) {
  const state = readReleaseBoundaryState(root, run);
  const changed = selectPublicSnapshotPaths([...state.modified, ...state.staged]);
  if (changed.length > 0) {
    throw new Error(`source has modified publishable path: ${changed[0]}`);
  }

  const candidates = selectPublicSnapshotPaths(state.untracked);
  if (candidates.length > 0) {
    throw new Error(`source has untracked publishable candidate: ${candidates[0]}`);
  }
  return state;
}

export function materializePublicSnapshot({ root, output, paths }) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('root is required.');
  if (typeof output !== 'string' || output.length === 0) throw new TypeError('output is required.');
  if (!Array.isArray(paths)) throw new TypeError('paths is required.');

  const sourceRoot = path.resolve(root);
  const outputRoot = path.resolve(output);
  if (sourceRoot === outputRoot) throw new TypeError('output must differ from the repository root.');
  if (existsSync(outputRoot)) {
    throw new Error('output already exists; remove it explicitly so stale files cannot enter the snapshot.');
  }

  const selected = selectPublicSnapshotPaths(paths);
  mkdirSync(outputRoot, { recursive: true });
  for (const relativePath of selected) {
    const source = path.join(sourceRoot, relativePath);
    const stat = lstatSync(source);
    if (!stat.isFile()) throw new Error(`tracked path is not a regular file: ${relativePath}`);
    const destination = path.join(outputRoot, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }

  return Object.freeze({ output: outputRoot, files: Object.freeze(selected) });
}

function listMaterializedPaths(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!isPublicSnapshotPath(`${relative}/`)) {
          throw new Error('materialized snapshot contains an excluded path.');
        }
        walk(absolute);
      } else if (entry.isFile()) {
        if (!isPublicSnapshotPath(relative)) {
          throw new Error('materialized snapshot contains an excluded path.');
        }
        files.push(relative);
      } else {
        throw new Error('materialized snapshot contains a non-regular filesystem entry.');
      }
    }
  };
  walk(root);
  return files.sort();
}

export function scanMaterializedPublicSnapshot({ root, output, paths }) {
  const actual = listMaterializedPaths(output);
  const expected = selectPublicSnapshotPaths(paths);
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw new Error('materialized snapshot file inventory differs from the reviewed tracked inventory.');
  }

  const supplement = resolveSupplement(root);
  if (supplement.state === 'missing') {
    throw new Error(`public-boundary supplement is unreadable: ${supplement.reason}`);
  }
  const report = scanEntries(
    actual.map((relativePath) => readEntry(output, relativePath, 'tracked')),
    supplement,
  );
  if (report.findings.length > 0) {
    throw new Error(formatFindings(report));
  }
  return Object.freeze(report);
}

export function createPublicSnapshot({ root, output, run = spawnSync }) {
  assertReleaseBoundaryClean(root, run);
  const paths = readSnapshotCandidatePaths(root, run);
  const snapshot = materializePublicSnapshot({
    root,
    output,
    paths,
  });
  try {
    const scan = scanMaterializedPublicSnapshot({ root, output: snapshot.output, paths });
    return Object.freeze({ ...snapshot, scan });
  } catch (error) {
    rmSync(snapshot.output, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--output' || argv[1].length === 0) {
    throw new TypeError('usage: node tools/distribution/create-public-snapshot.mjs --output <directory>');
  }
  return { output: argv[1] };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    const { output } = parseArguments(process.argv.slice(2));
    const root = process.cwd();
    const result = createPublicSnapshot({ root, output: path.resolve(root, output) });
    process.stdout.write(`Public snapshot: ${result.files.length} files in ${result.output}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
