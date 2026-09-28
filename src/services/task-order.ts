import { sql, type SQL } from "drizzle-orm";
import { issues } from "../db/schema.js";

/** Fields shared by the ready-issues feed and the server's issue rows. */
type OrderedTask = {
  id?: number;
  queueRank?: number | null;
  workerPreference?: string | null;
  priority?: string;
  createdAt?: number;
};

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/**
 * One ordered definition for nextTask's SQL and the worker's in-memory sort.
 * Ranked work always comes first; affinity only applies to unranked work.
 * The id tiebreak keeps equal timestamps independent of feed arrival order.
 */
function taskOrder(classification: string): { value: (task: OrderedTask) => number; sql: SQL }[] {
  return [
    {
      value: (task) => (task.queueRank == null ? 1 : 0),
      sql: sql`CASE WHEN ${issues.queueRank} IS NULL THEN 1 ELSE 0 END`,
    },
    {
      value: (task) => task.queueRank ?? 0,
      sql: sql`coalesce(${issues.queueRank}, 0)`,
    },
    {
      value: (task) =>
        task.queueRank != null
          ? 0
          : task.workerPreference == null
            ? 1
            : task.workerPreference === classification
              ? 0
              : 2,
      sql: sql`CASE
        WHEN ${issues.queueRank} IS NOT NULL THEN 0
        WHEN ${issues.workerPreference} IS NULL THEN 1
        WHEN ${issues.workerPreference} = ${classification} THEN 0
        ELSE 2 END`,
    },
    {
      value: (task) =>
        task.priority !== undefined && Object.hasOwn(PRIORITY_RANK, task.priority)
          ? PRIORITY_RANK[task.priority]
          : 4,
      sql: sql`CASE ${issues.priority} ${sql.join(
        Object.entries(PRIORITY_RANK).map(([priority, rank]) => sql`WHEN ${priority} THEN ${rank}`),
        sql` `,
      )} ELSE 4 END`,
    },
    { value: (task) => task.createdAt ?? 0, sql: sql`${issues.createdAt}` },
    { value: (task) => task.id ?? 0, sql: sql`${issues.id}` },
  ];
}

export function taskOrderSql(classification: string): SQL[] {
  return taskOrder(classification).map((key) => key.sql);
}

export function compareTaskOrder(classification: string) {
  const keys = taskOrder(classification);
  return (a: OrderedTask, b: OrderedTask): number => {
    for (const key of keys) {
      const difference = key.value(a) - key.value(b);
      if (difference !== 0) return difference;
    }
    return 0;
  };
}
