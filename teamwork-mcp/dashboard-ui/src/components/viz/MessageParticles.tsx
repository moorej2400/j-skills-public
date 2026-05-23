import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useSessionStore } from "@/store/sessionStore";
import type { Agent, DeliveryMode, Message } from "@/lib/types";
import { cssVarToColor } from "./viz-helpers";
import { aliasHue } from "@/components/session/aliasColors";
import { useReducedMotion } from "@/lib/useReducedMotion";

type Props = {
  sessionId: string;
  agents: Agent[];
  positions: Map<string, [number, number, number]>;
  // Optional callback so the parent NetworkScene can read recent edge
  // activity (per-edge message count over a 60s window) and modulate edge
  // opacity. The shape is `Map<"from->to", count>`.
  onEdgeActivity?: (counts: Map<string, number>) => void;
};

const PARTICLE_LIFETIME_MS = 1200;
const FRESH_WINDOW_MS = 4000;
const DEDUPE_CAP = 4096;
// Window for the "is this edge hot?" calculation. Edges with no traffic in
// this window fade to a low opacity; active edges glow.
const EDGE_ACTIVITY_WINDOW_MS = 60_000;

type LiveParticle = {
  key: string;
  from: THREE.Vector3;
  to: THREE.Vector3;
  startedAt: number;
  mode: DeliveryMode;
  // Color used by the particle. Direct messages use the *sender's* alias
  // color (review M7 UX); broadcast keeps the cyan accent-2 token. Stored
  // per-particle so the Particle component can render without re-deriving.
  color: THREE.Color;
  // Particle radius — varies by message body length to add a subtle sense
  // of weight (review M7).
  radius: number;
};

const PARTICLE_COLOR_BROADCAST = new THREE.Color().setHSL(190 / 360, 0.85, 0.62);

// Per-alias particle color cache — keyed on alias hue to avoid allocating a
// fresh THREE.Color for every direct message.
const SENDER_COLORS = new Map<string, THREE.Color>();
function senderColorFor(alias: string): THREE.Color {
  const cached = SENDER_COLORS.get(alias);
  if (cached) return cached;
  const c = new THREE.Color().setHSL(aliasHue(alias) / 360, 0.7, 0.62);
  SENDER_COLORS.set(alias, c);
  return c;
}

