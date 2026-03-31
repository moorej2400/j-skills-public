type DashboardSession = {
  sessionId: string;
  title: string;
  taskSlug: string;
  status: string;
  currentPhase?: {
    phaseNumber: number;
    title: string;
    goal: string;
  };
  activeAgents: Array<{
    agentId: string;
    alias: string;
    specialty: string;
    role: string;
    status: string;
  }>;
  workItems: Array<{
    workItemId: string;
    title: string;
    status: string;
    ownerAlias?: string;
  }>;
  latestMessage?: {
    senderAlias: string;
    body: string;
  };
  worktrees?: Array<{
    alias?: string;
    branch?: string;
    path?: string;
    status?: string;
  }>;
  runtimes?: Array<{
    alias?: string;
    phaseNumber?: number;
    summary: string;
  }>;
  results?: Array<{
    alias?: string;
    status?: string;
    summary: string;
  }>;
  checkpoints?: Array<{
    label?: string;
    status?: string;
    summary: string;
  }>;
};

export function renderDashboardPage(sessions: DashboardSession[]) {
  const cards = sessions
    .map((session) => {
      const phase = session.currentPhase
        ? `<p><strong>Phase ${session.currentPhase.phaseNumber}:</strong> ${escapeHtml(session.currentPhase.title)}</p>
           <p><strong>Goal:</strong> ${escapeHtml(session.currentPhase.goal)}</p>`
        : "<p><strong>Phase:</strong> not started</p>";
      const latestMessage = session.latestMessage
        ? `<p><strong>Latest:</strong> ${escapeHtml(session.latestMessage.senderAlias)}: ${escapeHtml(session.latestMessage.body)}</p>`
        : "<p><strong>Latest:</strong> none yet</p>";
      const agents = session.activeAgents.length > 0
        ? `<ul>${session.activeAgents
            .map((agent) => `<li>${escapeHtml(agent.alias)} (${escapeHtml(agent.specialty)})</li>`)
            .join("")}</ul>`
        : "<p>No active agents</p>";
      const workItems = session.workItems.length > 0
        ? `<ul>${session.workItems
            .map(
              (workItem) =>
                `<li>${escapeHtml(workItem.title)}${workItem.ownerAlias ? ` - ${escapeHtml(workItem.ownerAlias)}` : ""} <span class="muted">(${escapeHtml(workItem.status)})</span></li>`
            )
            .join("")}</ul>`
        : "<p>No work items yet</p>";
      const operations = [
        renderSection(
          "Worktrees",
          session.worktrees,
          (worktree) =>
            `${escapeHtml(worktree.alias ?? "worker")} — ${escapeHtml(worktree.status ?? "unknown")}${worktree.branch ? ` · ${escapeHtml(worktree.branch)}` : ""}${worktree.path ? `<br /><span class="detail">${escapeHtml(worktree.path)}</span>` : ""}`
        ),
        renderSection(
          "Runtime Packets",
          session.runtimes,
          (runtime) =>
            `${escapeHtml(runtime.alias ?? "worker")}${runtime.phaseNumber === undefined ? "" : ` · phase ${runtime.phaseNumber}`}<br /><span class="detail">${escapeHtml(runtime.summary)}</span>`
        ),
        renderSection(
          "Results",
          session.results,
          (result) =>
            `${escapeHtml(result.alias ?? "worker")}${result.status ? ` — ${escapeHtml(result.status)}` : ""}<br /><span class="detail">${escapeHtml(result.summary)}</span>`
        ),
        renderSection(
          "Checkpoints",
          session.checkpoints,
          (checkpoint) =>
            `${escapeHtml(checkpoint.label ?? "checkpoint")}${checkpoint.status ? ` — ${escapeHtml(checkpoint.status)}` : ""}<br /><span class="detail">${escapeHtml(checkpoint.summary)}</span>`
        ),
      ]
        .filter(Boolean)
        .join("");

      return `
        <article class="session-card">
          <h2>${escapeHtml(session.title)}</h2>
          <p><strong>Slug:</strong> ${escapeHtml(session.taskSlug)}</p>
          <p><strong>Status:</strong> ${escapeHtml(session.status)}</p>
          ${phase}
          ${latestMessage}
          <div>
            <strong>Agents</strong>
            ${agents}
          </div>
          <div>
            <strong>Work Items</strong>
            ${workItems}
          </div>
          ${operations ? `<div class="operations">${operations}</div>` : ""}
        </article>
      `;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="5" />
    <title>Teamwork MCP</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f1ea;
        --panel: #fffdf9;
        --ink: #1d1915;
        --muted: #6a6258;
        --line: #d8d1c2;
        --accent: #255f85;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 32px;
        background: radial-gradient(circle at top, #fff8ef, var(--bg));
        color: var(--ink);
        font-family: Georgia, "Times New Roman", serif;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 2.4rem;
      }
      p {
        color: var(--muted);
      }
      .sessions {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 18px;
        margin-top: 24px;
      }
      .session-card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 20px;
        box-shadow: 0 8px 24px rgba(29, 25, 21, 0.06);
      }
      .session-card h2 {
        margin: 0 0 12px;
        color: var(--accent);
      }
      .session-card p {
        margin: 8px 0;
      }
      .operations {
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px solid var(--line);
      }
      .section-block + .section-block {
        margin-top: 16px;
      }
      .section-block h3 {
        margin: 0 0 10px;
        font-size: 1rem;
        color: var(--accent);
      }
      .detail,
      .muted {
        color: var(--muted);
      }
      ul {
        margin: 10px 0 0;
        padding-left: 18px;
        color: var(--ink);
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Teamwork MCP</h1>
      <p>Read-only visibility into active teamwork sessions, workers, work items, and recent coordination traffic.</p>
      <p>Auto-refreshes every 5 seconds.</p>
    </header>
    <section class="sessions">
      ${cards || "<p>No teamwork sessions yet.</p>"}
    </section>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderSection<T>(
  title: string,
  items: T[] | undefined,
  renderItem: (item: T) => string
) {
  if (!items || items.length === 0) {
    return "";
  }

  return `
    <section class="section-block">
      <h3>${escapeHtml(title)}</h3>
      <ul>${items.map((item) => `<li>${renderItem(item)}</li>`).join("")}</ul>
    </section>
  `;
}
