// Mirrors the public shape of teamwork `src/core/types.ts` and
// the dashboard read helpers in `src/core/service.ts`. Keep field names
// in sync: the API returns these directly without any transform.

export type SupportedCli = "codex" | "claude" | "gemini" | "opencode" | "copilot";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type AgentStatusState = "idle" | "busy" | "stopped";

export type AssignmentStatus =
  | "assigned"
  | "in_progress"
  | "blocked"
  | "done"
  | "canceled";

export type WorkItemStatus =
  | "planned"
  | "assigned"
  | "in-progress"
  | "blocked"
  | "done"
  | "canceled";

export type AssignmentClaim = {
  claimId: string;
  sessionId: string;
  workItemId: string;
  agentId: string;
  agentAlias: string;
  claimedAt: string;
  releasedAt?: string;
  releaseReason?: string;
};

export type WorkItem = {
  workItemId: string;
  phaseNumber: number;
  title: string;
  description: string;
  acceptanceCriteria?: string;
  ownerAgentId?: string;
  ownerAlias?: string;
  assigneeAgentIds: string[];
  assigneeAliases: string[];
  primaryAssigneeAgentId?: string;
  status: WorkItemStatus;
  dependsOnIds: string[];
  activeClaims?: AssignmentClaim[];
  createdAt: string;
  updatedAt: string;
};

export type PhaseBoundary = {
  phaseNumber: number;
  title?: string;
  goal?: string;
  startedAt?: string;
  completedAt?: string;
};

export type DeliveryMode = "direct" | "broadcast";

export type WorkerPoolEntry = {
  cli: SupportedCli;
  model: string;
  reasoningEffort?: ReasoningEffort;
};

export type Session = {
  id: string;
  slug: string;
  title?: string;
  parentCli: SupportedCli;
  workerPool: WorkerPoolEntry[];
  createdAt: string;
  status?: "active" | "completed" | "abandoned" | "archived";
  lifecycleStage?: "planning" | "executing" | "integrating" | "finalizing";
  terminalReason?: string;
  currentPhase?: { phaseNumber: number; title: string; goal: string };
  currentFocus?: string;
  openObligationCount?: number;
};

// Thin projection used by `listSessions` for the dashboard list page; mirrors
// `teamwork/src/core/types.ts:SessionSummary`. The full `Session` (with
// workerPool) is reserved for `getSessionDetail`. Kept as the wire shape so
// list rendering doesn't pay for fields it never reads.
export type SessionSummary = {
  id: string;
  slug: string;
  title?: string;
  parentCli: SupportedCli;
  createdAt: string;
  agentCount: number;
  lastActivityAt: string | null;
  status?: "active" | "completed" | "abandoned" | "archived";
  lifecycleStage?: "planning" | "executing" | "integrating" | "finalizing";
  currentPhase?: { phaseNumber: number; title: string; goal: string };
};

export type KillSessionResult = {
  sessionId: string;
  status: "abandoned";
  stoppedCount: number;
  alreadyStoppedCount: number;
  agentCount: number;
  terminalReason: string;
};

export type AgentStatus = {
  state: AgentStatusState;
  summary?: string;
  updatedAt: string;
};

export type AgentRuntime = {
  runtimeId?: string;
  sessionHandle?: string;
  runtimeCommand?: string;
  worktreePath?: string;
  lifecycleState?: "running" | "stopped" | "crashed";
  startedAt?: string;
  updatedAt?: string;
  exitedAt?: string;
  exitCode?: number;
  stdinWritable?: boolean;
  resumeSupported?: boolean;
  inputDelivery?: "stdin" | "resume-command" | "unsupported" | "pty";
  lastOutputAt?: string;
};

export type Heartbeat = {
  agentId: string;
  summary?: string;
  updatedAt: string;
};

export type Agent = {
  agentId: string;
  sessionId: string;
  alias: string;
  specialty: string;
  responsibility?: string;
  cli: SupportedCli;
  model: string;
  reasoningEffort?: ReasoningEffort;
  role?: "parent" | "worker";
  createdAt: string;
  status: AgentStatus;
  runtime?: AgentRuntime;
  heartbeat?: Heartbeat;
};

export type Assignment = {
  id: string;
  sessionId: string;
  agentId: string;
  phase: string;
  summary: string;
  status: AssignmentStatus;
  createdAt: string;
  updatedAt: string;
  activeClaims?: AssignmentClaim[];
};

