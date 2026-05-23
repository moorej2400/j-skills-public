import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { ensureDashboardUiBuilt } from "../../src/dashboard-assets.js";

test("ensureDashboardUiBuilt runs the dashboard build when dist/index.html is missing", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "teamwork-dashboard-assets-"));
  try {
    const projectRoot = path.join(tempDir, "teamwork-mcp");
    const distDir = path.join(projectRoot, "dashboard-ui", "dist");
    let buildCwd = "";

    const built = ensureDashboardUiBuilt({
      projectRoot,
      distDir,
      env: {},
      log: () => {},
      runBuild: (cwd) => {
        buildCwd = cwd;
        mkdirSync(distDir, { recursive: true });
        writeFileSync(path.join(distDir, "index.html"), "<!doctype html>", "utf8");
      },
    });

    assert.equal(built, true);
    assert.equal(buildCwd, projectRoot);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ensureDashboardUiBuilt skips the build when dist/index.html already exists", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "teamwork-dashboard-assets-"));
  try {
    const projectRoot = path.join(tempDir, "teamwork-mcp");
    const distDir = path.join(projectRoot, "dashboard-ui", "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, "index.html"), "<!doctype html>", "utf8");
    let ranBuild = false;

    const built = ensureDashboardUiBuilt({
      projectRoot,
      distDir,
      env: {},
      log: () => {},
      runBuild: () => {
        ranBuild = true;
      },
    });

    assert.equal(built, false);
    assert.equal(ranBuild, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
