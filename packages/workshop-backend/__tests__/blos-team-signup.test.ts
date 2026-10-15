// ADR-0006 / business-loop-os#47: the gatekeeper sign-in and Cloudflare Access creation paths call
// TeamPolicy.onUserCreated before the account exists, and fail closed when it throws. (The
// password path is covered end to end in integration-tests/__tests__/blos-team-signup.test.ts.)

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { TeamPolicy } from "@gadgets/workshop-shared/team-policy";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type UserInternals = UserDurableObject & {
  env: Cloudflare.Env;
  storage: { created: { get(): boolean } };
};

/** A policy that records onUserCreated calls and throws while `failing` is set. */
function recordingPolicy() {
  const created: string[] = [];
  const state = { failing: false };
  const policy: TeamPolicy = {
    teamOf: async () => "team-x",
    sameTeam: async () => true,
    onUserCreated: async (userId) => {
      if (state.failing) throw new Error("policy unavailable");
      created.push(userId);
    },
  };
  return { policy, created, state };
}

let counter = 0;

/** Runs `f` inside a fresh user DO whose env binds `policy` as TEAM_POLICY. */
function withPolicy<T>(policy: TeamPolicy, f: (user: UserInternals) => Promise<T>): Promise<T> {
  const stub = env.TEST_USER.getByName(`blos-team-signup-${++counter}`);
  return runInDurableObject(stub, (instance: UserDurableObject) => {
    const user = instance as UserInternals;
    user.env = { ...user.env, TEAM_POLICY: policy } as unknown as Cloudflare.Env;
    return f(user);
  });
}

const EMAIL = "new.user@example.com";

describe("gatekeeper sign-in creation", () => {
  it("assigns a Team once, before the account exists", async () => {
    const { policy, created } = recordingPolicy();
    await withPolicy(policy, async (user) => {
      expect(await user.loginOrCreateViaGatekeeper(EMAIL, true)).toEqual(expect.any(String));
      expect(user.storage.created.get()).toBe(true);
      await user.loginOrCreateViaGatekeeper(EMAIL, true);
    });
    expect(created).toEqual([EMAIL]);
  });

  it("creates no account when the policy fails, and a retry succeeds", async () => {
    const { policy, created, state } = recordingPolicy();
    state.failing = true;
    await withPolicy(policy, async (user) => {
      await expect(user.loginOrCreateViaGatekeeper(EMAIL, true)).rejects.toThrow("policy unavailable");
      expect(user.storage.created.get()).toBe(false);

      state.failing = false;
      expect(await user.loginOrCreateViaGatekeeper(EMAIL, true)).toEqual(expect.any(String));
      expect(user.storage.created.get()).toBe(true);
    });
    expect(created).toEqual([EMAIL]);
  });

  it("does not call the policy when sign-ups are closed", async () => {
    const { policy, created } = recordingPolicy();
    await withPolicy(policy, async (user) => {
      expect(await user.loginOrCreateViaGatekeeper(EMAIL, false)).toBeNull();
    });
    expect(created).toEqual([]);
  });
});

describe("Cloudflare Access creation", () => {
  it("assigns a Team once, before the account exists", async () => {
    const { policy, created } = recordingPolicy();
    await withPolicy(policy, async (user) => {
      expect(await user.authenticateFromCfAccess(EMAIL, true)).toBe(true);
      expect(await user.authenticateFromCfAccess(EMAIL, true)).toBe(false);
    });
    expect(created).toEqual([EMAIL]);
  });

  it("creates no account when the policy fails, and a retry succeeds", async () => {
    const { policy, created, state } = recordingPolicy();
    state.failing = true;
    await withPolicy(policy, async (user) => {
      await expect(user.authenticateFromCfAccess(EMAIL, true)).rejects.toThrow("policy unavailable");
      expect(user.storage.created.get()).toBe(false);

      state.failing = false;
      expect(await user.authenticateFromCfAccess(EMAIL, true)).toBe(true);
    });
    expect(created).toEqual([EMAIL]);
  });
});
