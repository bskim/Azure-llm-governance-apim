#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { AzureCliCredential } from '@azure/identity';

import { captureEndpointFingerprint } from '../../app/gateway/endpoint-fingerprint-query.mjs';
import {
  compareEndpointFingerprints,
  renderComparison,
} from '../../app/governance-domain/routing/endpoint-fingerprint.mjs';

/**
 * Captures or compares an endpoint governance fingerprint.
 *
 * Read-only. Every Azure call is a GET, no resource is touched, and no inference or
 * gateway operation is performed, so it consumes no request allowance. Sign in with
 * the Azure CLI first.
 *
 *   node tools/azure/capture-endpoint-fingerprint.mjs capture \
 *     --mode ExplicitApim --subscription <id> --apim-resource-group <rg> --apim <name> \
 *     --api <apiName> --provider-resource-group <rg> --provider-account <name> \
 *     --caller-classes a,b --declaration-source rollback-plan
 *
 *   node tools/azure/capture-endpoint-fingerprint.mjs compare \
 *     --baseline before.json --observed after.json --plan plan.json
 *
 * The plan file declares `restores` and `documentedResiduals` as arrays of
 * `dimension.field` paths. Both are required: a comparison with no declared plan
 * would report every genuine failure as an unexplained change.
 */

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}.`);
    options[flag.slice(2)] = argv[index + 1];
  }
  return options;
}

function compatibilityFrom(options) {
  if (options['caller-classes'] === undefined) return null;
  return {
    callerClasses: options['caller-classes'].split(',').filter((entry) => entry.length > 0),
    declarationSource: options['declaration-source'] ?? 'operator-declaration',
  };
}

async function runCapture(options) {
  const fingerprint = await captureEndpointFingerprint({
    mode: options.mode,
    target: {
      subscriptionId: options.subscription,
      apimResourceGroupName: options['apim-resource-group'],
      apimName: options.apim,
      governedApiName: options.api ?? null,
      providerResourceGroupName: options['provider-resource-group'],
      providerAccountName: options['provider-account'],
      projectName: options.project ?? null,
    },
    compatibility: compatibilityFrom(options),
    credential: new AzureCliCredential(),
  });
  process.stdout.write(`${JSON.stringify(fingerprint, null, 2)}\n`);
}

async function runCompare(options) {
  const [baseline, observed, plan] = await Promise.all([
    readFile(options.baseline, 'utf8').then(JSON.parse),
    readFile(options.observed, 'utf8').then(JSON.parse),
    readFile(options.plan, 'utf8').then(JSON.parse),
  ]);
  const comparison = compareEndpointFingerprints({
    baseline,
    observed,
    restores: plan.restores,
    documentedResiduals: plan.documentedResiduals,
  });
  process.stdout.write(`${renderComparison(comparison)}\n\n`);
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArguments(rest);
  if (command === 'capture') return runCapture(options);
  if (command === 'compare') return runCompare(options);
  throw new Error('The first argument must be capture or compare.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? 'fingerprint-failed'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
