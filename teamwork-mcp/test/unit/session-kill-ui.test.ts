import test from "node:test";
import assert from "node:assert/strict";

import {
  getSessionKillButtonLabel,
  getSessionKillErrorMessage,
  getSessionKillSuccessMessage,
} from "../../dashboard-ui/src/lib/sessionKill.js";

test("session kill button labels reflect variant and pending state", () => {
  assert.equal(getSessionKillButtonLabel("row", false), "Kill");
  assert.equal(getSessionKillButtonLabel("detail", false), "Kill session");
  assert.equal(getSessionKillButtonLabel("row", true), "Stopping session...");
});

test("session kill success message includes stopped and already-stopped counts", () => {
  assert.equal(
    getSessionKillSuccessMessage({
      sessionId: "s1",
      status: "abandoned",
      stoppedCount: 2,
      alreadyStoppedCount: 1,
      agentCount: 3,
      terminalReason: "Killed from dashboard",
    }),
    "Session abandoned and stopped 2 workers. 1 runtime was already stopped.",
  );
  assert.equal(
    getSessionKillSuccessMessage({
      sessionId: "s1",
      status: "abandoned",
      stoppedCount: 0,
      alreadyStoppedCount: 0,
      agentCount: 3,
      terminalReason: "Killed from dashboard",
    }),
    "Session abandoned.",
  );
});

test("session kill error message prefers api payloads", () => {
  assert.equal(
    getSessionKillErrorMessage(new Error('404 Not Found: {"error":"session not found"}')),
    "session not found",
  );
});
