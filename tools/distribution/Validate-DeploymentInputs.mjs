#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStartedFrom } from '../../app/functions/schedule-configuration.mjs';
import {
  validateCreateOnlyPreflight,
  validateBootstrapContinuation,
  validateVerificationContinuation,
  verifyManifest,
  parseSecondModelDeployments,
} from '../deployment/ownership-contract.mjs';

export const FC1_SCALE_CONTRACT = Object.freeze({
  instanceMemoryMB: 2048,
  maximumInstanceCount: 28,
  hardCeiling: 35,
  alwaysReadyReserve: 1,
  httpScaleGroups: 1,
  timerScaleGroups: 6,
  regionalDefaultCores: 250,
});

function parsePositiveInteger(value, fallback, errorCode) {
  const candidate = typeof value === 'string' && value.trim().length > 0 ? value.trim() : String(fallback);
  if (!/^[1-9]\d*$/.test(candidate)) throw new TypeError(errorCode);
  return Number(candidate);
}

function parseNonNegativeInteger(value, fallback, errorCode) {
  const candidate = typeof value === 'string' && value.trim().length > 0 ? value.trim() : String(fallback);
  if (!/^\d+$/.test(candidate)) throw new TypeError(errorCode);
  return Number(candidate);
}

export function validateFc1ScaleBudget(environment = process.env) {
  const maximumInstanceCount = parsePositiveInteger(
    environment.CONTROL_PLANE_MAXIMUM_INSTANCE_COUNT,
    FC1_SCALE_CONTRACT.maximumInstanceCount,
    'fc1-maximum-instance-count-must-be-a-positive-integer',
  );
  const instanceMemoryMB = parsePositiveInteger(
    environment.CONTROL_PLANE_INSTANCE_MEMORY_MB,
    FC1_SCALE_CONTRACT.instanceMemoryMB,
    'fc1-instance-memory-mb-must-be-a-positive-integer',
  );
  const alwaysReadyReserve = parseNonNegativeInteger(
    environment.CONTROL_PLANE_ALWAYS_READY_INSTANCES,
    FC1_SCALE_CONTRACT.alwaysReadyReserve,
    'fc1-always-ready-instances-must-be-a-non-negative-integer',
  );

  if (instanceMemoryMB !== FC1_SCALE_CONTRACT.instanceMemoryMB) {
    throw new TypeError('fc1-instance-memory-contract-requires-2048');
  }
  if (alwaysReadyReserve > 10) throw new TypeError('fc1-always-ready-instances-exceeds-bicep-ceiling-10');
  if (maximumInstanceCount > FC1_SCALE_CONTRACT.hardCeiling) {
    throw new TypeError('fc1-maximum-instance-count-exceeds-repository-hard-ceiling-35');
  }
  if (maximumInstanceCount > FC1_SCALE_CONTRACT.maximumInstanceCount) {
    throw new TypeError('fc1-quota-approval-evidence-required-for-maximum-instance-count-above-28');
  }

  const scaleGroupCount = FC1_SCALE_CONTRACT.httpScaleGroups + FC1_SCALE_CONTRACT.timerScaleGroups;
  const worstCaseCores = alwaysReadyReserve + (scaleGroupCount * maximumInstanceCount);
  const regionalDefaultMarginCores = FC1_SCALE_CONTRACT.regionalDefaultCores - worstCaseCores;
  if (regionalDefaultMarginCores < 0) throw new TypeError('fc1-core-budget-exceeds-documented-regional-default');

  return Object.freeze({
    instanceMemoryMB,
    maximumInstanceCount,
    scaleGroupCount,
    alwaysReadyReserve,
    worstCaseCores,
    regionalDefaultMarginCores,
  });
}

export function validateRollupStartedFrom(environment = process.env) {
  const configured = environment.ROLLUP_STARTED_FROM;
  if (configured === undefined || configured === '') return null;
  return resolveStartedFrom(
    environment,
    { nowIso: () => '1970-01-01T00:00:00.000Z' },
    3_600,
  );
}

export function validateNotificationWebhookSecretName(environment = process.env) {
  const configured = environment.NOTIFICATION_WEBHOOK_SECRET_NAME;
  if (configured === undefined || configured === '') return null;
  if (typeof configured !== 'string' || !/^[0-9A-Za-z-]{1,127}$/.test(configured)) {
    throw new TypeError('notification-webhook-secret-name-must-be-a-key-vault-secret-name');
  }
  return configured;
}

