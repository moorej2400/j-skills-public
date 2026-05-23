import { EventEmitter } from "node:events";

// In-process pub/sub for dashboard updates. Topic strings are public contract;
// payloads are kept small (ids + summary) — clients refetch detail via REST.

export type DashboardSessionListEvent = {
  topic: "dashboard:session-list";
  reason: "session-created" | "agent-registered" | "session-updated";
  sessionId: string;
};

export type SessionAgentEvent = {
  topic: "agent";
  sessionId: string;
  agent: unknown;
};

export type SessionStatusEvent = {
  topic: "status";
  sessionId: string;
  agentId: string;
  status: { state: string; summary?: string; updatedAt: string };
};

export type SessionAssignmentEvent = {
  topic: "assignment";
  sessionId: string;
  assignment: unknown;
  reason: "created" | "status-changed" | "claimed";
};

export type SessionMessageEvent =
  | {
      topic: "message";
      kind: "sent";
      sessionId: string;
      messageId: string;
      fromAgentId: string;
      toAgentIds: string[];
      deliveryMode: "direct" | "broadcast";
      summary?: string;
      createdAt: string;
    }
  | {
      topic: "message";
      kind: "ack";
      sessionId: string;
      agentId: string;
      messageIds: string[];
      acknowledgedAt: string;
    };

export type SessionResultEvent = {
  topic: "result";
  sessionId: string;
  result: unknown;
};

export type SessionCheckpointEvent = {
  topic: "checkpoint";
  sessionId: string;
  checkpoint: unknown;
};

export type SessionRuntimeEvent = {
  topic: "runtime";
  sessionId: string;
  agentId: string;
  runtime: unknown;
};

export type SessionHeartbeatEvent = {
  topic: "heartbeat";
  sessionId: string;
  agentId: string;
  summary?: string;
  updatedAt: string;
};

export type SessionOutputEvent = {
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

export type SessionShutdownEvent = {
  topic: "shutdown";
  sessionId: string;
  agentId: string;
  requestId: string;
  status: "requested" | "approved" | "rejected";
  reason?: string;
  updatedAt: string;
};

type BaseBusEvent =
  | DashboardSessionListEvent
  | SessionAgentEvent
  | SessionStatusEvent
  | SessionAssignmentEvent
  | SessionMessageEvent
  | SessionResultEvent
  | SessionCheckpointEvent
  | SessionRuntimeEvent
  | SessionHeartbeatEvent
  | SessionOutputEvent
  | SessionShutdownEvent;

export type BusEvent = BaseBusEvent & { id: number };

export type TopicName =
  | "dashboard:session-list"
  | `session:${string}:agent`
  | `session:${string}:status`
  | `session:${string}:assignment`
  | `session:${string}:message`
  | `session:${string}:result`
  | `session:${string}:checkpoint`
  | `session:${string}:runtime`
  | `session:${string}:heartbeat`
  | `session:${string}:output`
  | `session:${string}:shutdown`;

const RING_CAPACITY = 256;
const OUTPUT_RING_CAPACITY = 32;

function ringCapacityFor(topic: TopicName): number {
  return topic.endsWith(":output") ? OUTPUT_RING_CAPACITY : RING_CAPACITY;
}

class Bus {
  private readonly emitter = new EventEmitter();
  private readonly rings = new Map<TopicName, BusEvent[]>();
  // Seed from wall-clock so ids issued after a process restart are always
  // strictly greater than any id from the previous run. Without this, an SSE
  // client that reconnects with a saved Last-Event-ID > 1 would silently
  // miss every event emitted post-restart (filter `id > lastId` finds nothing).
  private nextId = Date.now();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  emit(topic: TopicName, payload: BaseBusEvent): BusEvent {
    const enriched = { ...payload, id: this.nextId++ } as BusEvent;
    const ring = this.rings.get(topic);
    if (ring) {
      ring.push(enriched);
      if (ring.length > ringCapacityFor(topic)) ring.shift();
    } else {
      this.rings.set(topic, [enriched]);
    }
    const listeners = this.emitter.listeners(topic) as Array<(p: BusEvent) => void>;
    for (const listener of listeners) {
      try {
        listener(enriched);
      } catch (err) {
        console.error("[bus] listener threw:", err);
      }
    }
    return enriched;
  }

  on(topic: TopicName, handler: (payload: BusEvent) => void): () => void {
    this.emitter.on(topic, handler);
    return () => {
      this.emitter.off(topic, handler);
    };
  }

  getSince(topic: TopicName, lastId: number): BusEvent[] {
    const ring = this.rings.get(topic);
    if (!ring) return [];
    return ring.filter((event) => event.id > lastId);
  }
}

export const bus = new Bus();

export function sessionTopic(
  sessionId: string,
  kind:
    | "agent"
    | "status"
    | "assignment"
    | "message"
    | "result"
    | "checkpoint"
    | "runtime"
    | "heartbeat"
    | "output"
    | "shutdown"
): TopicName {
  return `session:${sessionId}:${kind}` as TopicName;
}

export function sessionTopicsFor(sessionId: string): TopicName[] {
  return [
    sessionTopic(sessionId, "agent"),
    sessionTopic(sessionId, "status"),
    sessionTopic(sessionId, "assignment"),
    sessionTopic(sessionId, "message"),
    sessionTopic(sessionId, "result"),
    sessionTopic(sessionId, "checkpoint"),
    sessionTopic(sessionId, "runtime"),
    sessionTopic(sessionId, "heartbeat"),
    sessionTopic(sessionId, "output"),
    sessionTopic(sessionId, "shutdown"),
  ];
}