// NOTE: `senderAlias` and `targetAliases` are NOT raw `MessageRecord` fields —
// the server enriches messages in `teamwork/src/core/service.ts` (see
// `listMessagesPage` ~line 1013) before returning them. The bus payload for
// `message` events does not include the body or aliases (see `BusEventMessage`
// below); clients should re-fetch via `getMessages(sinceId)` for full rows.
export type Message = {
  id: string;
  sessionId: string;
  sequence: number;
  fromAgentId: string;
  toAgentId: string;
  deliveryMode: DeliveryMode;
  summary?: string;
  body: string;
  createdAt: string;
  acknowledged: boolean;
  senderAlias: string;
  targetAliases: string[];
  kind?: "status" | "question" | "answer" | "handoff" | "system";
  requiresResponse?: boolean;
};

export type Result = {
  id: string;
  sessionId: string;
  agentId: string;
  summary: string;
  commitSha?: string;
  createdAt: string;
};

export type Checkpoint = {
  id: string;
  sessionId: string;
  summary: string;
  mergeCommitSha?: string;
  createdAt: string;
};

export type SessionDetail = {
  session: Session;
  agents: Agent[];
  assignments: Assignment[];
  workItems: WorkItem[];
  phases: PhaseBoundary[];
  results: Result[];
  checkpoints: Checkpoint[];
  counts: { messages: number; results: number; agents: number };
};

export type Metrics = {
  sessionsPerDay: Array<{ date: string; count: number }>;
  messagesPerDay: Array<{ date: string; direct: number; broadcast: number }>;
  avgAssignmentDurationSec: number;
  agentUtilization: Array<{ agentId: string; alias: string; busyFraction: number }>;
};

export type MessagesPage = {
  messages: Message[];
  nextSinceId: string | null;
  hasMoreBefore?: boolean;
};

// ---------------------------------------------------------------------------
// SessionAuditReport — mirrors `teamwork/src/core/types.ts:SessionAuditReport`.
// Used by the (currently un-rendered) `/api/sessions/:id/audit` endpoint.
// ---------------------------------------------------------------------------

export type AgentAuditRecord = {
  agentId: string;
  alias: string;
  specialty: string;
  cli: SupportedCli;
  model: string;
  statusState: AgentStatusState;
  statusSummary?: string;
  createdAt: string;
  lastStatusAt: string;
  lastHeartbeatAt?: string;
  sentCount: number;
  receivedCount: number;
  directSentCount: number;
  broadcastSentCount: number;
  directReceivedCount: number;
  broadcastReceivedCount: number;
  acknowledgedCount: number;
  unacknowledgedCount: number;
  assignmentCount: number;
  blockedAssignmentCount: number;
  doneAssignmentCount: number;
  resultCount: number;
  statusChangeCount: number;
  blockedStatusCount: number;
  idleStatusCount: number;
  busyStatusCount: number;
  stoppedStatusCount: number;
  runtimeCount: number;
  activeRuntimeCount: number;
  stoppedRuntimeCount: number;
  crashedRuntimeCount: number;
  totalRuntimeSeconds: number;
  firstRuntimeStartedAt?: string;
  lastRuntimeExitedAt?: string;
};

export type CopilotUsageRuntime = {
  runtimeId: string;
  agentId: string;
  agentAlias?: string;
  cliSessionId?: string;
  model?: string;
  otelFilePath?: string;
  source: "otel-file" | "missing";
  missingReason?: string;
  aiCredits: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  turnCount: number;
  spanCount: number;
  chatSpanCount: number;
};

export type CopilotUsageSummary = {
  source: string;
  note: string;
  sourceCount: number;
  totals: {
    aiCredits: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    turnCount: number;
    spanCount: number;
    chatSpanCount: number;
  };
  runtimes: CopilotUsageRuntime[];
};

