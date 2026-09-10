import { randomBytes } from 'node:crypto';

/**
 * What a deployment needs to run a recovering schedule.
 *
 * A schedule that recovers has to answer two questions the ordinary timer does not:
 * where it starts when nothing has run yet, and which runner is holding the lease.
 * Both are read from configuration rather than assumed, because a value that changes
 * per restart would make two instances look like one and a checkpoint look like a gap.
 */

const SAFE_CODE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Only consulted when no checkpoint exists. Aligning to the window boundary matters
 * because an unaligned start produces different document identifiers for the same
 * period depending on when the schedule happened to be created.
 */
export function resolveStartedFrom(environment, clock, windowSeconds) {
  const configured = environment.ROLLUP_STARTED_FROM;
  if (configured) {
    const parsed = Date.parse(configured);
    if (Number.isNaN(parsed)) throw new TypeError('ROLLUP_STARTED_FROM must be an ISO-8601 instant.');
    if (parsed % (windowSeconds * 1000) !== 0) {
      throw new TypeError('ROLLUP_STARTED_FROM must sit on a window boundary.');
    }
    return new Date(parsed).toISOString();
  }
  const windowMs = windowSeconds * 1000;
  return new Date(Math.floor(Date.parse(clock.nowIso()) / windowMs) * windowMs).toISOString();
}

/**
 * The lease is only useful if two runners produce different owners, so a shared
 * platform value is preferred and a per-process value is the fallback.
 */
export function resolveOwnerCode(environment = process.env) {
  const instance = environment.WEBSITE_INSTANCE_ID ?? environment.CONTAINER_APP_REPLICA_NAME ?? '';
  const candidate = instance.slice(0, 32);
  if (SAFE_CODE.test(candidate)) return `worker-${candidate}`;
  return `worker-${randomBytes(8).toString('hex')}`;
}
