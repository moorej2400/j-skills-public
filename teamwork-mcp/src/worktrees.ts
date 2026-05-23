/**
 * Git worktree helper utilities for the teamwork MCP server.
 *
 * Provides functions to create, list, and manage git worktrees
 * used by teamwork agents during parallel development phases.
 */

import { execSync, type ExecSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
  headCommit: string;
  bare: boolean;
  detached: boolean;
}

export interface CreateWorktreeOptions {
  /** Project root containing the .git directory. */
  projectRoot: string;
  /** Absolute path for the new worktree directory. */
  worktreePath: string;
  /** Branch name to create/checkout in the worktree. */
  branch: string;
  /** Base ref (branch, tag, or SHA) to start from. Defaults to HEAD. */
  startPoint?: string;
  /** If true, creates a new branch. If false, checks out an existing branch. */
  createBranch?: boolean;
}

const execOpts = (cwd: string): ExecSyncOptionsWithStringEncoding => ({
  encoding: "utf-8",
  cwd,
  timeout: 30_000,
  stdio: ["pipe", "pipe", "pipe"],
});

/**
 * Parse `git worktree list --porcelain` output into structured data.
 */
export function listGitWorktrees(projectRoot: string): WorktreeInfo[] {
  const raw = execSync("git worktree list --porcelain", execOpts(projectRoot)).trim();
  if (!raw) return [];

  const entries = raw.split("\n\n").filter(Boolean);
  return entries.map((entry) => {
    const lines = entry.split("\n");
    const wtPath = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? "";
    const headLine = lines.find((l) => l.startsWith("HEAD "));
    const head = headLine?.slice("HEAD ".length) ?? "";
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const branch = branchLine?.slice("branch ".length).replace("refs/heads/", "") ?? "";
    const bare = lines.some((l) => l === "bare");
    const detached = lines.some((l) => l === "detached");

    return { path: wtPath, branch, headCommit: head, bare, detached };
  });
}

/**
 * Create a new git worktree with an optional new branch.
 */
export function createGitWorktree(options: CreateWorktreeOptions): WorktreeInfo {
  const { projectRoot, worktreePath, branch, startPoint, createBranch = true } = options;

  // Ensure parent directory exists
  const parentDir = path.dirname(worktreePath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const branchFlag = createBranch ? "-b" : "";
  const start = startPoint ?? "HEAD";
  const cmd = createBranch
    ? `git worktree add ${branchFlag} "${branch}" "${worktreePath}" ${start}`
    : `git worktree add "${worktreePath}" "${branch}"`;

  execSync(cmd, execOpts(projectRoot));

  // Retrieve the HEAD of the new worktree
  const headCommit = execSync("git rev-parse HEAD", execOpts(worktreePath)).trim();

  return {
    path: worktreePath,
    branch,
    headCommit,
    bare: false,
    detached: false,
  };
}

/**
 * Remove a git worktree by path.
 */
export function removeGitWorktree(projectRoot: string, worktreePath: string, force = false): void {
  const forceFlag = force ? "--force" : "";
  execSync(`git worktree remove ${forceFlag} "${worktreePath}"`, execOpts(projectRoot));
}

/**
 * Get the current HEAD commit SHA for a worktree path.
 */
export function getWorktreeHead(worktreePath: string): string {
  return execSync("git rev-parse HEAD", execOpts(worktreePath)).trim();
}

/**
 * Check if a worktree path has uncommitted changes.
 */
export function isWorktreeDirty(worktreePath: string): boolean {
  const status = execSync("git status --porcelain", execOpts(worktreePath)).trim();
  return status.length > 0;
}

/**
 * Get a summary of changes in a worktree (short diff stat).
 */
export function getWorktreeDiffStat(worktreePath: string, baseRef?: string): string {
  const ref = baseRef ?? "HEAD";
  try {
    return execSync(`git diff --stat ${ref}`, execOpts(worktreePath)).trim();
  } catch {
    return "";
  }
}
