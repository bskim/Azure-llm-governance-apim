/**
 * Reads a closed usage window out of API Management resource logs.
 *
 * Token counts and attribution live in two different tables. The LLM log knows
 * how many tokens a request spent but nothing about who spent them; the gateway
 * log carries the governance trace records but no token counts. Only the
 * correlation identifier joins them, so that join is the whole design.
 */

const QUERY_SCOPE = 'https://api.loganalytics.io/.default';
const DEFAULT_ENDPOINT = 'https://api.loganalytics.io';
const REFUSAL_STATUS_CODES = Object.freeze([403, 429]);

function fail(message) {
  throw new TypeError(message);
}

/**
 * Attribution metadata is lifted with `bag_merge` because the published schema
 * documents `TraceRecords` only as "records emitted by trace policies" and does
 * not fix where metadata sits within a record. Merging the record with its own
 * metadata bag reads correctly whether the properties are nested or flattened.
 */
export function buildUsageWindowQuery({ apiId, rowLimit }) {
  // The identifier is interpolated into the query, so it is constrained to the API
  // Management name alphabet rather than trusted because it arrives as configuration.
  if (typeof apiId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(apiId)) {
    fail('apiId must be an API Management API name.');
  }
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1) fail('rowLimit must be a positive integer.');

  return `
let refusalCodes = dynamic([${REFUSAL_STATUS_CODES.join(', ')}]);
let attribution =
    ApiManagementGatewayLogs
    | where ApiId == '${apiId}'
    | mv-apply record = TraceRecords on (
        where tostring(record.source) startswith 'llm-governance'
        | project bag = bag_merge(record, todynamic(record.metadata))
    )
    | summarize
        TeamKey = take_anyif(
          tostring(bag.TeamKey),
          isnotempty(tostring(bag.TeamKey)) and tostring(bag.TeamKey) != 'not-single-team'),
        SubjectKey = take_anyif(tostring(bag.SubjectKey), isnotempty(tostring(bag.SubjectKey))),
        ApplicationKey = take_anyif(tostring(bag.ApplicationKey), isnotempty(tostring(bag.ApplicationKey))),
        RequestedModel = take_anyif(tostring(bag.RequestedModel), isnotempty(tostring(bag.RequestedModel))),
        EffectiveModel = take_anyif(tostring(bag.EffectiveModel), isnotempty(tostring(bag.EffectiveModel))),
        // What the gateway charged against the quota, whether or not the exchange
        // finished. Kept separate from the usage log so a completed request still
        // prefers the provider's own count.
        GatewayTokens = max(tolong(bag.ConsumedTokens)),
        Completed = take_anyif(tostring(bag.Completed), isnotempty(tostring(bag.Completed))),
        ResponseCode = take_any(ResponseCode),
        // The earliest entry is when the request arrived; a later one is the same
        // request still being written, and would move the record between reads.
        ObservedAt = min(TimeGenerated)
        by CorrelationId;
let usage =
    ApiManagementGatewayLlmLog
    // A message split across entries repeats the same totals, so the maximum is the
    // request total and a sum would count it twice.
    | summarize PromptTokens = max(PromptTokens), CompletionTokens = max(CompletionTokens)
        by CorrelationId;
attribution
| join kind=leftouter (usage) on CorrelationId
| extend
    // A row can exist and still carry nothing, which a null check alone would read as
    // a provider figure of zero. Absent and empty are the same answer here: the
    // provider did not say. Deployed data shows both shapes.
    NoProviderUsage = isnull(PromptTokens)
        or (coalesce(PromptTokens, long(0)) == 0 and coalesce(CompletionTokens, long(0)) == 0)
| extend
    // A request the provider never reported on, but which the gateway charged for, is
    // an abandoned stream. The gateway's figure is its own prompt estimate at that
    // point, so it is recorded as prompt and as an estimate. Reporting zero would hide
    // budget that was actually spent.
    Abandoned = NoProviderUsage and coalesce(GatewayTokens, long(0)) > 0
| project
    correlationId = tostring(CorrelationId),
    observedAt = ObservedAt,
    teamKey = TeamKey,
    subjectKey = SubjectKey,
    applicationKey = ApplicationKey,
    requestedModel = RequestedModel,
    effectiveModel = coalesce(EffectiveModel, RequestedModel),
    promptTokens = iff(Abandoned, GatewayTokens, coalesce(PromptTokens, long(0))),
    completionTokens = iff(Abandoned, long(0), coalesce(CompletionTokens, long(0))),
    outcome = iff(set_has_element(refusalCodes, ResponseCode), 'refused', 'served'),
    // The quality has to describe the number this row actually carries. Where the
    // provider reported, that number is the provider's own and is reported, whatever
    // the gateway thought of its parallel estimate; the gateway's self-assessment
    // describes a figure that is only used on the abandoned path. A refused request
    // never reached a model, so it has no usage to qualify and must not drag a
    // window's quality down to mixed.
    tokenQuality = case(
        set_has_element(refusalCodes, ResponseCode), 'unknown',
        Abandoned, 'estimated',
        NoProviderUsage, 'unknown',
        'reported'),
    exchangeState = iff(Abandoned, 'abandoned', iff(Completed == 'False', 'failed', 'complete'))
| where isnotempty(effectiveModel)
| take ${rowLimit}
`.trim();
}

