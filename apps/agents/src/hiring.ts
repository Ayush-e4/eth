/**
 * What other apps (the API's concierge) reuse to hire agents: discover and rank quotes on the
 * open market, pay the chosen agent through a mandate, and record job, receipt and rating.
 */
export { loadIdentities } from "./identities";
export {
  buy,
  type Delivered,
  type Hire,
  type HireDeps,
  recordHire,
} from "./orchestrator/hire";
export {
  awaitJob,
  HireFailed,
  HirePending,
  type JobView,
  readJob,
} from "./orchestrator/job-client";
export { describePriced, fetchInrRates, type InrRates } from "./orchestrator/procure";
export {
  collectQuotes,
  type QuoteDeps,
  type QuoteOption,
  type QuoteRound,
  readBids,
} from "./orchestrator/quotes";
export { TripSchema } from "./trip";
