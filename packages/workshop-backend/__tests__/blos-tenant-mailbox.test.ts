// ADR-0009 / business-loop-os#53 (P6): the Tenant policy authorizes a resource URL before the
// gatekeeper is asked, so a denied mailbox name is never claimed. The mailbox rules themselves and
// the cross-Tenant case with the real policy and gatekeeper-email are covered end to end in
// integration-tests/__tests__/blos-tenant-mailbox.test.ts.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  SINGLE_TENANT_POLICY, type ResourceAuthorization, type TenantPolicy,
} from "@gadgets/workshop-shared/tenant-policy";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type FakeAccount = {
  id: number;
  vendorId: string;
  account: { getGatekeeperClassFor(url: string): Promise<never> };
};

type UserInternals = UserDurableObject & {
  env: Cloudflare.Env;
  storage: object;
};

const EMAIL = "mailbox.owner@example.com";
const MAILBOX_URL = "http://localhost:8787/gatekeeper/email/mailbox/k7m2q9x4ab-support";
const REACHED = "reached the gatekeeper";

/** A policy whose authorizeResource answers `answer` (or throws) and records its arguments. */
function authorizingPolicy(answer: ResourceAuthorization | Error) {
  const calls: [string, string, string][] = [];
  const policy: TenantPolicy = {
    ...SINGLE_TENANT_POLICY,
    authorizeResource: async (userId, vendorId, resourceUrl) => {
      calls.push([userId, vendorId, resourceUrl]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { policy, calls };
}

let counter = 0;

/**
 * Creates a user bound to `policy` with one connected "email" account whose gatekeeper records
 * each URL it is asked about (and then throws REACHED), and runs `f` inside the user DO.
 */
function withAccount<T>(policy: TenantPolicy | undefined,
    f: (user: UserInternals, asked: string[]) => Promise<T>): Promise<T> {
  const stub = env.TEST_USER.getByName(`blos-tenant-mailbox-${++counter}`);
  return runInDurableObject(stub, async (instance: UserDurableObject) => {
    const user = instance as UserInternals;
    await user.loginOrCreateViaGatekeeper(EMAIL, true);
    if (policy) user.env = { ...user.env, TENANT_POLICY: policy } as unknown as Cloudflare.Env;
    const asked: string[] = [];
    const account: FakeAccount = {
      id: 1,
      vendorId: "email",
      account: {
        getGatekeeperClassFor: async (url) => {
          asked.push(url);
          throw new Error(REACHED);
        },
      },
    };
    (user.storage as { connectedAccounts: unknown }).connectedAccounts =
        { get: (id: number) => id === account.id ? account : undefined };
    return f(user, asked);
  });
}

describe("resource authorization before the gatekeeper", () => {
  it("does not ask the gatekeeper when the policy denies", async () => {
    const { policy, calls } = authorizingPolicy({ allowed: false, message: "Use your handle." });
    await withAccount(policy, async (user, asked) => {
      await expect(user.getGatekeeperClassFor(1, MAILBOX_URL)).rejects.toThrow("Use your handle.");
      expect(asked).toEqual([]);
    });
    expect(calls).toEqual([[EMAIL, "email", MAILBOX_URL]]);
  });

  it("asks the gatekeeper when the policy allows", async () => {
    const { policy } = authorizingPolicy({ allowed: true });
    await withAccount(policy, async (user, asked) => {
      await expect(user.getGatekeeperClassFor(1, MAILBOX_URL)).rejects.toThrow(REACHED);
      expect(asked).toEqual([MAILBOX_URL]);
    });
  });

  it("fails closed when the policy throws", async () => {
    const { policy } = authorizingPolicy(new Error("policy unavailable"));
    await withAccount(policy, async (user, asked) => {
      await expect(user.getGatekeeperClassFor(1, MAILBOX_URL)).rejects.toThrow("policy unavailable");
      expect(asked).toEqual([]);
    });
  });

  it("allows every resource without a TENANT_POLICY binding", async () => {
    await withAccount(undefined, async (user, asked) => {
      await expect(user.getGatekeeperClassFor(1, MAILBOX_URL)).rejects.toThrow(REACHED);
      expect(asked).toEqual([MAILBOX_URL]);
    });
  });
});
