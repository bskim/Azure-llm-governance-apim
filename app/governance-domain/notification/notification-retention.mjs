/**
 * How long a notification is kept once somebody has closed it.
 *
 * Only acknowledgement makes a record removable. Age does not: a warning nobody
 * ever saw is exactly the one that must not disappear, and deleting it on a
 * timer would turn an unread alert into a period that looks like it earned none.
 *
 * The audit trail records the notification events separately, so removing a closed
 * record here does not remove the evidence that it happened.
 */

export const RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

function fail(message) {
  throw new TypeError(message);
}

function assertInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
  return value;
}

export function planNotificationRetention({ records, now, retentionDays = RETENTION_DAYS }) {
  if (!Array.isArray(records)) fail('records must be an array.');
  assertInstant(now, 'now');
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    fail('retentionDays must be a positive integer.');
  }

  const expiring = [];
  const retained = [];

  for (const record of records) {
    const entry = { key: record.key, state: record.state };

    if (record.acknowledgedBy === null) {
      retained.push(Object.freeze({ ...entry, reasonCode: 'not-acknowledged' }));
      continue;
    }
    if (typeof record.acknowledgedAt !== 'string' || Number.isNaN(Date.parse(record.acknowledgedAt))) {
      // A record that cannot say when it was closed cannot be shown to be old enough.
      retained.push(Object.freeze({ ...entry, reasonCode: 'acknowledgement-time-unknown' }));
      continue;
    }

    const elapsedDays = (Date.parse(now) - Date.parse(record.acknowledgedAt)) / DAY_MS;
    if (elapsedDays > retentionDays) {
      expiring.push(Object.freeze({ ...entry, reasonCode: 'retention-elapsed' }));
    } else {
      retained.push(Object.freeze({ ...entry, reasonCode: 'within-retention' }));
    }
  }

  return Object.freeze({ expiring: Object.freeze(expiring), retained: Object.freeze(retained) });
}
