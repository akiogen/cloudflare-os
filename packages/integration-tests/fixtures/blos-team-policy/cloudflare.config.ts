import { defineGadgetsWorker, type DurableObjectMigration } from "@gadgets/scripts/worker-config";

/**
 * Test double for a deployment's TEAM_POLICY binding: no RPC validation build. The Workshop
 * reaches it through the harness's `services` option.
 */
export default defineGadgetsWorker({
  name: "blos-team-policy",
  entrypoint: "src/blos-team-policy.ts",
});

/** Per-user Team overrides, so a test can move a user to another Team; reached via ctx.exports. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["TeamOverrides"] },
];
