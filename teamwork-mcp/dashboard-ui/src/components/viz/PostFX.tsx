import { EffectComposer, Bloom } from "@react-three/postprocessing";

// Centralized post-processing config. Bloom intensity dialled down (0.7 →
// 0.45) with a higher luminanceThreshold (0.4 → 0.55) so emissive nodes
// still glow but the labels next to them stay legible (review M10 UX). Set
// `enabled` to false from a parent to hard-disable post-processing in
// "calm mode" — currently always on; the AgentNetwork3D HUD passes a prop.
export function PostFX({ enabled = true }: { enabled?: boolean }) {
  if (!enabled) return null;
  return (
    <EffectComposer>
      <Bloom intensity={0.45} luminanceThreshold={0.55} mipmapBlur />
    </EffectComposer>
  );
}
