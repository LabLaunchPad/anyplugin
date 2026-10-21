import { describe, it, expect } from "vitest";
import { EventLog } from "./event-log.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("EventLog fixes & regression audit", () => {
  it("enforces G5 idempotency: re-appending an event with the same ID returns the existing event without writing duplicate frames", () => {
    const workspace = mkdtempSync(join(tmpdir(), "anyplugin-g5-"));
    const log = EventLog.open(workspace);
    try {
      const first = log.append({
        id: "EVT-1",
        contractVersion: "1.3.0",
        kind: "DELEGATION_RECORDED",
        subject: "WC-1",
        actor: "process:test",
        at: "2026-10-21T00:00:00.000Z",
        payload: { test: 1 },
      });

      const second = log.append({
        id: "EVT-1",
        contractVersion: "1.3.0",
        kind: "DELEGATION_RECORDED",
        subject: "WC-1",
        actor: "process:test",
        at: "2026-10-21T00:00:00.000Z",
        payload: { test: 1 },
      });

      expect(second.id).toBe(first.id);
      expect(second.sequence).toBe(first.sequence);
      expect(log.nextSequence).toBe(1);
    } finally {
      log.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
