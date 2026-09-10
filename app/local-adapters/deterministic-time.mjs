export function createFixedClock(isoTimestamp) {
  const timestamp = new Date(isoTimestamp);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError('Fixed clock requires an ISO timestamp.');
  }
  return Object.freeze({
    nowIso() {
      return timestamp.toISOString();
    },
  });
}

export function createSequenceIdGenerator(prefix = 'request-local') {
  if (!/^[A-Za-z0-9._:-]{1,96}$/.test(prefix)) {
    throw new TypeError('ID prefix is not a safe identifier.');
  }
  let sequence = 0;
  return Object.freeze({
    next() {
      sequence += 1;
      return `${prefix}-${String(sequence).padStart(4, '0')}`;
    },
  });
}