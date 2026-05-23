import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// `mode` lets us read `.env`, `.env.development`, etc. The API port is
// configurable via `VITE_API_PORT` so a developer running the teamwork-mcp
// server on a non-default port can point the dev proxy without editing this
// file. Default mirrors `teamwork-mcp/src/server.ts` (TEAMWORK_UI_PORT=48741).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.VITE_API_PORT ?? "48741";
  const apiTarget = `http://127.0.0.1:${apiPort}`;
  return {
    plugins: [react()],
    base: "/",
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": apiTarget,
        "/health": apiTarget,
      },
    },
    build: {
      outDir: "./dist",
      emptyOutDir: true,
      sourcemap: false,
      // AgentNetwork3D is lazy-loaded; the three/r3f/drei chunk is ~1MB and only
      // hits the wire when the user opens a session page.
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: {
            "react-vendor": ["react", "react-dom", "react-router-dom"],
            charts: ["recharts"],
            motion: ["framer-motion"],
            // xterm + addons are pulled in only when AgentSheet's Terminal tab
            // mounts (via React.lazy on AgentTerminal); isolate them so the
            // initial dashboard payload stays slim.
            terminal: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-web-links"],
          },
        },
      },
    },
  };
});
