// BLOS ADR-0005 P10: a gatekeeper app's user selection reaches only users of the caller's Team.
// Another Team's user gets exactly what a missing account gets: `null`, so the selection does not
// reveal that the account exists or its display name (the P3 rule).

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SINGLE_TEAM_POLICY, type TeamPolicy } from "@gadgets/workshop-shared/team-policy";
import type { UserDurableObject } from "../src/user.js";
import type { GatekeeperUserPickerTestHooks } from "./test-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_GATEKEEPER_USER_PICKER: DurableObjectNamespace<GatekeeperUserPickerTestHooks>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type UserInternals = UserDurableObject & { env: Cloudflare.Env };

const KV = { get: async () => null } as unknown as KVNamespace;

function hooks(): DurableObjectStub<GatekeeperUserPickerTestHooks> {
  return env.TEST_GATEKEEPER_USER_PICKER.getByName("");
}

function uniqueUser(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Teams by user-name prefix: `ta…` in Team A, everyone else in Team B. */
const twoTeams: TeamPolicy = {
  ...SINGLE_TEAM_POLICY,
  teamOf: async userId => (userId.startsWith("ta") ? "team-a" : "team-b"),
  sameTeam: async (a, b) => a.startsWith("ta") === b.startsWith("ta"),
};

async function createUser(userId: string, policy?: TeamPolicy): Promise<void> {
  await runInDurableObject(env.TEST_USER.getByName(userId), (instance: UserDurableObject) => {
    const user = instance as UserInternals;
    user.env = { ...user.env, BLUEPRINTS: KV, ...(policy ? { TEAM_POLICY: policy } : {}) } as Cloudflare.Env;
  });
  await hooks().createUser(userId, `Name of ${userId}`);
}

describe("gatekeeper user selection across Teams (P10)", () => {
  it("refuses another Team's user exactly as a missing one", async () => {
    const viewer = uniqueUser("ta-view");
    const sameTeam = uniqueUser("ta-picked");
    const otherTeam = uniqueUser("tb-picked");
    await Promise.all([createUser(viewer, twoTeams), createUser(sameTeam), createUser(otherTeam)]);
    const app = await hooks().addAccount(viewer, "context", `${viewer}-context`, { providesUi: true });

    const same = await hooks().pick(viewer, app, sameTeam);
    expect(same).toMatchObject({ profile: { displayName: `Name of ${sameTeam}` } });
    await expect(hooks().pick(viewer, app, otherTeam)).resolves.toBeNull();
    await expect(hooks().pick(viewer, app, uniqueUser("ta-missing"))).resolves.toBeNull();
  });

  it("selects anyone without a TEAM_POLICY binding (upstream behavior)", async () => {
    const viewer = uniqueUser("ta-view");
    const other = uniqueUser("tb-picked");
    await Promise.all([createUser(viewer), createUser(other)]);
    const app = await hooks().addAccount(viewer, "context", `${viewer}-context`, { providesUi: true });
    await expect(hooks().pick(viewer, app, other)).resolves.toMatchObject({
      profile: { displayName: `Name of ${other}` },
    });
  });
});
