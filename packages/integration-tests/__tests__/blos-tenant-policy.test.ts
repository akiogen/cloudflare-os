// The TENANT_POLICY seam (workshop-shared/src/tenant-policy.ts): the Workshop boots and serves its
// normal flows with a policy bound. The checks that act on the policy (directory, collaborators,
// share links, open) arrive with their call sites; this suite is where they go.

import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp } from "../src/rpc-client.js";

const POLICY_DIR = resolve(import.meta.dirname, "../fixtures/blos-tenant-policy");
const POLICY_WORKER = "blos-tenant-policy";

let harness: Harness | undefined;
const network = new NetworkInterceptor({ handlers: [mockChatCompletion("Test chat")] });

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

async function tenantOf(user: string): Promise<string> {
  const response = await requireHarness().fetchWorker(
      POLICY_WORKER, `http://policy/tenant-of?user=${encodeURIComponent(user)}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { tenant: string }).tenant;
}

it.concurrent("boots the bound policy Worker next to the Workshop", async () => {
  const [a, b, other] = nextUsernames("taowner", "tbguest", "someone");
  if (!a || !b || !other) throw new Error("Missing test username");
  expect(await tenantOf(a)).toBe("tenant-a");
  expect(await tenantOf(b)).toBe("tenant-b");
  expect(await tenantOf(other)).toBe("default");
});

it.concurrent("keeps sign-up, log-in and own Gadgets working with a policy bound", async () => {
  const [a, b] = nextUsernames("taowner", "tbowner");
  if (!a || !b) throw new Error("Missing test username");

  for (const username of [a, b]) {
    const id = await (async () => {
      using publicApi = connect(requireHarness().url);
      using owner = await signUp(publicApi, username);
      using workspace = await owner.newGadget();
      const metadata = await workspace.getMetadata();
      await workspace.newChat("Make this workspace visible without an agent", null);
      return metadata.id;
    })();

    using publicApi = connect(requireHarness().url);
    using owner = await logIn(publicApi, username);
    using reopened = await owner.openGadget(id);
    expect(await reopened.getMetadata()).toMatchObject({ id });
  }
});
