/**
 * How long an authored governance snapshot carries authority.
 *
 * Authored policy does not decay: a budget an operator set is as true a week later as
 * it was when they saved it. The expiry is a liveness contract on whatever publishes
 * the set, so that a snapshot stops governing if publication stops entirely — not a
 * freshness claim about the content. It is therefore far longer than the interval
 * between manual publications, because a shorter window means one console edit takes
 * all inference to the deployment default the moment it lapses.
 *
 * Evidence keeps a separately declared window. Membership is credential-bound, live
 * provider readings are not stored, and the model registry declares its own publication
 * liveness contract beside its capture logic. Nothing here silently sets those windows.
 */
export const AUTHORED_POLICY_RETENTION_SECONDS = 30 * 24 * 3600;