function readTable(payload) {
  const table = payload?.tables?.find((candidate) => candidate.name === 'PrimaryResult') ?? payload?.tables?.[0];
  if (!table) fail('The query response contained no result table.');
  const index = new Map(table.columns.map((column, position) => [column.name, position]));
  return (table.rows ?? []).map((row) => {
    const value = (name) => row[index.get(name)];
    return {
      correlationId: value('correlationId') ?? '',
      observedAt: value('observedAt') ?? '',
      teamKey: value('teamKey') || null,
      subjectKey: value('subjectKey') ?? '',
      applicationKey: value('applicationKey') ?? '',
      requestedModel: value('requestedModel') ?? '',
      effectiveModel: value('effectiveModel') ?? '',
      promptTokens: Number(value('promptTokens') ?? 0),
      completionTokens: Number(value('completionTokens') ?? 0),
      outcome: value('outcome') ?? 'served',
      tokenQuality: value('tokenQuality') ?? 'unknown',
      exchangeState: value('exchangeState') ?? 'complete',
    };
  });
}

function createTokenSender({ credential, endpoint }) {
  return async function sendQuery({ workspaceId, query, timespan }) {
    const token = await credential.getToken(QUERY_SCOPE);
    const response = await fetch(`${endpoint}/v1/workspaces/${workspaceId}/query`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, timespan }),
    });
    return { status: response.status, body: await response.json() };
  };
}

export function createLogAnalyticsUsageQuery({
  workspaceId,
  apiId,
  credential,
  sendQuery,
  rowLimit = 500_000,
  endpoint = DEFAULT_ENDPOINT,
} = {}) {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) fail('workspaceId is required.');
  const send = sendQuery ?? (credential ? createTokenSender({ credential, endpoint }) : null);
  if (typeof send !== 'function') fail('Either a credential or a sendQuery function is required.');

  const query = buildUsageWindowQuery({ apiId, rowLimit });

  /**
   * A failed read reports an unavailable source rather than an empty window. The
   * projector then writes a degraded document, so a reader can tell a broken
   * query apart from an hour in which nobody called the gateway.
   */
  async function readWindow({ windowStart, windowEnd }) {
    const timespan = `${windowStart}/${windowEnd}`;
    // A revision is carried into the rollup document identifier's neighbourhood, so it
    // is restricted to the same conservative alphabet the document contract allows.
    const unavailable = (detail) => ({
      rows: [],
      state: 'unavailable',
      rowCount: 0,
      rowLimit,
      revision: `unavailable.${detail}:${windowStart}`,
    });

    let result;
    try {
      result = await send({ workspaceId, query, timespan });
    } catch (error) {
      return unavailable(error?.name ?? 'request-failed');
    }

    if (result.status !== 200) return unavailable(`status-${result.status}`);
    // A partial result is still a wrong answer for an accounting window.
    if (result.body?.error) return unavailable('partial-result');

    const rows = readTable(result.body);
    return {
      rows,
      state: 'complete',
      rowCount: rows.length,
      rowLimit,
      revision: `apim-gateway-logs.apim-gateway-llm-log:${windowStart}`,
    };
  }

  return Object.freeze({ readWindow, query });
}
