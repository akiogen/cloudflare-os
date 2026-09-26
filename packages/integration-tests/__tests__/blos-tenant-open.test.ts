// ADR-0005 P4: share links and Gadget opens never grant access across Tenants, even when a
// permission edge exists.
//
// The fixture policy puts `ta…` users in Tenant A and `tb…` users in Tenant B, and can move a user
// with POST /assign.

import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES, type AuthenticatedApi, type Overseer,
} from "@gadgets/workshop-shared/api";
import { type Harness, settleRestart, startHarness } from "../src/harness.js";
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

function usernames(...prefixes: string[]): string[] {
  const values = nextUsernames(...prefixes);
  if (values.length !== prefixes.length || values.some(v => !v)) {
    throw new Error("Failed to allocate test usernames");
  }
  return values;
}

async function activate(workspace: RpcStub<Overseer>): Promise<string> {
  const { id } = await workspace.getMetadata();
  await workspace.newChat("Make this workspace visible without an agent", null);
  return id;
}

async function moveToTenant(user: string, tenant: string): Promise<void> {
  const response = await requireHarness().fetchWorker(POLICY_WORKER,
      `http://policy/assign?user=${encodeURIComponent(user)}&tenant=${encodeURIComponent(tenant)}`,
      { method: "POST" });
  expect(response.status).toBe(204);
}

async function expectOpenDenied(
    authenticated: RpcStub<AuthenticatedApi>, workspaceId: string, shareKey?: string): Promise<void> {
  let denied: unknown;
  try {
    using _workspace = await authenticated.openGadget(workspaceId, shareKey);
  } catch (error) {
    denied = error;
  }
  if (denied === undefined) throw new Error("Expected workspace open to fail");
  expect(getOpenGadgetErrorCode(denied)).toBe(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
}

/** Open as `username` in a fresh session and return the Gadget's metadata role. */
async function openAs(username: string, workspaceId: string, shareKey?: string): Promise<string> {
  using publicApi = connect(requireHarness().url);
  using user = await logIn(publicApi, username);
  using opened = await user.openGadget(workspaceId, shareKey);
  return (await opened.getMetadata()).role;
}

it.concurrent("refuses another Tenant's share-link redemption and writes no edge", async () => {
  const [ownerName, outsiderName] = usernames("taowner", "tboutsider");
  using ownerPublic = connect(requireHarness().url);
  using outsiderPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName!);
  using outsider = await signUp(outsiderPublic, outsiderName!);
  using workspace = await owner.newGadget();
  const id = await activate(workspace);

  const link = await workspace.createShareLink("use", "cross-tenant link");
  await expectOpenDenied(outsider, id, link.key);
  await expectOpenDenied(outsider, id);
  expect(await workspace.listCollaborators()).toEqual([]);
});

it.concurrent("keeps share links working inside the owner's Tenant", async () => {
  const [ownerName, colleagueName] = usernames("taowner", "tacolleague");
  using ownerPublic = connect(requireHarness().url);
  using colleaguePublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName!);
  using _colleague = await signUp(colleaguePublic, colleagueName!);
  using workspace = await owner.newGadget();
  const id = await activate(workspace);

  const link = await workspace.createShareLink("use", "team link");
  expect(await openAs(colleagueName!, id, link.key)).toBe("use");
  expect((await workspace.listCollaborators()).map(c => c.profile.id)).toEqual([colleagueName]);
  await settleRestart();
});

it.concurrent("ignores an existing edge once the collaborator is in another Tenant", async () => {
  const [ownerName, moverName] = usernames("taowner", "tamover");
  using ownerPublic = connect(requireHarness().url);
  using moverPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName!);
  using _mover = await signUp(moverPublic, moverName!);
  using workspace = await owner.newGadget();
  const id = await activate(workspace);

  expect(await workspace.addCollaborator(moverName!, "use", "teammate")).not.toBeNull();
  expect(await openAs(moverName!, id)).toBe("use");

  // The edge stays, but a Tenant change makes it grant nothing.
  await moveToTenant(moverName!, "tenant-b");
  {
    using publicApi = connect(requireHarness().url);
    using mover = await logIn(publicApi, moverName!);
    await expectOpenDenied(mover, id);
  }
  expect((await workspace.listCollaborators()).map(c => c.profile.id)).toEqual([moverName]);

  // Back in the owner's Tenant, the same edge grants access again.
  await moveToTenant(moverName!, "tenant-a");
  expect(await openAs(moverName!, id)).toBe("use");
  await settleRestart();
});
