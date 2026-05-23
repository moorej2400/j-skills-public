import { Suspense, useCallback, useMemo, useState } from "react";
import { Stars, Line, Text } from "@react-three/drei";
import * as THREE from "three";
import { useSessionStore } from "@/store/sessionStore";
import type { Agent } from "@/lib/types";
import { AgentNode } from "./AgentNode";
import { MessageParticles, makeEdgeKey } from "./MessageParticles";
import { cssVarToColor, isParentAgent, placeOnRing } from "./viz-helpers";

type Props = {
  sessionId: string;
  hoveredAgentId: string | null;
  showParticles?: boolean;
};

export function NetworkScene({ sessionId, hoveredAgentId, showParticles = true }: Props) {
  const detail = useSessionStore((s) => s.details[sessionId]);

  const agents: Agent[] = detail?.agents ?? [];

  const { positions, edges, parentId } = useMemo(() => {
    const map = new Map<string, [number, number, number]>();
    const parent = agents.find((a) => isParentAgent(a.agentId, a.alias));
    const workers = agents.filter((a) => a !== parent);

    if (parent) {
      map.set(parent.agentId, [0, 0, 0]);
      workers.forEach((w, i) => {
        map.set(w.agentId, placeOnRing(i, workers.length, 3));
      });
    } else {
      agents.forEach((a, i) => {
        map.set(a.agentId, placeOnRing(i, agents.length, 3));
      });
    }

    const lines: Array<{ key: string; pair: [string, string]; points: [THREE.Vector3, THREE.Vector3] }> = [];
    if (parent) {
      const p = map.get(parent.agentId)!;
      for (const w of workers) {
        const wp = map.get(w.agentId)!;
        lines.push({
          key: `${parent.agentId}->${w.agentId}`,
          pair: [parent.agentId, w.agentId],
          points: [new THREE.Vector3(...p), new THREE.Vector3(...wp)],
        });
      }
    }
    return { positions: map, edges: lines, parentId: parent?.agentId };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.map((a) => a.agentId).sort().join("|")]);

  const edgeColor = useMemo(() => cssVarToColor("--muted-foreground"), [parentId]);

  // Per-edge activity counts — fed by MessageParticles, consumed below to
  // modulate edge opacity (review M8 UX). Idle edges fade to 0.12; active
  // edges pulse up to 0.55. Hovered agent's incident edges get a bump.
  const [edgeActivity, setEdgeActivity] = useState<Map<string, number>>(new Map());
  const handleEdgeActivity = useCallback((counts: Map<string, number>) => {
    setEdgeActivity(counts);
  }, []);

  // Empty-state placeholder mesh (review M9 UX). Renders a translucent ring
  // with a "Waiting for agents…" Text inside the canvas so the operator sees
  // a clear "no data" affordance instead of an empty starfield.
  if (agents.length === 0) {
    return (
      <>
        <Stars radius={80} depth={50} count={400} factor={4} fade speed={1} />
        <ambientLight intensity={0.4} />
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.4, 1.5, 64]} />
          <meshBasicMaterial color="hsl(220, 10%, 30%)" transparent opacity={0.4} />
        </mesh>
        <Suspense fallback={null}>
          <Text
            position={[0, 0, 0]}
            fontSize={0.32}
            color="hsl(220, 10%, 60%)"
            anchorX="center"
            anchorY="middle"
          >
            Waiting for agents…
          </Text>
        </Suspense>
      </>
    );
  }

  return (
    <>
      <Stars radius={80} depth={50} count={400} factor={4} fade speed={1} />
      <ambientLight intensity={0.25} />
      <pointLight position={[6, 6, 4]} intensity={1.6} color="#c4b5fd" />
      <pointLight position={[-6, -4, -3]} intensity={0.9} color="#67e8f9" />

      {edges.map((e) => {
        const key = makeEdgeKey(e.pair[0], e.pair[1]);
        const count = edgeActivity.get(key) ?? 0;
        const incident = hoveredAgentId === e.pair[0] || hoveredAgentId === e.pair[1];
        // Map count [0..N] → opacity [0.12..0.55] with a soft curve.
        const baseOpacity = Math.min(0.55, 0.12 + count * 0.06);
        const opacity = incident ? Math.min(0.7, baseOpacity + 0.25) : baseOpacity;
        return (
          <Line
            key={e.key}
            points={e.points}
            color={edgeColor}
            lineWidth={incident ? 1.5 : 1}
            transparent
            opacity={opacity}
          />
        );
      })}

      {agents.map((a) => {
        const pos = positions.get(a.agentId) ?? [0, 0, 0];
        return (
          <AgentNode
            key={a.agentId}
            agent={a}
            position={pos}
            hovered={hoveredAgentId === a.agentId}
          />
        );
      })}

      {showParticles ? (
        <MessageParticles
          sessionId={sessionId}
          agents={agents}
          positions={positions}
          onEdgeActivity={handleEdgeActivity}
        />
      ) : null}
    </>
  );
}