export type SessionAuditReport = {
  session: {
    id: string;
    slug: string;
    parentCli: SupportedCli;
    createdAt: string;
  };
  rollup: {
    workerCount: number;
    messageCount: number;
    directMessageCount: number;
    broadcastMessageCount: number;
    assignmentCount: number;
    blockedAssignmentCount: number;
    resultCount: number;
    checkpointCount: number;
    statusChangeCount: number;
    blockedStatusCount: number;
    runtimeCount: number;
    activeRuntimeCount: number;
    stoppedRuntimeCount: number;
    crashedRuntimeCount: number;
    totalRuntimeSeconds: number;
    copilotAiCredits: number;
    copilotCostUsd: number;
    copilotInputTokens: number;
    copilotOutputTokens: number;
    copilotUsageRuntimeCount: number;
    pairSpecialtyCount: number;
    pairTrafficSpecialtyCount: number;
    firstMessageAt?: string;
    lastMessageAt?: string;
  };
  usage?: {
    copilot: CopilotUsageSummary;
  };
  pairs: Array<{
    specialty: string;
    agentIds: string[];
    aliases: string[];
    directMessageCount: number;
    hasTraffic: boolean;
    firstMessageAt?: string;
    lastMessageAt?: string;
  }>;
  assignments: Array<{
    phase: string;
    count: number;
  }>;
  agents: AgentAuditRecord[];
};

// ---------------------------------------------------------------------------
// BusEvent — discriminated union mirroring `teamwork/src/events.ts:BusEvent`.
// Each arm represents one SSE `event:` name. The backend bus (worker A) stamps
// every emitted payload with a monotonic `id: number` so SSE clients can resume
// after `Last-Event-ID` reconnects. We mark `id` as `number | undefined` so
// older server versions that haven't shipped the id field don't break narrowing.
// ---------------------------------------------------------------------------

type WithId = { id?: number };

export type BusEventDashboardSessionList = WithId & {
  topic: "dashboard:session-list";
  reason: "session-created" | "agent-registered" | "session-updated";
  sessionId: string;
};

export type BusEventAgent = WithId & {
  topic: "agent";
  sessionId: string;
  agent: Agent;
};

export type BusEventStatus = WithId & {
  topic: "status";
  sessionId: string;
  agentId: string;
  status: AgentStatus;
};

export type BusEventAssignment = WithId & {
  topic: "assignment";
  sessionId: string;
  assignment: Assignment;
  reason: "created" | "status-changed";
};

export type BusEventMessageSent = WithId & {
  topic: "message";
  kind: "sent";
  sessionId: string;
  messageId: string;
  fromAgentId: string;
  toAgentIds: string[];
  deliveryMode: DeliveryMode;
  summary?: string;
  createdAt: string;
};

export type BusEventMessageAck = WithId & {
  topic: "message";
  kind: "ack";
  sessionId: string;
  agentId: string;
  messageIds: string[];
  acknowledgedAt: string;
};

export type BusEventMessage = BusEventMessageSent | BusEventMessageAck;

export type BusEventResult = WithId & {
  topic: "result";
  sessionId: string;
  result: Result;
};

export type BusEventCheckpoint = WithId & {
  topic: "checkpoint";
  sessionId: string;
  checkpoint: Checkpoint;
};

export type BusEventRuntime = WithId & {
  topic: "runtime";
  sessionId: string;
  agentId: string;
  runtime: AgentRuntime;
};

export type BusEventHeartbeat = WithId & {
  topic: "heartbeat";
  sessionId: string;
  agentId: string;
  summary?: string;
  updatedAt: string;
};

export type BusEventShutdown = WithId & {
  topic: "shutdown";
  sessionId: string;
  agentId: string;
  requestId: string;
  status: "requested" | "approved" | "rejected";
  reason?: string;
  updatedAt: string;
};

// Worker stdout chunks streamed from the teamwork runtime. The backend
// publishes on the per-session topic `session:<id>:output` with SSE event name
// `output`; we mirror just the discriminator name on the client (the dynamic
// session id isn't useful here — the SSE stream is already session-scoped).
export type BusEventWorkerOutput = WithId & {
  topic: "output";
  kind: "worker-output";
  sessionId: string;
  agentId: string;
  runtimeId?: string;
  stream?: string;
  outputId: number;
  chunk: string;
  createdAt: string;
};

export type BusEvent =
  | BusEventDashboardSessionList
  | BusEventAgent
  | BusEventStatus
  | BusEventAssignment
  | BusEventMessage
  | BusEventResult
  | BusEventCheckpoint
  | BusEventRuntime
  | BusEventHeartbeat
  | BusEventShutdown
  | BusEventWorkerOutput;

export type BusEventName = BusEvent["topic"];

// All known event names — used by the SSE bridge to wire every name regardless
// of which handlers the caller registered on first render.
export const BUS_EVENT_NAMES = [
  "dashboard:session-list",
  "agent",
  "status",
  "assignment",
  "message",
  "result",
  "checkpoint",
  "runtime",
  "heartbeat",
  "shutdown",
  "output",
] as const satisfies ReadonlyArray<BusEventName>;