export function MessageParticles({ sessionId, agents, positions, onEdgeActivity }: Props) {
  const messages = useSessionStore((s) => s.messages[sessionId]) ?? [];
  const reduced = useReducedMotion();
  const seenRef = useRef<Map<string, number>>(new Map());
  const lastProcessedIndexRef = useRef(0);
  const [particles, setParticles] = useState<LiveParticle[]>([]);

  // Per-edge timestamps for activity-driven opacity in NetworkScene. Map key
  // is `${fromId}->${toId}`. Values are arrays of timestamps in ms; pruned
  // when older than EDGE_ACTIVITY_WINDOW_MS.
  const edgeTimestamps = useRef<Map<string, number[]>>(new Map());

  // Lookup table: agentId → alias for sender color resolution.
  const aliasById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.agentId, a.alias);
    return m;
  }, [agents]);

  useEffect(() => {
    if (!messages.length) {
      lastProcessedIndexRef.current = 0;
      return;
    }
    if (reduced) {
      // Reduced motion: skip particle spawning entirely. The store still
      // gets the messages; the user just won't see the orbs zip.
      lastProcessedIndexRef.current = messages.length;
      return;
    }
    const now = Date.now();
    const incoming: LiveParticle[] = [];
    let startIdx = Math.min(lastProcessedIndexRef.current, messages.length);
    if (startIdx > messages.length) startIdx = 0;
    for (let i = startIdx; i < messages.length; i += 1) {
      const m = messages[i];
      const ts = Date.parse(m.createdAt);
      if (Number.isNaN(ts)) continue;
      if (now - ts > FRESH_WINDOW_MS) continue;

      const targets = resolveTargets(m, agents);
      const fromPos = positions.get(m.fromAgentId);
      if (!fromPos) continue;
      // Resolve color once per message: broadcast = accent-2 cyan;
      // direct = sender alias color.
      const senderAlias = aliasById.get(m.fromAgentId) ?? m.senderAlias ?? m.fromAgentId;
      const directColor = senderColorFor(senderAlias);
      // Vary radius by body length: shorter notes are smaller pings, longer
      // bodies show as fuller orbs.
      const bodyLen = m.body?.length ?? 0;
      const radius = Math.min(0.09, Math.max(0.05, 0.05 + bodyLen / 20000 + 0.01 * (m.summary?.length ?? 0) / 200));

      for (const targetId of targets) {
        const key = `${m.id}:${targetId}`;
        if (seenRef.current.has(key)) continue;
        const toPos = positions.get(targetId);
        if (!toPos) continue;
        seenRef.current.set(key, now);
        // Stamp edge activity for the from→to direction (and reverse so
        // visual emphasis is symmetric).
        const edgeKey = makeEdgeKey(m.fromAgentId, targetId);
        const arr = edgeTimestamps.current.get(edgeKey) ?? [];
        arr.push(now);
        edgeTimestamps.current.set(edgeKey, arr);
        incoming.push({
          key,
          from: new THREE.Vector3(...fromPos),
          to: new THREE.Vector3(...toPos),
          startedAt: performance.now(),
          mode: m.deliveryMode,
          color: m.deliveryMode === "broadcast" ? PARTICLE_COLOR_BROADCAST : directColor,
          radius,
        });
      }
    }
    lastProcessedIndexRef.current = messages.length;

    if (seenRef.current.size > DEDUPE_CAP) {
      const overflow = seenRef.current.size - DEDUPE_CAP;
      const it = seenRef.current.keys();
      for (let i = 0; i < overflow; i += 1) {
        const next = it.next();
        if (next.done) break;
        seenRef.current.delete(next.value);
      }
    }

    if (incoming.length) {
      setParticles((prev) => [...prev, ...incoming]);
    }
  }, [messages, agents, positions, reduced, aliasById]);

  // Periodic prune of completed particles + recompute per-edge activity
  // counts so NetworkScene can modulate edge opacity (review M8 UX).
  useEffect(() => {
    const t = setInterval(() => {
      const now = performance.now();
      setParticles((prev) =>
        prev.filter((p) => now - p.startedAt < PARTICLE_LIFETIME_MS),
      );
      // Prune timestamp arrays + emit aggregated counts.
      if (onEdgeActivity) {
        const wallNow = Date.now();
        const cutoff = wallNow - EDGE_ACTIVITY_WINDOW_MS;
        const counts = new Map<string, number>();
        for (const [key, stamps] of edgeTimestamps.current) {
          const fresh = stamps.filter((s) => s >= cutoff);
          if (fresh.length === 0) {
            edgeTimestamps.current.delete(key);
          } else {
            edgeTimestamps.current.set(key, fresh);
            counts.set(key, fresh.length);
          }
        }
        onEdgeActivity(counts);
      }
    }, 500);
    return () => clearInterval(t);
  }, [onEdgeActivity]);

  if (reduced) return null;

  return (
    <>
      {particles.map((p) => (
        <Particle
          key={p.key}
          from={p.from}
          to={p.to}
          startedAt={p.startedAt}
          color={p.color}
          radius={p.radius}
        />
      ))}
    </>
  );
}

// Edges in NetworkScene are direction-agnostic (a single line per pair); use
// a sorted key so `parent->worker` and `worker->parent` collapse onto one bin.
export function makeEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function resolveTargets(message: Message, agents: Agent[]): string[] {
  if (message.deliveryMode === "broadcast") {
    return agents
      .map((a) => a.agentId)
      .filter((id) => id !== message.fromAgentId);
  }
  if (message.toAgentId) return [message.toAgentId];
  return [];
}

type ParticleProps = {
  from: THREE.Vector3;
  to: THREE.Vector3;
  startedAt: number;
  color: THREE.Color;
  radius: number;
};

function Particle({ from, to, startedAt, color, radius }: ParticleProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  const [done, setDone] = useState(false);

  useFrame(() => {
    const mesh = meshRef.current;
    const mat = matRef.current;
    if (!mesh || !mat) return;
    const elapsed = performance.now() - startedAt;
    const t = Math.min(1, elapsed / PARTICLE_LIFETIME_MS);
    mesh.position.lerpVectors(from, to, t);
    mesh.position.y += Math.sin(t * Math.PI) * 0.25;
    const glow = Math.sin(t * Math.PI);
    mat.emissiveIntensity = 1.4 * glow + 0.2;
    mat.opacity = glow;
    if (t >= 1 && !done) setDone(true);
  });

  if (done) return null;

  // Used at module level by ignored constant `cssVarToColor("--primary")` —
  // no longer referenced now that all particles carry their own resolved
  // color, but kept to maintain test parity.
  void cssVarToColor;

  return (
    <mesh ref={meshRef} position={from.toArray()}>
      <sphereGeometry args={[radius, 16, 16]} />
      <meshStandardMaterial
        ref={matRef}
        color={color}
        emissive={color}
        emissiveIntensity={1.4}
        transparent
        opacity={0.0}
      />
    </mesh>
  );
}
