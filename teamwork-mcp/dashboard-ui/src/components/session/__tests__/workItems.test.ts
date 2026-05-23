import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  KANBAN_COLUMNS,
  STATUS_LABEL,
  filterWorkItems,
  groupByStatus,
  phaseLabel,
  uniquePhaseNumbers,
} from "@/lib/workItems";
import type { PhaseBoundary, WorkItem, WorkItemStatus } from "@/lib/types";

function makeItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    workItemId: "wi-1",
    phaseNumber: 1,
    title: "Build API",
    description: "Wire endpoint",
    ownerAgentId: "agent-1",
    ownerAlias: "backend",
    assigneeAgentIds: ["agent-1"],
    assigneeAliases: ["backend"],
    primaryAssigneeAgentId: "agent-1",
    status: "in-progress",
    dependsOnIds: [],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:01:00.000Z",
    ...over,
  };
}

describe("workItems lib", () => {
  it("covers every WorkItemStatus with a column, label and tone", () => {
    const statuses: WorkItemStatus[] = [
      "planned",
      "assigned",
      "in-progress",
      "blocked",
      "done",
      "canceled",
    ];
    for (const s of statuses) {
      expect(KANBAN_COLUMNS).toContain(s);
      expect(STATUS_LABEL[s]).toBeTruthy();
    }
  });

  it("filters by query, agent, phase, hideFinished and showCanceled", () => {
    const items = [
      makeItem({ workItemId: "a", title: "Build API", status: "in-progress", phaseNumber: 1 }),
      makeItem({
        workItemId: "b",
        title: "Wire frontend",
        status: "done",
        phaseNumber: 2,
        assigneeAgentIds: ["agent-2"],
        assigneeAliases: ["frontend"],
        ownerAgentId: "agent-2",
        ownerAlias: "frontend",
      }),
      makeItem({ workItemId: "c", title: "Drop dead code", status: "canceled", phaseNumber: 1 }),
    ];

    expect(filterWorkItems(items, EMPTY_FILTERS).map((x) => x.workItemId)).toEqual(["a", "b"]);

    expect(filterWorkItems(items, { ...EMPTY_FILTERS, hideFinished: true }).map((x) => x.workItemId)).toEqual([
      "a",
    ]);
    expect(filterWorkItems(items, { ...EMPTY_FILTERS, showCanceled: true }).map((x) => x.workItemId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(filterWorkItems(items, { ...EMPTY_FILTERS, agentId: "agent-2" }).map((x) => x.workItemId)).toEqual([
      "b",
    ]);
    expect(filterWorkItems(items, { ...EMPTY_FILTERS, phaseNumber: 2 }).map((x) => x.workItemId)).toEqual([
      "b",
    ]);
    expect(filterWorkItems(items, { ...EMPTY_FILTERS, query: "frontend" }).map((x) => x.workItemId)).toEqual([
      "b",
    ]);
  });

  it("groups items by status with newest first", () => {
    const items = [
      makeItem({ workItemId: "a", status: "in-progress", updatedAt: "2026-05-18T00:01:00.000Z" }),
      makeItem({ workItemId: "b", status: "in-progress", updatedAt: "2026-05-18T00:05:00.000Z" }),
      makeItem({ workItemId: "c", status: "blocked", updatedAt: "2026-05-18T00:03:00.000Z" }),
    ];
    const grouped = groupByStatus(items);
    expect(grouped["in-progress"].map((x) => x.workItemId)).toEqual(["b", "a"]);
    expect(grouped.blocked.map((x) => x.workItemId)).toEqual(["c"]);
    expect(grouped["done"]).toEqual([]);
  });

  it("phaseLabel uses the phase title when available", () => {
    const phases: PhaseBoundary[] = [
      { phaseNumber: 1, title: "Foundations" },
      { phaseNumber: 2 },
    ];
    expect(phaseLabel(1, phases)).toBe("phase-1 · Foundations");
    expect(phaseLabel(2, phases)).toBe("phase-2");
    expect(phaseLabel(7, phases)).toBe("phase-7");
  });

  it("uniquePhaseNumbers returns a sorted unique list", () => {
    const items = [
      makeItem({ workItemId: "a", phaseNumber: 2 }),
      makeItem({ workItemId: "b", phaseNumber: 1 }),
      makeItem({ workItemId: "c", phaseNumber: 2 }),
    ];
    expect(uniquePhaseNumbers(items)).toEqual([1, 2]);
  });
});
