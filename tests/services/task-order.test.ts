import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, type CreateIssueInput } from "../../src/services/issues.js";
import { addDependency, listBlockedIssueIds, nextTask } from "../../src/services/dependencies.js";
import { setQueuePosition } from "../../src/services/queue.js";
import { searchIssues } from "../../src/services/search.js";
import { selectDispatchable, type WorkerConfig } from "../../scripts/worker-select.js";

describe("server and worker task ordering (#266)", () => {
  it.each(["claude", "codex", "gemini"] as const)(
    "walks the same eligible queue for %s, including unranked affinity and equal timestamps",
    (engine) => {
      const db = openDb(":memory:");
      const human = createActor(db, { name: "sean", type: "human" }).actor;
      const worker = createActor(db, { name: `${engine}/dev`, type: "agent" }).actor;
      createProject(db, human, { key: "SYD", name: "Switchyard" });
      const todo = (title: string, patch: Partial<CreateIssueInput> = {}) => {
        const issue = createIssue(db, human, {
          projectKey: "SYD",
          title,
          labels: ["auto"],
          ...patch,
        });
        updateIssue(db, human, issue.ref, { status: "todo" });
        return issue.ref;
      };
      const unrankedUrgent = todo("neutral urgent", { priority: "urgent" });
      todo("oldest neutral high", { priority: "high" });
      todo("newer neutral high", { priority: "high" });
      todo("preferred low", { priority: "low", workerPreference: engine });
      todo("foreign urgent", { priority: "urgent", workerPreference: "other" });
      const queuedLow = todo("ranked low foreign", { priority: "low", workerPreference: "other" });
      const queuedUrgent = todo("ranked urgent matching", {
        priority: "urgent",
        workerPreference: engine,
      });
      const blocked = todo("blocked rank one");
      addDependency(db, human, unrankedUrgent, blocked);
      const interactive = todo("interactive rank two", { workerPreference: "interactive" });
      for (const [index, ref] of [blocked, interactive, queuedLow, queuedUrgent].entries()) {
        setQueuePosition(db, human, ref, { position: index + 1 });
      }
      const config: WorkerConfig = {
        url: "http://localhost:3300",
        label: "auto",
        engine,
        intervalSeconds: 300,
        maxConcurrent: 50,
        projects: { SYD: { repo: "/repo" } },
      };
      const feed = () => {
        const blockedIds = listBlockedIssueIds(db);
        return searchIssues(db, { projectKey: "SYD", status: "todo" }).map((issue) => ({
          ...issue,
          blocked: blockedIds.has(issue.id),
        }));
      };
      expect(
        selectDispatchable(feed(), config, [])
          .slice(0, 2)
          .map((issue) => issue.ref),
      ).toEqual([queuedLow, queuedUrgent]);
      // Re-read after each completion: completing the urgent blocker makes
      // the previously ineligible rank-one issue eligible on the next tick.
      let completed = 0;
      for (;;) {
        const serverNext = nextTask(db, worker, "SYD");
        const workerNext = selectDispatchable(feed(), { ...config, maxConcurrent: 1 }, [])[0];
        expect(workerNext?.ref ?? null).toBe(serverNext?.ref ?? null);
        if (!serverNext) break;
        updateIssue(db, human, serverNext.ref, { status: "done" });
        expect(++completed).toBeLessThan(20);
      }
      expect(completed).toBe(8);
    },
  );
});
