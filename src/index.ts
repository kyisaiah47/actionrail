// ActionRail: an agent runner for apps that act on a customer's accounts.

export {
  allow,
  stop,
  defineManifest,
  isModelStep,
  type ActionConnector,
  type ActionResult,
  type AgentManifest,
  type AnyManifest,
  type Capability,
  type Caps,
  type Decision,
  type Evidence,
  type Gate,
  type GateCtx,
  type GatePhase,
  type GateVerdict,
  type ModelPrompt,
  type ModelStep,
  type Policy,
  type RuleStep,
  type SourceConnector,
  type StateEvent,
  type Step,
  type TemplateStep,
} from "./manifest.js";
export {
  createRunner,
  RunnerError,
  type DispatchSummary,
  type Overview,
  type PassSummary,
  type Runner,
  type RunnerOptions,
  type TickResult,
} from "./runner.js";
export { MODES, autopilotUnlocked, route, type Mode, type RouteInput, type RouteResult } from "./autonomy.js";
export { addSeconds, capReached, utcDayStart } from "./caps.js";
export { parseModelJson } from "./json.js";
export { cronMatches } from "./schedule.js";
export { cronAuthorized, cronRoute, isCronRequest, secretMatches } from "./cron-auth.js";
export { decideByLabel, firstMatch, hardStop, ruleTable, withinTolerance, type LabelRule, type RuleLabel, type Score, type ScoreRule } from "./rules.js";

export { MemoryStore } from "./store/memory.js";
export { SqlStore, DEFAULT_TABLES, pgQuery, schemaSql, sqliteQuery, type SqlDialect, type SqlQuery, type SqlStoreOptions, type SqlTables } from "./store/sql.js";
export type {
  ArtifactPatch,
  ArtifactRecord,
  ArtifactStatus,
  EventRecord,
  ItemRecord,
  ItemStatus,
  NewEvent,
  Store,
  TenantSettings,
  ThreadRecord,
  UsageRow,
} from "./store/types.js";

export { createProvider, providerFromEnv, type ProviderConfig, type ProviderKind } from "./providers/index.js";
export { openAIProvider, type OpenAIOptions } from "./providers/openai.js";
export { anthropicProvider, type AnthropicOptions } from "./providers/anthropic.js";
export { geminiProvider, type GeminiOptions } from "./providers/gemini.js";
export { stubProvider, type StubProvider, type StubReply } from "./providers/stub.js";
export { ProviderError, isTransient, type CompletionRequest, type CompletionResult, type FetchLike, type ModelProvider } from "./providers/types.js";

export {
  htmlToText,
  mailboxReplyAction,
  mailboxSource,
  stripQuotedReply,
  type InboundMessage,
  type MailRail,
  type OpenMailbox,
  type ReplyArtifact,
  type SendResult,
} from "./connectors/mailbox.js";
export {
  EXPIRY_SLACK_MS,
  GRAPH_BASE,
  GRAPH_SCOPES,
  GraphError,
  MICROSOFT_AUTHORIZE_URL,
  MICROSOFT_TOKEN_URL,
  graphAccessToken,
  graphMailbox,
  graphSendNew,
  headerValue,
  isExampleRecipient,
  mailboxSupportsInbound,
  normalizeGraphMessage,
  type EntraApp,
  type GraphGrant,
  type GraphMailboxOptions,
  type GraphTokenStore,
} from "./connectors/microsoft-graph.js";
export { FakeMailbox, type SentReply } from "./connectors/fake-mailbox.js";

export { newApp, type AppKind, type NewAppOptions } from "./scaffold/new-app.js";
