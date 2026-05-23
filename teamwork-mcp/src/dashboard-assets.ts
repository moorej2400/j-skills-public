import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PROJECT_ROOT = resolve(__dirname, "..");
const DEFAULT_DIST = join(DEFAULT_PROJECT_ROOT, "dashboard-ui", "dist");

export type DashboardBuildOptions = {
  projectRoot?: string;
  distDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  runBuild?: (cwd: string) => void;
};

export function ensureDashboardUiBuilt(options: DashboardBuildOptions = {}): boolean {
  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const distDir = options.distDir ?? process.env.TEAMWORK_DASHBOARD_DIST ?? DEFAULT_DIST;
  const env = options.env ?? process.env;
  const log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  const indexPath = join(distDir, "index.html");

  if (existsSync(indexPath)) return false;
  // Integration tests disable this so server startup stays fast and deterministic.
  if (env.TEAMWORK_DASHBOARD_AUTO_BUILD === "0") {
    log(`teamwork-mcp: dashboard UI missing at ${distDir}; auto-build disabled`);
    return false;
  }

  const runBuild = options.runBuild ?? defaultRunBuild;
  log("teamwork-mcp: dashboard UI not built; running npm run dashboard:build");
  try {
    runBuild(projectRoot);
  } catch (err) {
    log(`teamwork-mcp: dashboard UI auto-build failed: ${(err as Error).message}`);
    return false;
  }

  if (!existsSync(indexPath)) {
    log(`teamwork-mcp: dashboard build completed but ${indexPath} is still missing`);
    return false;
  }
  return true;
}

function defaultRunBuild(cwd: string): void {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["run", "dashboard:build"], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}
