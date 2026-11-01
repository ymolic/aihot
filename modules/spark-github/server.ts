// The spark-github module: curated GitHub repositories and Hacker News, collected into the engine's
// pipeline. The engine never imports a module; the site's manifest (site/modules/server.ts) installs
// this one, and the engine reads these sockets: the collection cron, fetchNow for the admin's manual
// fetch of an external source, and the module's share of the daily retention run.
import { defineServerModule } from "@aihot/backend/modules";
import { collectAll, collectSource, retention } from "./backend/collect.ts";

/** Like the engine's own collection schedules (apps/worker/src/schedules.ts): off without the valve. */
const collectEnabled = () => process.env.COLLECT_ENABLED === "true";

export default defineServerModule({
  name: "spark-github",
  schedules: [
    // GitHub's search quota is the pacing limit: three spec runs fit comfortably in an hour, and a
    // spec that hit its budget waits in its cursor (blockedUntil) whatever this timer says.
    { name: "spark-github.collect", cron: "*/20 * * * *", run: () => collectAll(), when: collectEnabled },
  ],
  sourceKinds: {
    // The module collects external sources itself; the admin's manual fetch runs one pass now and
    // records the summary in the audit trail.
    external: {
      fetchNow: async source => {
        const result = await collectSource(source.id, { force: true });
        return { ...result };
      },
    },
  },
  retention: () => retention(),
});
