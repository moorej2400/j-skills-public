import { Suspense, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard, Float, Text } from "@react-three/drei";
import * as THREE from "three";
import type { Agent } from "@/lib/types";
import { colorForStatus } from "./viz-helpers";
import { useReducedMotion } from "@/lib/useReducedMotion";

type Props = {
  agent: Agent;
  position: [number, number, number];
  hovered: boolean;
};

// A single glowing sphere with a billboarded label. Color, emissive intensity
// and scale all transition over a few hundred ms so live status updates feel
// fluid rather than snappy. With `prefers-reduced-motion` the busy pulse
// freezes at 1.0 and the lerp is replaced with a snap (review C2 UX).
export function AgentNode({ agent, position, hovered }: Props) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  const groupRef = useRef<THREE.Group>(null);
  const reduced = useReducedMotion();

  const targetColor = useMemo(() => colorForStatus(agent.status?.state), [agent.status?.state]);
  const isBusy = agent.status?.state === "busy";
  const isStopped = agent.status?.state === "stopped";

  const mountedAt = useRef<number>(performance.now());
  useEffect(() => {
    mountedAt.current = performance.now();
  }, []);

  useFrame((_, delta) => {
    const mat = matRef.current;
    const mesh = meshRef.current;
    const group = groupRef.current;
    if (!mat || !mesh || !group) return;

    if (reduced) {
      // Snap to target rather than lerp; freeze the busy pulse at 1.0.
      mat.color.copy(targetColor);
      mat.emissive.copy(targetColor);
      mat.emissiveIntensity = isStopped ? 0.4 : 0.9;
      mesh.scale.setScalar(hovered ? 1.15 : 1);
      mat.opacity = 1;
      return;
    }

    const k = 1 - Math.exp(-delta * 6);
    mat.color.lerp(targetColor, k);
    mat.emissive.lerp(targetColor, k);

    const baseEmissive = isStopped ? 0.4 : 0.9;
    const targetEmissiveIntensity = hovered ? baseEmissive + 0.6 : baseEmissive;
    mat.emissiveIntensity += (targetEmissiveIntensity - mat.emissiveIntensity) * k;

    const t = performance.now() / 1000;
    const pulse = isBusy ? 1 + Math.sin((t * (Math.PI * 2)) / 1.6) * 0.03 : 1;
    const hoverScale = hovered ? 1.15 : 1;
    const targetScale = pulse * hoverScale;
    const cur = mesh.scale.x;
    const next = cur + (targetScale - cur) * k;
    mesh.scale.setScalar(next);

    const age = performance.now() - mountedAt.current;
    const target = Math.min(1, age / 200);
    mat.opacity += (target - mat.opacity) * Math.min(1, delta * 12);
  });

  return (
    <group ref={groupRef} position={position}>
      <Float speed={1.2} rotationIntensity={0.15} floatIntensity={0.35}>
        <mesh ref={meshRef} castShadow>
          <sphereGeometry args={[0.32, 48, 48]} />
          <meshStandardMaterial
            ref={matRef}
            color={targetColor}
            emissive={targetColor}
            emissiveIntensity={0.9}
            roughness={0.35}
            metalness={0.15}
            transparent
            opacity={0}
          />
        </mesh>

        {/* Label refinement (review M6 UX): drop the harsh black outline in
            favour of a small rounded backing plane so the text reads as part
            of the world. Billboard keeps the text camera-facing without the
            previous opaque sticker look. Suspense isolates the drei <Text>
            font load so the rest of the scene paints first (review H19). */}
        <Suspense fallback={null}>
          <Billboard position={[0, 0.62, 0]}>
            <mesh position={[0, 0, -0.001]}>
              <planeGeometry args={[Math.max(1.0, agent.alias.length * 0.12), 0.32]} />
              <meshBasicMaterial
                color="hsl(220, 12%, 8%)"
                transparent
                opacity={0.55}
                depthWrite={false}
              />
            </mesh>
            <Text
              fontSize={0.18}
              color="hsl(220, 15%, 92%)"
              anchorX="center"
              anchorY="middle"
              fillOpacity={0.95}
            >
              {agent.alias}
            </Text>
          </Billboard>
        </Suspense>
      </Float>
    </group>
  );
}
