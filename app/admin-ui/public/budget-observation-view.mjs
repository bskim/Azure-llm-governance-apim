const MAX_DISPLAYED_GAPS = 8;

export function createBudgetObservationDetails(consumption, { createElement, t, formatTime, formatNumber }) {
  const evidence = consumption.observation;
  const unavailable = t('budgetObservation.unavailable');
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? formatNumber(value) : unavailable;
  const interval = (window) => window?.start && window?.end
    ? t('budgetObservation.interval', { start: formatTime(window.start), end: formatTime(window.end) })
    : unavailable;
  const collectionState = (value) => value?.state === 'not-collected'
    ? t('budgetObservation.notCollected')
    : unavailable;
  const details = createElement('details', 'policy-source-list');
  details.append(createElement('summary', null, t('budgetObservation.title')));
  const list = createElement('dl');
  for (const [label, value] of [
    ['requestedVersion', count(evidence?.requestedBudgetVersion)],
    ['requestedWindow', interval(evidence?.requestedWindow)],
    ['latestCompleteWindow', interval(evidence?.latestClosedWindow)],
    ['covered', count(consumption.windowsCovered)],
    ['missing', count(consumption.windowsMissing)],
    ['policyVersion', collectionState(evidence?.policyVersionEvidence)],
    ['counterIdentity', collectionState(evidence?.counterIdentityEvidence)],
  ]) {
    list.append(
      createElement('dt', null, t(`budgetObservation.${label}`)),
      createElement('dd', null, value),
    );
  }
  details.append(list);
  if (evidence?.coverageDetailState === 'summary-only') {
    details.append(createElement('p', 'policy-meta', t('budgetObservation.summaryOnly')));
  } else if (evidence?.missingWindows?.length > 0) {
    details.append(createElement('p', 'policy-meta', t('budgetObservation.gaps')));
    const gaps = createElement('ul');
    for (const start of evidence.missingWindows.slice(0, MAX_DISPLAYED_GAPS)) {
      gaps.append(createElement('li', null, formatTime(start)));
    }
    details.append(gaps);
    if (evidence.missingWindows.length > MAX_DISPLAYED_GAPS) {
      details.append(createElement('p', 'policy-meta', t('budgetObservation.moreGaps', {
        count: formatNumber(evidence.missingWindows.length - MAX_DISPLAYED_GAPS),
      })));
    }
  }
  details.append(
    createElement('p', 'policy-meta', t('budgetObservation.aggregateCaveat')),
    createElement('p', 'policy-meta', t('budgetObservation.versionCaveat')),
  );
  return details;
}