function sha256File(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function validateCreateOnlyContract(environment, now) {
  const preflightPath = environment.OWNERSHIP_PREFLIGHT_FILE?.trim();
  if (!preflightPath) throw new TypeError('create-only-preflight-required');
  const absolutePreflightPath = resolve(preflightPath);
  let preflight;
  try {
    preflight = JSON.parse(readFileSync(absolutePreflightPath, 'utf8'));
  } catch (error) {
    throw new TypeError(`create-only-preflight-invalid: ${error.message}`);
  }
  const planPath = environment.OWNERSHIP_PLAN_FILE?.trim();
  if (!planPath) throw new TypeError('create-only-plan-required');
  const stage = environment.OWNERSHIP_VALIDATION_STAGE?.trim() || 'postprovision';
  if (!['bootstrap', 'postprovision'].includes(stage)) throw new TypeError('create-only-validation-stage-invalid');
  const preflightResult = validateCreateOnlyPreflight(preflight, environment, sha256File(planPath), now);
  const evidencePaths = {
    manifest: environment.OWNERSHIP_MANIFEST_FILE?.trim(),
    state: environment.OWNERSHIP_STATE_FILE?.trim(),
    readback: environment.OWNERSHIP_READBACK_FILE?.trim(),
  };
  for (const [name, path] of Object.entries(evidencePaths)) {
    if (!path) throw new TypeError(`create-only-${name}-required`);
  }
  let manifest;
  let state;
  let readback;
  try {
    manifest = verifyManifest(JSON.parse(readFileSync(resolve(evidencePaths.manifest), 'utf8')));
    state = JSON.parse(readFileSync(resolve(evidencePaths.state), 'utf8'));
    readback = JSON.parse(readFileSync(resolve(evidencePaths.readback), 'utf8'));
  } catch (error) {
    throw new TypeError(`create-only-ownership-evidence-invalid: ${error.message}`);
  }
  const continuation = stage === 'bootstrap'
    ? validateBootstrapContinuation(preflight, manifest, state, readback, now)
    : validateVerificationContinuation(preflight, manifest, state, readback, now);
  return Object.freeze({
    ...preflightResult,
    stage,
    ...continuation,
  });
}

export function validateDeploymentInputs(environment = process.env, now = new Date()) {
  const fc1 = validateFc1ScaleBudget(environment);
  validateRollupStartedFrom(environment);
  validateNotificationWebhookSecretName(environment);
  const mode = environment.PRINCIPAL_KEY_MODE?.trim() || 'direct';
  const direct = typeof environment.PRINCIPAL_DERIVATION_SECRET === 'string'
    && environment.PRINCIPAL_DERIVATION_SECRET.trim().length > 0;
  const store = typeof environment.PRINCIPAL_KEY_STORE_NAME === 'string'
    && environment.PRINCIPAL_KEY_STORE_NAME.trim().length > 0;
  const secret = typeof environment.PRINCIPAL_KEY_SECRET_NAME === 'string'
    && environment.PRINCIPAL_KEY_SECRET_NAME.trim().length > 0;

  if (!['direct', 'existing'].includes(mode)) throw new TypeError('principal-key-mode-invalid');
  if (mode === 'direct' && (store || secret)) throw new TypeError('principal-key-direct-carries-existing-input');
  if (mode === 'direct' && !direct) throw new TypeError('principal-key-direct-secret-required');
  if (mode === 'existing' && direct) throw new TypeError('principal-key-existing-carries-direct-secret');
  if (mode === 'existing' && (!store || !secret)) throw new TypeError('principal-key-existing-incomplete');
  const secondModelDeployments = parseSecondModelDeployments(environment);
  if (secondModelDeployments.length > 0 && environment.CREATE_FOUNDRY?.trim() !== 'true') {
    throw new TypeError('second-model-deployments-require-create-foundry');
  }
  const createOnly = environment.CREATE_ONLY_OWNERSHIP_VALIDATION?.trim().toLowerCase() === 'true'
    ? validateCreateOnlyContract(environment, now)
    : null;
  return Object.freeze({
    mode, configured: direct || mode === 'existing', fc1, secondModelDeployments, createOnly,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = validateDeploymentInputs();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}