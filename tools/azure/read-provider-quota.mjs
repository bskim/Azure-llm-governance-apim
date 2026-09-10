#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { AzureCliCredential } from '@azure/identity';

import { readProviderQuota } from '../../app/providers/foundry-quota-query.mjs';

/**
 * Reads live provider quota for a Foundry account and prints the snapshot.
 *
 * Read-only: two ARM GETs. It performs no inference call and no gateway operation,
 * so it consumes no request allowance. Sign in with `az login` first.
 *
 *   node tools/azure/read-provider-quota.mjs \
 *     --subscription <id> --resource-group <rg> --account <name> --region <region>
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const snapshot = await readProviderQuota({
    subscriptionId: options.subscription,
    resourceGroupName: options['resource-group'],
    accountName: options.account,
    region: options.region,
    credential: new AzureCliCredential(),
  });
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? 'read-failed'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
