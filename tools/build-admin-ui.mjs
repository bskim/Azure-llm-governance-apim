import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

/**
 * Bundles the browser-side authentication implementation and, for a deployment,
 * writes the configuration that selects it.
 *
 * Only the authentication module is bundled. The rest of the console stays plain ES
 * modules served as written, so a reader can open a screen file and see exactly what
 * runs.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = join(repositoryRoot, 'app/admin-ui/public');
const configPath = join(publicRoot, 'admin-config.json');
const noticePath = join(publicRoot, 'vendor/THIRD-PARTY-NOTICES.txt');

function packageRootForBundledInput(inputPath, absWorkingDir) {
  const absoluteInputPath = resolve(absWorkingDir, inputPath);
  const marker = `${sep}node_modules${sep}`;
  const nodeModulesIndex = absoluteInputPath.lastIndexOf(marker);
  if (nodeModulesIndex < 0) return null;

  const packageParts = absoluteInputPath.slice(nodeModulesIndex + marker.length).split(sep);
  const packageLength = packageParts[0]?.startsWith('@') ? 2 : 1;
  if (packageParts.length < packageLength) {
    throw new Error(`Cannot determine package root for bundled input: ${inputPath}`);
  }
  return join(absoluteInputPath.slice(0, nodeModulesIndex + marker.length), ...packageParts.slice(0, packageLength));
}

export async function bundledPackageNotices({ metafile, outputPath, absWorkingDir }) {
  const output = metafile.outputs[outputPath];
  if (!output) throw new Error(`Cannot find bundled output in metafile: ${outputPath}`);
  const packageRoots = new Set(
    Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([inputPath]) => packageRootForBundledInput(inputPath, absWorkingDir))
      .filter((packageRoot) => packageRoot !== null),
  );
  const packages = await Promise.all(
    [...packageRoots].map(async (packageRoot) => {
      const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      if (
        typeof packageJson.name !== 'string'
        || packageJson.name.trim().length === 0
        || typeof packageJson.version !== 'string'
        || packageJson.version.trim().length === 0
      ) {
        throw new Error(`Bundled package metadata must include a name and version: ${packageRoot}`);
      }
      const licenseFiles = (await readdir(packageRoot))
        .filter((name) => /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].+)?$/i.test(name))
        .sort((left, right) => left.localeCompare(right));
      if (licenseFiles.length === 0) {
        throw new Error(`No upstream license or notice file found for bundled package ${packageJson.name}@${packageJson.version}.`);
      }
      const sources = await Promise.all(
        licenseFiles.map(async (licenseFile) => ({
          licenseFile,
          licenseText: await readFile(join(packageRoot, licenseFile), 'utf8'),
        })),
      );
      if (!sources.some(({ licenseFile, licenseText }) =>
        /^(?:licen[cs]e|copying)(?:[._-].+)?$/i.test(licenseFile) && licenseText.trim().length > 0)) {
        throw new Error(`No nonempty upstream license file found for bundled package ${packageJson.name}@${packageJson.version}.`);
      }
      return { name: packageJson.name, version: packageJson.version, sources };
    }),
  );

  return packages
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(
      ({ name, version, sources }) =>
        `Package: ${name}\nVersion: ${version}\n\n${sources
          .map(({ licenseFile, licenseText }) => `Upstream license file: ${licenseFile}\n\n${licenseText}`)
          .join('\n')}\n`,
    )
    .join('\n');
}

export async function buildAdminUi() {
  const bundlePath = join(publicRoot, 'vendor/entra-session.js');
  const metafileOutputPath = relative(repositoryRoot, bundlePath).split(sep).join('/');
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [join(repositoryRoot, 'app/admin-ui/src/entra-session.mjs')],
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    metafile: true,
    write: false,
  });

  const output = result.metafile.outputs[metafileOutputPath];
  if (!output) throw new Error(`Cannot find generated bundle output: ${bundlePath}`);
  const notices = await bundledPackageNotices({
    metafile: result.metafile,
    outputPath: metafileOutputPath,
    absWorkingDir: repositoryRoot,
  });
  const bundle = result.outputFiles.find((file) => file.path === bundlePath);
  if (!bundle) throw new Error(`Cannot find generated bundle file: ${bundlePath}`);

  await mkdir(dirname(bundlePath), { recursive: true });
  await writeFile(noticePath, `THIRD-PARTY NOTICES\n\n${notices}`, 'utf8');
  await writeFile(bundlePath, bundle.contents);
  console.log(`${bundlePath} ${(output.bytes / 1024).toFixed(1)} kB`);
  console.log(`${noticePath} written`);
}

async function writeConfiguration() {
  const deployment = {
    clientId: process.env.ENTRA_ADMIN_SPA_APPLICATION_ID,
    tenantId: process.env.ENTRA_TENANT_ID,
    scope: process.env.ENTRA_ADMIN_API_SCOPE,
    apiBaseUrl: process.env.CONTROL_PLANE_ENDPOINT,
  };
  const missing = Object.entries(deployment)
    .filter(([, value]) => typeof value !== 'string' || value.length === 0)
    .map(([name]) => name);

  // A partially configured console would sign a caller in and then fail every request,
  // so it is written only when every value is present. Absent means local, which the
  // console already treats as having no identity provider.
  if (missing.length === 0) {
    // The authority host is configurable because a sovereign cloud does not sign in
    // at the public one.
    const authorityHost = process.env.ENTRA_AUTHORITY_HOST ?? 'https://login.microsoftonline.com';
    const providerResourceId =
      process.env.PROVIDER_ACCOUNT_RESOURCE_ID ?? process.env.FOUNDRY_ACCOUNT_RESOURCE_ID;
    const providerRoutesAvailable =
      /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/]+$/i
        .test(providerResourceId ?? '');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          mode: 'entra',
          clientId: deployment.clientId,
          authority: `${authorityHost.replace(/\/$/, '')}/${deployment.tenantId}`,
          scope: deployment.scope,
          apiBaseUrl: deployment.apiBaseUrl,
          capabilities: {
            modelAuthoring: providerRoutesAvailable,
            modelPrices: providerRoutesAvailable,
          },
          // Only screens the deployed API actually serves. A gate checks this list
          // against the routes the host registers, so it follows the host.
          screens: [
            'overview',
            'users-groups',
            'budgets',
            'usage',
            'models',
            'fallback',
            'lifecycle',
            'notifications',
            'audit',
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`${configPath} written for an Entra deployment`);
  } else {
    await rm(configPath, { force: true });
    console.log(`admin-config.json not written; missing ${missing.join(', ')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAdminUi();
  await writeConfiguration();
}
