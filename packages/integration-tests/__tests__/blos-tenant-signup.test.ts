// ADR-0006 / business-loop-os#47: account creation calls TenantPolicy.onUserCreated before the
// account exists, fails closed when the policy fails, and stays at-most-once under concurrency.
// Password sign-up is the creation path the harness drives; the gatekeeper and Cloudflare Access
// paths are covered by workshop-backend/__tests__/blos-tenant-signup.test.ts.

import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp } from "../src/rpc-client.js";

const POLICY_DIR = resolve(import.meta.dirname, "../fixtures/blos-tenant-policy");
const POLICY_WORKER = "blos-tenant-policy";

let harness: Harness | undefined;
const network = new NetworkInterceptor({ handlers: [] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    services: [{ binding: "TENANT_POLICY", dir: POLICY_DIR }],
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

function requireHarness(): Harness {
  if (harness === undefined) throw new Error("Workshop harness did not start");
  return harness;
}

async function createdCount(user: string): Promise<number> {
  const response = await requireHarness().fetchWorker(
      POLICY_WORKER, `http://policy/created?user=${encodeURIComponent(user)}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { count: number }).count;
}

async function failNextCreation(user: string): Promise<void> {
  const response = await requireHarness().fetchWorker(
      POLICY_WORKER, `http://policy/fail?user=${encodeURIComponent(user)}`, { method: "POST" });
  expect(response.status).toBe(204);
}

async function signUpAs(username: string): Promise<void> {
  using publicApi = connect(requireHarness().url);
  using _user = await signUp(publicApi, username);
}

async function logInAs(username: string): Promise<void> {
  using publicApi = connect(requireHarness().url);
  using _user = await logIn(publicApi, username);
}

it.concurrent("assigns a Tenant once at sign-up and not on later log-ins", async () => {
  const [username] = nextUsernames("tasignup");
  if (!username) throw new Error("Missing test username");

  await signUpAs(username);
  expect(await createdCount(username)).toBe(1);
  await logInAs(username);
  await logInAs(username);
  expect(await createdCount(username)).toBe(1);
});

it.concurrent("creates no account when the Tenant policy fails, and allows a retry", async () => {
  const [username] = nextUsernames("tafailing");
  if (!username) throw new Error("Missing test username");

  await failNextCreation(username);
  await expect(signUpAs(username)).rejects.toThrow();
  await expect(logInAs(username)).rejects.toThrow(/Login failed/);
  expect(await createdCount(username)).toBe(0);

  await signUpAs(username);
  await logInAs(username);
  expect(await createdCount(username)).toBe(1);
});

it.concurrent("creates the account at most once under concurrent sign-ups", async () => {
  const [username] = nextUsernames("taracer");
  if (!username) throw new Error("Missing test username");

  const outcomes = await Promise.allSettled([signUpAs(username), signUpAs(username)]);
  expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(o => o.status === "rejected")).toHaveLength(1);
  expect(await createdCount(username)).toBe(1);
});
