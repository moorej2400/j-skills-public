import { ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty, type IPty } from "node-pty";

import { TeamworkStore } from "./store.js";
import { bus, sessionTopic } from "./event-bus.js";

/**
 * Owns child processes for server-managed workers.
 *
 * Workflow decisions stay in the parent agent; this layer only translates MCP
 * launch/input/stop operations into provider-specific CLI process mechanics.
 */
type LaunchMode = "persistent-stdin" | "resume-command" | "oneshot" | "pty";

type ManagedWorker = {
  runtimeId: string;
  sessionId: string;
  agentId: string;
  actorToken: string;
  cli: string;
  model: string;
  reasoningEffort?: string;
  launchMode: LaunchMode;
  stdinWritable: boolean;
  resumeSupported: boolean;
  cwd: string;
  child?: ChildProcess;
  pty?: IPty;
};

type WorkerSupervisorOptions = {
  fakeCliPath?: string;
};

type AdapterLaunch = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  stdin: "pipe" | "ignore";
};

type AdapterCapabilities = {
  supportsPersistentStdin: boolean;
  supportsResume: boolean;
  resumableAfterExit: boolean;
  sessionIdStreams: Array<"stdout" | "stderr">;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type LaunchPhaseInput = {
  sessionId: string;
  actorToken: string;
  phaseNumber: number;
  agentIds?: string[];
  pairRoles?: Record<string, "implementer" | "reviewer-tester">;
  launchMode?: LaunchMode;
  modelOverrides?: Record<string, string>;
  reasoningEffort?: string;
  reasoningEffortOverrides?: Record<string, string>;
  workItemIdsByAgentId?: Record<string, string[]>;
};

export class WorkerSupervisor {
  private workers = new Map<string, ManagedWorker>();

  constructor(private readonly store: TeamworkStore, private readonly options: WorkerSupervisorOptions = {}) {
    this.store.markServerManagedRuntimesCrashed();
  }

  private recordRuntimeLog(input: {
    sessionId: string;
    runtimeId: string;
    agentId: string;
    stream: string;
    text: string;
  }) {
    const out = this.store.recordRuntimeLog(input);
    if (["stdout", "stderr", "system"].includes(input.stream)) {
      try {
        bus.emit(sessionTopic(input.sessionId, "output"), {
          topic: "output",
          kind: "worker-output",
          sessionId: input.sessionId,
          agentId: input.agentId,
          runtimeId: input.runtimeId,
          stream: input.stream,
          outputId: out.outputId,
          chunk: input.text,
          createdAt: out.createdAt,
        });
      } catch {
        /* best-effort dashboard stream */
      }
    }
    return out;
  }

  private handleManagedSpawnError(input: {
    sessionId: string;
    actorToken?: string;
    runtimeId: string;
    agentId: string;
    message: string;
    captureHandoff?: boolean;
    clearWorker?: boolean;
  }) {
    if (input.actorToken) {
      this.store.updateRuntime({
        sessionId: input.sessionId,
        actorToken: input.actorToken,
        runtimeId: input.runtimeId,
        status: "crashed",
      });
    }
    this.recordRuntimeLog({
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      agentId: input.agentId,
      stream: "system",
      text: input.message,
    });
    if (input.captureHandoff ?? true) {
      this.store.captureRuntimeHandoffCandidate({
        sessionId: input.sessionId,
        runtimeId: input.runtimeId,
        agentId: input.agentId,
      });
    }
    if (input.clearWorker) {
      this.workers.delete(input.runtimeId);
      return;
    }
    const managed = this.workers.get(input.runtimeId);
    if (managed) managed.child = undefined;
  }

  launchWorker(input: {
    sessionId: string;
    actorToken: string;
    agentId: string;
    worktreeId: string;
    phaseNumber: number;
    workItemIds?: string[];
    pairRole?: "implementer" | "reviewer-tester";
    launchMode?: LaunchMode;
    model?: string;
    reasoningEffort?: string;
    resumeSessionId?: string;
  }) {
    this.store.requireParentActor({ sessionId: input.sessionId, actorToken: input.actorToken });
    const agent = this.store.getAgent(input.agentId);
    if (agent.sessionId !== input.sessionId) throw new Error("Agent does not belong to this session");
    if (agent.role !== "worker") throw new Error("Only worker agents can be launched");

    const worktree = this.store
      .listWorktrees({ sessionId: input.sessionId, agentId: input.agentId })
      .worktrees.find((entry) => entry.worktreeId === input.worktreeId);
    if (!worktree) throw new Error("Unknown worktree for this worker");

    const capabilities = this.adapterCapabilities(agent.cli);
    const requestedMode = input.launchMode ?? this.defaultLaunchMode(agent.cli);
    const mode = this.normalizeLaunchMode(agent.cli, requestedMode, capabilities);
    this.store.recordDebugEvent({
      sessionId: input.sessionId,
      actorAgentId: input.agentId,
      eventType: "adapter_capability_decision",
      toolName: "worker_supervisor.launch_worker",
      payload: {
        cli: agent.cli,
        requestedMode,
        launchMode: mode,
        normalized: requestedMode !== mode,
        supportsPersistentStdin: capabilities.supportsPersistentStdin,
        supportsResume: capabilities.supportsResume,
        resumableAfterExit: capabilities.resumableAfterExit,
        sessionIdStreams: capabilities.sessionIdStreams,
      },
    });
    if (input.workItemIds?.length) {
      this.store.ensureWorkItemsAssignedToAgent({
        sessionId: input.sessionId,
        actorToken: input.actorToken,
        agentId: input.agentId,
        workItemIds: input.workItemIds,
      });
    }
    const session = this.store.getSessionSummary(input.sessionId);
    const workItems = this.store
      .listWorkItems({ sessionId: input.sessionId, phaseNumber: input.phaseNumber })
      .workItems.filter((item) =>
        input.workItemIds?.length
          ? input.workItemIds.includes(item.workItemId)
          : item.ownerAgentId === input.agentId || item.assigneeAgentIds.includes(input.agentId)
      );
    const currentClaimItem = workItems.find((item) => item.activeClaims.some((claim) => claim.agentId === input.agentId));
    const currentClaim = currentClaimItem
      ? {
          ...currentClaimItem.activeClaims.find((claim) => claim.agentId === input.agentId)!,
          title: currentClaimItem.title,
          description: currentClaimItem.description,
          status: currentClaimItem.status,
        }
      : undefined;
    const sharedInstructionsPath = this.prepareSharedInstructions({
      sessionWorkspacePath: session.sessionWorkspacePath,
      worktreePath: worktree.path,
    });
    const prompt = this.buildWorkerPrompt({
      ...input,
      workerToken: agent.token,
      agentAlias: agent.alias,
      specialty: agent.specialty,
      projectRoot: session.projectRoot,
      sessionWorkspacePath: session.sessionWorkspacePath,
      phaseGoal: session.currentPhase?.goal,
      worktreePath: worktree.path,
      worktreeBranch: worktree.branch,
      sharedInstructionsPath,
      roster: session.agents,
      workItems,
      currentClaim,
    });
    const otelFilePath = agent.cli === "copilot"
      ? this.copilotOtelFilePath({
          sessionWorkspacePath: session.sessionWorkspacePath,
          cwd: worktree.path,
          agentAlias: agent.alias,
        })
      : undefined;
    const launch = this.adapterLaunch({
      cli: agent.cli,
      model: input.model ?? agent.model,
      reasoningEffort: input.reasoningEffort,
      mode,
      prompt,
      cwd: worktree.path,
      sessionWorkspacePath: session.sessionWorkspacePath,
      resumeSessionId: input.resumeSessionId,
      otelFilePath,
    });
    const runtime = this.store.registerRuntime({
      sessionId: input.sessionId,
      actorToken: input.actorToken,
      agentId: input.agentId,
      transport: `${agent.cli}-cli`,
      adapter: agent.cli,
      launchMode: mode,
      cliSessionId: input.resumeSessionId,
      command: this.summarizeLaunchCommand(launch, prompt),
      cwd: worktree.path,
      managedByServer: true,
      stdinWritable: mode === "pty" || (launch.stdin === "pipe" && capabilities.supportsPersistentStdin),
      resumeSupported: mode === "pty" ? false : capabilities.supportsResume,
      otelFilePath,
      heartbeatIntervalSeconds: 30,
    });

    const managed: ManagedWorker = {
      runtimeId: runtime.runtimeId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      actorToken: input.actorToken,
      cli: agent.cli,
      model: input.model ?? agent.model,
      reasoningEffort: input.reasoningEffort,
      launchMode: mode,
      stdinWritable: mode === "pty" || (launch.stdin === "pipe" && capabilities.supportsPersistentStdin),
      resumeSupported: mode === "pty" ? false : capabilities.supportsResume,
      cwd: worktree.path,
    };
    this.workers.set(runtime.runtimeId, managed);

    this.recordRuntimeLog({
      sessionId: input.sessionId,
      runtimeId: runtime.runtimeId,
      agentId: input.agentId,
      stream: "prompt",
      text: this.summarizeWorkerPrompt({
        agentAlias: agent.alias,
        agentId: input.agentId,
        cli: agent.cli,
        model: input.model ?? agent.model,
        launchMode: mode,
        worktreePath: worktree.path,
        workItemIds: input.workItemIds ?? [],
        roster: session.agents,
        sharedInstructionsPath,
      }),
    });

    try {
      if (mode === "pty") {
        const pty = spawnPty(launch.command, launch.args, {
          name: "xterm-256color",
          cols: 120,
          rows: 32,
          cwd: worktree.path,
          env: { ...process.env, ...launch.env, TEAMWORK_AGENT_ALIAS: agent.alias },
        });
        managed.pty = pty;
        this.store.updateRuntime({
          sessionId: input.sessionId,
          actorToken: input.actorToken,
          runtimeId: runtime.runtimeId,
          pid: pty.pid,
        });
        pty.onData((text) => {
          this.captureRuntimeMetadata({ cli: agent.cli, sessionId: input.sessionId, runtimeId: runtime.runtimeId, stream: "stdout", text });
          this.recordRuntimeLog({
            sessionId: input.sessionId,
            runtimeId: runtime.runtimeId,
            agentId: input.agentId,
            stream: "stdout",
            text,
          });
        });
        pty.onExit(({ exitCode }) => {
          this.store.updateRuntime({
            sessionId: input.sessionId,
            actorToken: input.actorToken,
            runtimeId: runtime.runtimeId,
            status: exitCode === 0 ? "exited" : "crashed",
            exitCode,
          });
          this.recordRuntimeLog({
            sessionId: input.sessionId,
            runtimeId: runtime.runtimeId,
            agentId: input.agentId,
            stream: "system",
            text: `pty process exited with code ${exitCode}`,
          });
          this.store.captureRuntimeHandoffCandidate({
            sessionId: input.sessionId,
            runtimeId: runtime.runtimeId,
            agentId: input.agentId,
          });
          this.workers.delete(runtime.runtimeId);
        });
        return { ...this.store.getRuntime(runtime.runtimeId), launchMode: mode };
      }
      const child = spawn(launch.command, launch.args, {
        cwd: worktree.path,
        env: { ...process.env, ...launch.env, TEAMWORK_AGENT_ALIAS: agent.alias },
        stdio: [launch.stdin, "pipe", "pipe"],
        windowsHide: true,
      });
      managed.child = child;
      if (child.pid) {
        this.store.updateRuntime({
          sessionId: input.sessionId,
          actorToken: input.actorToken,
          runtimeId: runtime.runtimeId,
          pid: child.pid,
        });
      }
      let spawnFailed = false;
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.captureRuntimeMetadata({ cli: agent.cli, sessionId: input.sessionId, runtimeId: runtime.runtimeId, stream: "stdout", text });
        this.recordRuntimeLog({
          sessionId: input.sessionId,
          runtimeId: runtime.runtimeId,
          agentId: input.agentId,
          stream: "stdout",
          text: this.redactRuntimeOutput(text),
        });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.captureRuntimeMetadata({ cli: agent.cli, sessionId: input.sessionId, runtimeId: runtime.runtimeId, stream: "stderr", text });
        this.recordRuntimeLog({
          sessionId: input.sessionId,
          runtimeId: runtime.runtimeId,
          agentId: input.agentId,
          stream: "stderr",
          text: this.redactRuntimeOutput(text),
        });
      });
      // Spawn ENOENT arrives on the child "error" event, not via the surrounding try/catch.
      // Handle it here so one missing CLI cannot crash the singleton and orphan every MCP session.
      child.on("error", (error) => {
        if (spawnFailed) return;
        spawnFailed = true;
        this.handleManagedSpawnError({
          sessionId: input.sessionId,
          actorToken: input.actorToken,
          runtimeId: runtime.runtimeId,
          agentId: input.agentId,
          message: `process failed to start: ${error.message}`,
          clearWorker: true,
        });
      });
      child.on("exit", (code) => {
        if (spawnFailed) return;
        const current = this.workers.get(runtime.runtimeId);
        if (!current) return;
        // Resumable CLIs can exit between turns while the logical worker session stays available.
        if (current.launchMode === "resume-command" && code === 0) {
          current.child = undefined;
          this.store.updateRuntime({
            sessionId: input.sessionId,
            actorToken: input.actorToken,
            runtimeId: runtime.runtimeId,
            status: "exited",
            exitCode: 0,
          });
          this.recordRuntimeLog({
            sessionId: input.sessionId,
            runtimeId: runtime.runtimeId,
            agentId: input.agentId,
            stream: "system",
            text: "resume-command process exited cleanly; logical worker session remains resumable",
          });
          this.store.captureRuntimeHandoffCandidate({
            sessionId: input.sessionId,
            runtimeId: runtime.runtimeId,
            agentId: input.agentId,
          });
          return;
        }
        this.store.updateRuntime({
          sessionId: input.sessionId,
          actorToken: input.actorToken,
          runtimeId: runtime.runtimeId,
          status: code === 0 ? "exited" : "crashed",
          exitCode: code ?? undefined,
        });
        this.recordRuntimeLog({
          sessionId: input.sessionId,
          runtimeId: runtime.runtimeId,
          agentId: input.agentId,
          stream: "system",
          text: `process exited with code ${code ?? "unknown"}`,
        });
        this.store.captureRuntimeHandoffCandidate({
          sessionId: input.sessionId,
          runtimeId: runtime.runtimeId,
          agentId: input.agentId,
        });
        this.workers.delete(runtime.runtimeId);
      });
    } catch (error) {
      this.store.updateRuntime({
        sessionId: input.sessionId,
        actorToken: input.actorToken,
        runtimeId: runtime.runtimeId,
        status: "crashed",
      });
      throw error;
    }

    return { ...this.store.getRuntime(runtime.runtimeId), launchMode: mode };
  }

  planLaunch(input: LaunchPhaseInput) {
    return this.buildLaunchPlan(input);
  }

  launchPhaseWorkers(input: LaunchPhaseInput) {
    this.store.requireParentActor({ sessionId: input.sessionId, actorToken: input.actorToken });
    const plan = this.buildLaunchPlan(input);
    if (!plan.readyToLaunch) {
      throw new Error(`Launch plan is not ready: ${plan.blockingIssues.join("; ")}`);
    }
    const launchErrors: Array<{ agentId: string; agentAlias: string; message: string }> = [];
    const runtimes = [];
    for (const entry of plan.workers) {
      try {
        runtimes.push(this.launchWorker({
          sessionId: input.sessionId,
          actorToken: input.actorToken,
          agentId: entry.agentId,
          worktreeId: entry.worktree.worktreeId,
          phaseNumber: input.phaseNumber,
          workItemIds: entry.workItems.map((item) => item.workItemId),
          pairRole: entry.pairRole,
          launchMode: input.launchMode,
          model: entry.model,
          reasoningEffort: entry.reasoningEffort,
        }));
      } catch (error) {
        launchErrors.push({
          agentId: entry.agentId,
          agentAlias: entry.alias,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      launchPlanId: plan.launchPlanId,
      runtimes,
      launchErrors,
    };
  }

  sendWorkerInput(input: { sessionId: string; actorToken: string; runtimeId: string; input: string }) {
    this.store.requireParentActor({ sessionId: input.sessionId, actorToken: input.actorToken });
    return this.deliverWorkerInput(input);
  }

  sendDashboardInput(input: { sessionId: string; runtimeId: string; input: string; raw?: boolean }) {
    return this.deliverWorkerInput(input);
  }

  resizeDashboardTerminal(input: { sessionId: string; runtimeId: string; cols: number; rows: number }) {
    const runtime = this.store.getRuntime(input.runtimeId);
    if (runtime.sessionId !== input.sessionId) throw new Error("Runtime does not belong to this session");
    const managed = this.workers.get(input.runtimeId);
    if (!managed?.pty) return { runtimeId: input.runtimeId, resized: false };
    managed.pty.resize(input.cols, input.rows);
    return { runtimeId: input.runtimeId, resized: true };
  }

  private deliverWorkerInput(input: { sessionId: string; actorToken?: string; runtimeId: string; input: string; raw?: boolean }) {
    const runtime = this.store.getRuntime(input.runtimeId);
    if (runtime.sessionId !== input.sessionId) throw new Error("Runtime does not belong to this session");
    const managed = this.workers.get(input.runtimeId);
    if (managed?.pty) {
      this.recordRuntimeLog({
        sessionId: input.sessionId,
        runtimeId: input.runtimeId,
        agentId: managed.agentId,
        stream: "stdin",
        text: input.input,
      });
      managed.pty.write(input.raw ? input.input : `${input.input}\r`);
      return { runtimeId: input.runtimeId, ok: true };
    }
    if (managed?.child?.stdin?.writable) {
      this.recordRuntimeLog({
        sessionId: input.sessionId,
        runtimeId: input.runtimeId,
        agentId: managed.agentId,
        stream: "stdin",
        text: input.input,
      });
      managed.child.stdin.write(input.raw ? input.input : `${input.input}\n`);
      return { runtimeId: input.runtimeId, ok: true };
    }
    if (runtime.resumeSupported) {
      if (!runtime.cliSessionId) {
        throw new Error(
          `Runtime cannot receive input yet: ${runtime.adapter ?? runtime.transport} supports resume input but no CLI session id has been captured.`
        );
      }
      const launch = this.adapterResume({
        cli: managed?.cli ?? runtime.adapter ?? runtime.transport.replace(/-cli$/, ""),
        model: managed?.model ?? this.store.getAgent(runtime.agentId).model,
        reasoningEffort: managed?.reasoningEffort,
        cliSessionId: runtime.cliSessionId,
        input: input.input,
        cwd: runtime.cwd,
        sessionWorkspacePath: this.store.getSessionSummary(input.sessionId).sessionWorkspacePath,
        otelFilePath: runtime.otelFilePath,
      });
      this.recordRuntimeLog({
        sessionId: input.sessionId,
        runtimeId: input.runtimeId,
        agentId: runtime.agentId,
        stream: "stdin",
        text: input.input,
      });
      const child = spawn(launch.command, launch.args, {
        cwd: runtime.cwd,
        env: { ...process.env, ...launch.env },
        stdio: [launch.stdin, "pipe", "pipe"],
        windowsHide: true,
      });
      if (managed) managed.child = child;
      let spawnFailed = false;
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.captureRuntimeMetadata({
          cli: managed?.cli ?? runtime.adapter ?? runtime.transport.replace(/-cli$/, ""),
          sessionId: input.sessionId,
          runtimeId: input.runtimeId,
          stream: "stdout",
          text,
        });
        this.recordRuntimeLog({
          sessionId: input.sessionId,
          runtimeId: input.runtimeId,
          agentId: runtime.agentId,
          stream: "stdout",
          text,
        });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.captureRuntimeMetadata({
          cli: managed?.cli ?? runtime.adapter ?? runtime.transport.replace(/-cli$/, ""),
          sessionId: input.sessionId,
          runtimeId: input.runtimeId,
          stream: "stderr",
          text,
        });
        this.recordRuntimeLog({
          sessionId: input.sessionId,
          runtimeId: input.runtimeId,
          agentId: runtime.agentId,
          stream: "stderr",
          text,
        });
      });
      child.on("error", (error) => {
        if (spawnFailed) return;
        spawnFailed = true;
        this.handleManagedSpawnError({
          sessionId: input.sessionId,
          actorToken: managed?.actorToken ?? input.actorToken ?? "",
          runtimeId: input.runtimeId,
          agentId: runtime.agentId,
          message: `resume command failed to start: ${error.message}`,
          clearWorker: false,
        });
      });
      child.on("exit", (code) => {
        if (spawnFailed) return;
        if (managed) managed.child = undefined;
        this.recordRuntimeLog({
          sessionId: input.sessionId,
          runtimeId: input.runtimeId,
          agentId: runtime.agentId,
          stream: "system",
          text: `resume command exited with code ${code ?? "unknown"}`,
        });
        if (code !== 0 && input.actorToken) {
          this.store.updateRuntime({
            sessionId: input.sessionId,
            actorToken: input.actorToken,
            runtimeId: input.runtimeId,
            status: "crashed",
            exitCode: code ?? undefined,
          });
        }
        this.store.captureRuntimeHandoffCandidate({
          sessionId: input.sessionId,
          runtimeId: input.runtimeId,
          agentId: runtime.agentId,
        });
      });
      return { runtimeId: input.runtimeId, ok: true };
    }
    throw new Error(
      `Runtime cannot receive input: inputDelivery=${runtime.inputDelivery}, status=${runtime.status}, stdinWritable=${runtime.stdinWritable}, resumeSupported=${runtime.resumeSupported}.`
    );
  }

  stopWorker(input: { sessionId: string; actorToken: string; runtimeId: string }) {
    this.store.requireParentActor({ sessionId: input.sessionId, actorToken: input.actorToken });
    const runtime = this.store.getRuntime(input.runtimeId);
    if (runtime.sessionId !== input.sessionId) throw new Error("Runtime does not belong to this session");
    const managed = this.workers.get(input.runtimeId);
    if (managed?.pty) {
      try {
        managed.pty.kill();
      } catch {
        /* process may already be gone */
      }
    }
    if (managed?.child && !managed.child.killed) {
      managed.child.kill("SIGTERM");
    }
    this.workers.delete(input.runtimeId);
    this.store.updateRuntime({
      sessionId: input.sessionId,
      actorToken: input.actorToken,
      runtimeId: input.runtimeId,
      status: "exited",
      exitCode: 0,
    });
    this.recordRuntimeLog({
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      agentId: runtime.agentId,
      stream: "system",
      text: "worker stopped by parent",
    });
    this.store.captureRuntimeHandoffCandidate({
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      agentId: runtime.agentId,
    });
    return { runtimeId: input.runtimeId, status: "exited" as const };
  }

  stopSessionWorkers(input: { sessionId: string; actorToken: string }) {
    const stopped = this.store
      .listRuntimes({ sessionId: input.sessionId })
      .runtimes.filter((runtime) => runtime.managedByServer && runtime.status === "running")
      .map((runtime) =>
        this.stopWorker({
          sessionId: input.sessionId,
          actorToken: input.actorToken,
          runtimeId: runtime.runtimeId,
        })
      );
    return { stopped };
  }

  restartWorker(input: {
    sessionId: string;
    actorToken: string;
    runtimeId: string;
    worktreeId: string;
    phaseNumber: number;
    pairRole?: "implementer" | "reviewer-tester";
    launchMode?: LaunchMode;
  }) {
    const runtime = this.store.getRuntime(input.runtimeId);
    const resumeSessionId = runtime.cliSessionId;
    this.stopWorker({ sessionId: input.sessionId, actorToken: input.actorToken, runtimeId: input.runtimeId });
    return this.launchWorker({
      sessionId: input.sessionId,
      actorToken: input.actorToken,
      agentId: runtime.agentId,
      worktreeId: input.worktreeId,
      phaseNumber: input.phaseNumber,
      pairRole: input.pairRole,
      launchMode: input.launchMode,
      resumeSessionId,
    });
  }

  getWorkerLog(input: {
    sessionId: string;
    actorToken: string;
    runtimeId: string;
    mode?: "new" | "tail" | "all";
    limit?: number;
    afterRuntimeLogId?: string;
  }) {
    const parent = this.store.requireParentActor({ sessionId: input.sessionId, actorToken: input.actorToken });
    const runtime = this.store.getRuntime(input.runtimeId);
    if (runtime.sessionId !== input.sessionId) throw new Error("Runtime does not belong to this session");
    return this.store.readRuntimeLogs({
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      parentAgentId: parent.agentId,
      mode: input.mode,
      limit: input.limit,
      afterRuntimeLogId: input.afterRuntimeLogId,
    });
  }

  listWorkerProcesses(input: { sessionId: string; actorToken: string }) {
    this.store.requireParentActor({ sessionId: input.sessionId, actorToken: input.actorToken });
    const runtimes = this.store
      .listRuntimes({ sessionId: input.sessionId })
      .runtimes.filter((runtime) => runtime.managedByServer);
    return { runtimes };
  }

  private buildLaunchPlan(input: LaunchPhaseInput) {
    this.store.requireParentActor({ sessionId: input.sessionId, actorToken: input.actorToken });
    const summary = this.store.getSessionSummary(input.sessionId);
    const workers = summary.agents.filter(
      (agent) => agent.role === "worker" && (!input.agentIds || input.agentIds.includes(agent.agentId))
    );
    const allWorkItems = this.store.listWorkItems({ sessionId: input.sessionId, phaseNumber: input.phaseNumber }).workItems;
    const warnings: string[] = [];
    const blockingIssues: string[] = [];
    if (!summary.sessionWorkspacePath) {
      blockingIssues.push("Session is missing sessionWorkspacePath; create_session must include sessionWorkspacePath before workers can be planned as launch-ready or launched.");
    }
    if (workers.length > 1 && workers.length > allWorkItems.length && allWorkItems.length > 0) {
      warnings.push(
        `Phase ${input.phaseNumber} has ${workers.length} workers for ${allWorkItems.length} work items; confirm the split is independent enough to justify the extra coordination overhead.`
      );
    }
    const multiAssigneeWorkItems = allWorkItems.filter((item) => item.assigneeAgentIds.length > 1);
    if (workers.length > 2 && multiAssigneeWorkItems.length > 0) {
      warnings.push(
        `Phase ${input.phaseNumber} has ${multiAssigneeWorkItems.length} shared work items across ${workers.length} workers; lock field names, ownership, and shared-file boundaries before launch or consider fewer workers.`
      );
    }
    const plannedWorkers = workers.map((agent) => {
      const worktrees = this.store.listWorktrees({ sessionId: input.sessionId, agentId: agent.agentId }).worktrees;
      const worktree = worktrees[0];
      if (!worktree) {
        blockingIssues.push(`Worker ${agent.alias} has no registered worktree`);
      }
      const capabilities = this.adapterCapabilities(agent.cli);
      const requestedLaunchMode = input.launchMode ?? this.defaultLaunchMode(agent.cli);
      const launchMode = this.normalizeLaunchMode(agent.cli, requestedLaunchMode, capabilities);
      const configuredWorkItemIds = input.workItemIdsByAgentId?.[agent.agentId];
      const workItems = allWorkItems.filter((item) =>
        configuredWorkItemIds?.length
          ? configuredWorkItemIds.includes(item.workItemId)
          : item.ownerAgentId === agent.agentId || item.assigneeAgentIds.includes(agent.agentId)
      );
      const missingConfiguredWorkItemIds = (configuredWorkItemIds ?? []).filter(
        (workItemId) => !allWorkItems.some((item) => item.workItemId === workItemId)
      );
      if (missingConfiguredWorkItemIds.length > 0) {
        blockingIssues.push(`Worker ${agent.alias} has unknown phase ${input.phaseNumber} work items: ${missingConfiguredWorkItemIds.join(", ")}`);
      }
      if (workItems.length === 0) {
        warnings.push(`Worker ${agent.alias} has no phase ${input.phaseNumber} work items`);
      }
      return {
        agentId: agent.agentId,
        alias: agent.alias,
        specialty: agent.specialty,
        cli: agent.cli,
        model: input.modelOverrides?.[agent.agentId] ?? agent.model,
        reasoningEffort: input.reasoningEffortOverrides?.[agent.agentId] ?? input.reasoningEffort ?? "low",
        launchMode,
        requestedLaunchMode,
        launchModeNormalized: requestedLaunchMode !== launchMode,
        pairRole: input.pairRoles?.[agent.agentId],
        worktree: worktree ?? {
          worktreeId: "",
          path: "",
          branch: "",
          status: "missing",
        },
        workItems: workItems.map((item) => ({
          workItemId: item.workItemId,
          title: item.title,
          status: item.status,
          ownerAlias: item.ownerAlias,
          assigneeAliases: item.assigneeAliases,
        })),
      };
    });
    if (workers.length === 0) {
      blockingIssues.push("No worker agents matched the launch selection");
    }
    const readyToLaunch = blockingIssues.length === 0;
    return {
      launchPlanId: `${input.sessionId}:phase-${input.phaseNumber}:${Date.now()}`,
      sessionId: input.sessionId,
      phaseNumber: input.phaseNumber,
      workerCount: plannedWorkers.length,
      readyToLaunch,
      blockingIssues,
      warnings,
      workers: plannedWorkers,
    };
  }

  private adapterLaunch(input: {
    cli: string;
    model: string;
    reasoningEffort?: string;
    mode: LaunchMode;
    prompt: string;
    cwd: string;
    sessionWorkspacePath?: string;
    resumeSessionId?: string;
    otelFilePath?: string;
  }): AdapterLaunch {
    if (input.cli === "fake") {
      if (!this.options.fakeCliPath) throw new Error("TEAMWORK_FAKE_CLI_PATH is required for fake workers");
      return { command: process.execPath, args: [this.options.fakeCliPath, input.prompt], stdin: "pipe" };
    }
    if (input.cli === "codex") {
      const effort = input.reasoningEffort ?? "low";
      const command = process.env.TEAMWORK_CODEX_BIN ?? "codex";
      if (input.mode === "pty") {
        return this.adapterCommand(
          command,
          ["--model", input.model, "-c", "hide_agent_reasoning=true", "-c", `model_reasoning_effort=${effort}`, input.prompt],
          "ignore"
        );
      }
      if (input.resumeSessionId && input.mode !== "oneshot") {
        return this.adapterCommand(command, ["exec", "--model", input.model, "resume", input.resumeSessionId, input.prompt], "ignore");
      }
      return this.adapterCommand(
        command,
        ["exec", "--model", input.model, "-c", "hide_agent_reasoning=true", "-c", `model_reasoning_effort=${effort}`, input.prompt],
        "ignore"
      );
    }
    if (input.cli === "copilot") {
      const effort = input.reasoningEffort ?? "low";
      const command = process.env.TEAMWORK_COPILOT_BIN ?? "copilot";
      if (input.mode === "pty") {
        const args = ["--interactive", input.prompt, "--model", input.model, "--reasoning-effort", effort, "--allow-all-tools"];
        args.push(...this.copilotShareArgs({ cwd: input.cwd, sessionWorkspacePath: input.sessionWorkspacePath }));
        args.push("--no-ask-user", "--no-auto-update", "--no-remote", "--add-dir", input.cwd);
        args.push(...this.copilotMcpArgs({ cwd: input.cwd, sessionWorkspacePath: input.sessionWorkspacePath }));
        return this.withCopilotObservabilityEnv(
          this.withTeamworkMcpEnv(this.adapterCommand(command, args, "ignore")),
          input.otelFilePath
        );
      }
      const args = ["-p", input.prompt];
      if (input.resumeSessionId && input.mode !== "oneshot") args.push("--resume", input.resumeSessionId);
      args.push("--model", input.model, "--reasoning-effort", effort, "--allow-all-tools");
      args.push(...this.copilotShareArgs({ cwd: input.cwd, sessionWorkspacePath: input.sessionWorkspacePath }));
      args.push("--no-ask-user", "--no-auto-update", "--no-remote", "--add-dir", input.cwd);
      args.push(...this.copilotMcpArgs({ cwd: input.cwd, sessionWorkspacePath: input.sessionWorkspacePath }));
      return this.withCopilotObservabilityEnv(
        this.withTeamworkMcpEnv(this.adapterCommand(command, args, "ignore")),
        input.otelFilePath
      );
    }
    if (input.cli === "claude") {
      const command = process.env.TEAMWORK_CLAUDE_BIN ?? "claude";
      if (input.mode === "pty") {
        return this.adapterCommand(command, ["--model", input.model, input.prompt], "ignore");
      }
      const args = ["--model", input.model, "--print", "--output-format", "stream-json"];
      if (input.resumeSessionId && input.mode !== "oneshot") args.push("--resume", input.resumeSessionId);
      args.push(input.prompt);
      return this.adapterCommand(command, args, "ignore");
    }
    if (input.cli === "gemini") {
      const command = process.env.TEAMWORK_GEMINI_BIN ?? "gemini";
      if (input.mode === "pty") {
        return this.adapterCommand(command, ["--model", input.model, "--prompt", input.prompt], "ignore");
      }
      const args = ["--prompt", input.prompt, "--model", input.model, "--output-format", "stream-json"];
      if (input.resumeSessionId && input.mode !== "oneshot") args.unshift("--resume", input.resumeSessionId);
      return this.adapterCommand(command, args, "ignore");
    }
    if (input.cli === "opencode") {
      const command = process.env.TEAMWORK_OPENCODE_BIN ?? "opencode";
      if (input.mode === "pty") {
        return this.adapterCommand(command, ["--model", input.model, input.prompt], "ignore");
      }
      const args = ["run", "--model", input.model, "--format", "json"];
      if (input.resumeSessionId && input.mode !== "oneshot") args.push("--session", input.resumeSessionId);
      args.push(input.prompt);
      return this.adapterCommand(command, args, "ignore");
    }
    throw new Error(`No server-managed CLI adapter is configured for ${input.cli}`);
  }

  private adapterCapabilities(cli: string): AdapterCapabilities {
    if (cli === "fake") {
      return {
        supportsPersistentStdin: true,
        supportsResume: false,
        resumableAfterExit: false,
        sessionIdStreams: ["stdout"],
      };
    }
    if (cli === "copilot") {
      return {
        supportsPersistentStdin: false,
        supportsResume: true,
        resumableAfterExit: true,
        sessionIdStreams: ["stdout", "stderr"],
      };
    }
    if (["codex", "claude", "gemini", "opencode"].includes(cli)) {
      return {
        supportsPersistentStdin: false,
        supportsResume: true,
        resumableAfterExit: true,
        sessionIdStreams: ["stdout", "stderr"],
      };
    }
    return {
      supportsPersistentStdin: false,
      supportsResume: false,
      resumableAfterExit: false,
      sessionIdStreams: ["stdout", "stderr"],
    };
  }

  private normalizeLaunchMode(cli: string, requestedMode: LaunchMode, capabilities: AdapterCapabilities): LaunchMode {
    if (requestedMode === "persistent-stdin" && !capabilities.supportsPersistentStdin) {
      if (capabilities.supportsResume) return "resume-command";
      return "oneshot";
    }
    return requestedMode;
  }

  private adapterResume(input: {
    cli: string;
    model: string;
    reasoningEffort?: string;
    cliSessionId?: string;
    input: string;
    cwd?: string;
    sessionWorkspacePath?: string;
    otelFilePath?: string;
  }): AdapterLaunch {
    if (input.cli === "codex") {
      if (!input.cliSessionId) throw new Error("Codex resume requires a captured CLI session id");
      return this.adapterCommand(
        process.env.TEAMWORK_CODEX_BIN ?? "codex",
        ["exec", "--model", input.model, "resume", input.cliSessionId, input.input],
        "ignore"
      );
    }
    if (input.cli === "copilot") {
      const effort = input.reasoningEffort ?? "low";
      if (!input.cliSessionId) throw new Error("Copilot resume requires a captured CLI session id");
      const args = [
        "-p",
        input.input,
        "--resume",
        input.cliSessionId,
        "--model",
        input.model,
        "--reasoning-effort",
        effort,
        "--allow-all-tools",
        "--no-ask-user",
        "--no-auto-update",
        "--no-remote",
      ];
      if (input.cwd) args.push("--add-dir", input.cwd);
      args.push(...this.copilotMcpArgs({ cwd: input.cwd, sessionWorkspacePath: input.sessionWorkspacePath }));
      return this.withCopilotObservabilityEnv(
        this.withTeamworkMcpEnv(this.adapterCommand(process.env.TEAMWORK_COPILOT_BIN ?? "copilot", args, "ignore")),
        input.otelFilePath
      );
    }
    if (input.cli === "claude") {
      if (!input.cliSessionId) throw new Error("Claude resume requires a captured CLI session id");
      return this.adapterCommand(
        process.env.TEAMWORK_CLAUDE_BIN ?? "claude",
        ["--model", input.model, "--resume", input.cliSessionId, "--print", "--output-format", "stream-json", input.input],
        "ignore"
      );
    }
    if (input.cli === "gemini") {
      if (!input.cliSessionId) throw new Error("Gemini resume requires a captured CLI session id");
      return this.adapterCommand(
        process.env.TEAMWORK_GEMINI_BIN ?? "gemini",
        ["--resume", input.cliSessionId, "--prompt", input.input, "--model", input.model, "--output-format", "stream-json"],
        "ignore"
      );
    }
    if (input.cli === "opencode") {
      if (!input.cliSessionId) throw new Error("OpenCode resume requires a captured CLI session id");
      return this.adapterCommand(
        process.env.TEAMWORK_OPENCODE_BIN ?? "opencode",
        ["run", "--session", input.cliSessionId, "--model", input.model, "--format", "json", input.input],
        "ignore"
      );
    }
    throw new Error(`No resume-command adapter is configured for ${input.cli}`);
  }

  private adapterCommand(command: string, args: string[], stdin: AdapterLaunch["stdin"]): AdapterLaunch {
    if (process.platform === "win32" && /[\\/]/.test(command) && !/\.(exe|com|cmd|bat|ps1)$/i.test(command)) {
      return { command: process.execPath, args: [command, ...args], stdin };
    }
    return { command, args, stdin };
  }

  private summarizeLaunchCommand(launch: AdapterLaunch, prompt: string) {
    const args = launch.args.map((arg, index) => {
      const previous = launch.args[index - 1];
      if (arg === prompt) return "[worker-prompt redacted]";
      if (previous === "-p" || previous === "--prompt" || previous === "--interactive") return "[worker-prompt redacted]";
      return this.redactRuntimeOutput(arg);
    });
    return [launch.command, ...args].join(" ");
  }

  private summarizeWorkerPrompt(input: {
    agentAlias: string;
    agentId: string;
    cli: string;
    model: string;
    launchMode: LaunchMode;
    worktreePath: string;
    workItemIds: string[];
    roster: Array<{
      agentId: string;
      alias: string;
      specialty: string;
      responsibility?: string;
      role: string;
      status: string;
    }>;
    sharedInstructionsPath: string;
  }) {
    return [
      "worker prompt stored redacted",
      `alias: ${input.agentAlias}`,
      `agentId: ${input.agentId}`,
      `cli: ${input.cli}`,
      `model: ${input.model}`,
      `launchMode: ${input.launchMode}`,
      `WORKSPACE_DIR: ${input.worktreePath}`,
      `ALLOWED_AGENT_MCPS: ${this.allowedAgentMcps().join(", ") || "none"}`,
      `ALLOWED_SKILLS: ${this.allowedSkills().join(", ") || "none"}`,
      `workItemIds: ${input.workItemIds.join(", ") || "none supplied"}`,
      "teamRoster:",
      ...input.roster.map(
        (agent) =>
          `- alias=${agent.alias}; agentId=${agent.agentId}; role=${agent.role}; specialty=${agent.specialty}; responsibility=${agent.responsibility || "not supplied by parent"}; status=${agent.status}`
      ),
      `sharedInstructionsPath: ${input.sharedInstructionsPath}`,
    ].join("\n");
  }

  private redactRuntimeOutput(text: string) {
    return text
      .replace(
        /You are a teamwork CLI worker managed by teamwork-mcp\.[\s\S]*?Use teamwork-mcp messages for worker coordination and record your result before handoff\./g,
        `[worker prompt output redacted; ${text.length} chars]`
      )
      .replace(/(actorToken:\s*)[^\s]+/gi, "$1[redacted]")
      .replace(/("actorToken"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
      .replace(/(--?(?:p|prompt|interactive)(?:=|\s+))("?)You are a teamwork CLI worker managed by teamwork-mcp[\s\S]*?(\2)(?=\s--|\s-[A-Za-z]|$)/g, "$1$2[worker-prompt redacted]$2");
  }

  private withTeamworkMcpEnv(launch: AdapterLaunch): AdapterLaunch {
    return {
      ...launch,
      env: {
        ...launch.env,
        TEAMWORK_MCP_URL: this.teamworkMcpUrl(),
      },
    };
  }

  private withCopilotObservabilityEnv(launch: AdapterLaunch, otelFilePath?: string): AdapterLaunch {
    if (!otelFilePath) return launch;
    mkdirSync(path.dirname(otelFilePath), { recursive: true });
    return {
      ...launch,
      env: {
        ...launch.env,
        COPILOT_OTEL_ENABLED: "true",
        COPILOT_OTEL_EXPORTER_TYPE: "file",
        COPILOT_OTEL_FILE_EXPORTER_PATH: otelFilePath,
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
      },
    };
  }

  private copilotMcpArgs(input: { cwd?: string; sessionWorkspacePath?: string }) {
    const configPath = this.writeCopilotMcpConfig(input);
    const args = ["--additional-mcp-config", `@${configPath}`];
    for (const serverName of this.copilotMcpServersToDisable(input.cwd)) {
      args.push("--disable-mcp-server", serverName);
    }
    return args;
  }

  private copilotShareArgs(input: { cwd?: string; sessionWorkspacePath?: string }) {
    if (!input.sessionWorkspacePath) return [];
    const exportDir = path.resolve(input.sessionWorkspacePath, "worker-session-exports");
    mkdirSync(exportDir, { recursive: true });
    const workspaceName = input.cwd ? path.basename(path.resolve(input.cwd)) : "worker";
    const exportPath = path.join(exportDir, `${workspaceName}-${Date.now()}-${process.pid}.md`);
    return ["--share", exportPath];
  }

  private copilotOtelFilePath(input: { cwd?: string; sessionWorkspacePath?: string; agentAlias: string }) {
    const baseDir = input.sessionWorkspacePath
      ? path.resolve(input.sessionWorkspacePath, "usage", "copilot")
      : path.resolve(input.cwd ?? process.cwd(), ".teamwork", "usage", "copilot");
    mkdirSync(baseDir, { recursive: true });
    const safeAlias = input.agentAlias.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "worker";
    return path.join(baseDir, `${safeAlias}-${Date.now()}-${process.pid}.otel.jsonl`);
  }

  private writeCopilotMcpConfig(input: { cwd?: string; sessionWorkspacePath?: string }) {
    const baseDir = input.sessionWorkspacePath
      ? path.resolve(input.sessionWorkspacePath, "worker-mcp-config")
      : path.resolve(input.cwd ?? process.cwd(), ".teamwork");
    mkdirSync(baseDir, { recursive: true });
    const configPath = path.join(baseDir, "copilot-teamwork-mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            teamwork: {
              transport: "http",
              url: this.teamworkMcpUrl(),
              tools: ["*"],
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );
    return configPath;
  }

  private teamworkMcpUrl() {
    return process.env.TEAMWORK_MCP_URL ?? `http://127.0.0.1:${process.env.TEAMWORK_UI_PORT ?? "48741"}/mcp`;
  }

  private copilotMcpServersToDisable(cwd?: string) {
    const configured = new Set<string>();
    const allowed = new Set(this.allowedAgentMcps().map((name) => name.toLowerCase()));
    for (const name of (process.env.TEAMWORK_COPILOT_DISABLE_MCP_SERVERS ?? "").split(",")) {
      const trimmed = name.trim();
      if (trimmed) configured.add(trimmed);
    }
    for (const configPath of this.copilotMcpConfigPaths(cwd ?? process.cwd())) {
      for (const name of this.readMcpServerNames(configPath)) configured.add(name);
    }
    return [...configured].filter((name) => name !== "teamwork" && !allowed.has(name.toLowerCase())).sort();
  }

  private allowedAgentMcps() {
    return this.csvEnv("TEAMWORK_ALLOWED_AGENT_MCPS");
  }

  private allowedSkills() {
    return this.csvEnv("TEAMWORK_ALLOWED_SKILLS");
  }

  private csvEnv(name: string) {
    return (process.env[name] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private copilotMcpConfigPaths(cwd: string) {
    const paths = [path.join(os.homedir(), ".copilot", "mcp-config.json")];
    let current = path.resolve(cwd);
    while (true) {
      paths.push(path.join(current, ".mcp.json"));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return paths;
  }

  private readMcpServerNames(configPath: string) {
    if (!existsSync(configPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || !parsed.mcpServers || typeof parsed.mcpServers !== "object") return [];
      return Object.keys(parsed.mcpServers);
    } catch {
      return [];
    }
  }

  private captureRuntimeMetadata(input: {
    cli: string;
    sessionId: string;
    runtimeId: string;
    stream: "stdout" | "stderr";
    text: string;
  }) {
    const capabilities = this.adapterCapabilities(input.cli);
    if (!capabilities.sessionIdStreams.includes(input.stream)) return;
    const sessionExportPath = this.extractSessionExportPath(input.text);
    const cliSessionId = this.extractSessionId(input.cli, input.text) ?? (
      sessionExportPath ? this.extractSessionId(input.cli, sessionExportPath) : undefined
    );
    if (cliSessionId || sessionExportPath) {
      this.store.updateRuntimeMetadata({
        sessionId: input.sessionId,
        runtimeId: input.runtimeId,
        cliSessionId,
        sessionExportPath,
      });
    }
  }

  private extractSessionId(cli: string, text: string) {
    const jsonSessionId = this.extractJsonSessionId(text);
    if (jsonSessionId) return jsonSessionId;
    if (cli === "codex") {
      return text.match(/session id:\s*([^\s]+)/i)?.[1];
    }
    if (cli === "copilot") {
      return text.match(/copilot-session-([A-Za-z0-9_-]+)\.md/)?.[1];
    }
    if (cli === "claude" || cli === "gemini" || cli === "opencode") {
      return text.match(/session(?: id|ID)?:\s*([A-Za-z0-9_-]+)/i)?.[1];
    }
    return undefined;
  }

  private extractSessionExportPath(text: string) {
    return text.match(/Session exported to:\s*(.+?)(?:\r?\n|$)/i)?.[1]?.trim();
  }

  // Headless CLIs expose resumable session ids under different JSON keys.
  private extractJsonSessionId(text: string) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const event = JSON.parse(trimmed);
        const sessionId = event.session_id ?? event.sessionId ?? event.sessionID ?? event.session?.id;
        if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private defaultLaunchMode(cli: string): LaunchMode {
    return cli === "fake" ? "persistent-stdin" : "resume-command";
  }

  private prepareSharedInstructions(input: { sessionWorkspacePath?: string; worktreePath: string }) {
    if (!input.sessionWorkspacePath) throw new Error("Cannot launch worker without a session workspace path");
    const source = path.resolve(__dirname, "..", "..", "teamwork", "WORKER_SHARED_INSTRUCTIONS.md");
    if (!existsSync(source)) {
      throw new Error(`Worker shared instructions source is missing: ${source}`);
    }
    const targetDir = path.resolve(input.sessionWorkspacePath, "worker-instructions");
    const target = path.join(targetDir, "WORKER_SHARED_INSTRUCTIONS.md");
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(source, target);
    const worktreeTargetDir = path.resolve(input.worktreePath, ".teamwork");
    const worktreeTarget = path.join(worktreeTargetDir, "WORKER_SHARED_INSTRUCTIONS.md");
    mkdirSync(worktreeTargetDir, { recursive: true });
    copyFileSync(source, worktreeTarget);
    accessSync(target, constants.R_OK);
    accessSync(worktreeTarget, constants.R_OK);
    accessSync(input.worktreePath, constants.R_OK);
    return worktreeTarget;
  }

  private buildWorkerPrompt(input: {
    sessionId: string;
    agentId: string;
    agentAlias: string;
    specialty: string;
    workerToken: string;
    phaseNumber: number;
    phaseGoal?: string;
    projectRoot: string;
    sessionWorkspacePath?: string;
    worktreePath: string;
    worktreeBranch: string;
    sharedInstructionsPath: string;
    workItemIds?: string[];
    pairRole?: "implementer" | "reviewer-tester";
    roster: Array<{
      agentId: string;
      alias: string;
      specialty: string;
      responsibility?: string;
      cli: string;
      model: string;
      role: string;
      status: string;
    }>;
    workItems: Array<{
      workItemId: string;
      title: string;
      description: string;
      status: string;
      acceptanceCriteria?: string;
      activeClaims: Array<{ agentId: string; agentAlias: string; claimId: string; claimedAt: string }>;
    }>;
    currentClaim?: {
      claimId: string;
      workItemId: string;
      title: string;
      description: string;
      status: string;
      claimedAt: string;
    };
  }) {
    const allowedAgentMcps = this.allowedAgentMcps();
    const allowedSkills = this.allowedSkills();
    return [
      "You are a teamwork CLI worker managed by teamwork-mcp.",
      `WORKSPACE_DIR: ${input.worktreePath}`,
      `PROJECT_ROOT: ${input.projectRoot}`,
      `TEAMWORK_MCP_URL: ${process.env.TEAMWORK_MCP_URL ?? `http://127.0.0.1:${process.env.TEAMWORK_UI_PORT ?? "48741"}/mcp`}`,
      `ALLOWED_AGENT_MCPS: ${allowedAgentMcps.join(", ") || "none"}`,
      `ALLOWED_SKILLS: ${allowedSkills.join(", ") || "none"}`,
      `sessionId: ${input.sessionId}`,
      `agentId: ${input.agentId}`,
      `actorToken: ${input.workerToken}`,
      `alias: ${input.agentAlias}`,
      `specialty: ${input.specialty}`,
      `PAIR_ROLE: ${input.pairRole ?? "not assigned"}`,
      `phaseNumber: ${input.phaseNumber}`,
      `phaseGoal: ${input.phaseGoal ?? "not supplied"}`,
      `worktreeBranch: ${input.worktreeBranch}`,
      `sessionWorkspacePath: ${input.sessionWorkspacePath ?? "not supplied"}`,
      `assignedQueueIds: ${(input.workItemIds ?? []).join(", ") || "all assigned items for this phase"}`,
      "currentClaim:",
      ...(input.currentClaim
        ? [
            `- ${input.currentClaim.workItemId}: ${input.currentClaim.title} [${input.currentClaim.status}]`,
            `  claimId: ${input.currentClaim.claimId}`,
            `  claimedAt: ${input.currentClaim.claimedAt}`,
            `  description: ${input.currentClaim.description}`,
          ]
        : ["- none"]),
      "Essential worker rules:",
      "- Work only inside WORKSPACE_DIR. Do not inspect or mutate PROJECT_ROOT except through your assigned worktree.",
      "- Do not run user-global bootstrap/notification scripts such as record-start.ps1 or check-notify.ps1.",
      "- Do not run package installs, repo-wide builds, typechecks, or test suites unless the parent explicitly assigned that validation work to you.",
      "- DO NOT USE ANY SKILL OR MCP EVER except the teamwork MCP, which is mandatory. Only use additional MCPs listed in ALLOWED_AGENT_MCPS and only use skills listed in ALLOWED_SKILLS. If either list is none, there are no exceptions for that category.",
      "- Use only the teamwork MCP tool for coordination: list_agents, wait_for_messages/list_messages, ack_messages, send_message, claim_work_item, update_work_item_status, record_result.",
      "- wait_for_messages duration option is waitMs. timeout, timeoutMs, and timeoutSeconds are accepted as compatibility aliases, but prefer waitMs in new calls.",
      "- Before detailed work, choose exactly one assignedQueue item and call claim_work_item with its exact workItemId; then work only that claimed item until you record_result or block it.",
      "- Avoid recursive/global searches in .aa, .teamwork, worker-session-exports, worker-mcp-config, node_modules, dist, build, bin, and obj; those folders contain generated files, symlinks, or session artifacts that can cause permission and IO noise.",
      "- Confirm your registered worktree with list_worktrees if needed; do not call register_worktree because that is parent-only.",
      "- Use the roster as your ownership map. If another worker's specialty/responsibility clearly owns knowledge you need, ask that worker directly through MCP instead of rediscovering that domain; do not message others for routine facts inside your own slice. If you lose roster context, call list_agents.",
      "- The parent owns default validation and TDD loops. If you did not run slice-local verification, say that plainly in verificationSummary instead of implying tests passed.",
      "- For code changes, leave a clean commit in your worktree and record_result with resultType \"commit\", commitSha, and verificationSummary before handoff.",
      "- For review or validation-only slices, record_result with resultType \"note\" and a concise string or JSON-object data payload.",
      "- For validation slices, preserve the exact candidate IDs/numbers from the parent prompt. Do not introduce new finding IDs unless the parent explicitly asks for new discovery.",
      "- Do not create or commit Copilot/CLI session artifacts such as copilot-session-*.md in WORKSPACE_DIR.",
      "- After the slice is complete, remain logically idle/resumable and continue checking Teamwork messages until final teardown.",
      "teamRoster:",
      ...input.roster.map(
        (agent) =>
          `- alias: ${agent.alias}\n  agentId: ${agent.agentId}\n  role: ${agent.role}\n  specialty: ${agent.specialty}\n  responsibility: ${agent.responsibility || "not supplied by parent"}\n  cliModel: ${agent.cli}/${agent.model}\n  status: ${agent.status}`
      ),
      "assignedQueue:",
      ...(input.workItems.length
        ? input.workItems.flatMap((item) => [
            `- ${item.workItemId}: ${item.title} [${item.status}]`,
            `  description: ${item.description}`,
            item.activeClaims.length
              ? `  activeClaims: ${item.activeClaims.map((claim) => `${claim.agentAlias}:${claim.claimId}`).join(", ")}`
              : "  activeClaims: none",
            item.acceptanceCriteria ? `  acceptanceCriteria: ${item.acceptanceCriteria}` : undefined,
          ].filter((line): line is string => Boolean(line)))
        : ["- none supplied"]),
      `Read the shared worker instructions before doing phase work: ${input.sharedInstructionsPath}`,
      "The shared instructions are copied into your worktree-local .teamwork folder; do not search outside WORKSPACE_DIR for them.",
      "Use teamwork-mcp messages for worker coordination and record your result before handoff.",
    ].join("\n");
  }
}
