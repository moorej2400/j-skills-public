import { useCallback, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { Pause, Play, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { NetworkScene } from "./NetworkScene";
import { PostFX } from "./PostFX";

type Props = { sessionId: string; hoveredAgentId: string | null };

// Top-level 3D viz with a thin HUD: a status legend (top-left) and a control
// cluster (bottom-right) for autorotate, camera reset, and "calm mode" which
// disables particles + autorotate (review HUD top-5 #4). All HUD overlays are
// HTML siblings of <Canvas>, not 3D — that keeps tooltips and focus rings
// accessible. AutoRotate defaults to off when `prefers-reduced-motion`.
export default function AgentNetwork3D({ sessionId, hoveredAgentId }: Props) {
  const reduced = useReducedMotion();
  const [autoRotate, setAutoRotate] = useState<boolean>(!reduced);
  const [calmMode, setCalmMode] = useState<boolean>(reduced);
  const orbitRef = useRef<OrbitControlsImpl | null>(null);

  // First user input (drag/zoom) pauses autorotate so reading a label doesn't
  // fight the camera (review M11 UX). The legend "play" button re-enables.
  const handleControlStart = useCallback(() => {
    setAutoRotate(false);
  }, []);

  const resetCamera = useCallback(() => {
    const controls = orbitRef.current;
    if (!controls) return;
    controls.reset();
  }, []);

  const showParticles = !calmMode;
  const effectiveAutoRotate = autoRotate && !calmMode;

  return (
    <div className="relative h-full w-full">
      {/* Top-left legend overlay */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1.5">
        <LegendChip color="bg-status-busy" label="busy" />
        <LegendChip color="bg-status-idle" label="idle" outline />
        <LegendChip color="bg-status-stopped/80" label="stopped" />
      </div>

      {/* Bottom-right control cluster */}
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-lg border border-border-subtle bg-card-elevated/80 p-1 backdrop-blur">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={effectiveAutoRotate ? "Pause autorotate" : "Resume autorotate"}
          title={effectiveAutoRotate ? "Pause autorotate" : "Resume autorotate"}
          onClick={() => setAutoRotate((v) => !v)}
        >
          {effectiveAutoRotate ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Reset camera"
          title="Reset camera"
          onClick={resetCamera}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`h-7 w-7 ${calmMode ? "text-primary" : ""}`}
          aria-label={calmMode ? "Disable calm mode" : "Enable calm mode"}
          aria-pressed={calmMode}
          title="Calm mode (no particles, no autorotate)"
          onClick={() => setCalmMode((v) => !v)}
        >
          <Sparkles className="h-3.5 w-3.5" />
        </Button>
      </div>

      <Canvas
        className="h-full w-full"
        camera={{ position: [0, 0, 9], fov: 50 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <NetworkScene
          sessionId={sessionId}
          hoveredAgentId={hoveredAgentId}
          showParticles={showParticles}
        />
        <OrbitControls
          ref={orbitRef as never}
          enableZoom
          enablePan={false}
          autoRotate={effectiveAutoRotate}
          autoRotateSpeed={0.4}
          minDistance={5}
          maxDistance={16}
          onStart={handleControlStart}
        />
        {/* Post-processing disabled in calm mode for a flat, calmer scene. */}
        <PostFX enabled={!calmMode} />
      </Canvas>
    </div>
  );
}

function LegendChip({
  color,
  label,
  outline,
}: {
  color: string;
  label: string;
  outline?: boolean;
}): JSX.Element {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-card-elevated/80 px-2 py-0.5 text-2xs uppercase tracking-wider text-muted-foreground backdrop-blur">
      <span
        className={
          outline
            ? `h-2 w-2 rounded-full border border-status-idle bg-transparent`
            : `h-2 w-2 rounded-full ${color}`
        }
      />
      {label}
    </div>
  );
}
