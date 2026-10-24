// BLOS ADR-0018: the operator erases one account with AdminApi.eraseAccount.
//
// Erasure removes the account's Workspaces (when asked), its directory record and its storage,
// is idempotent, is refused to non-admins and to the admin's own account, and leaves every other
// account untouched, in the same Team and in another one (INV-001).
//
// The fixture policy puts `ta…` users in Team A and `tb…` users in Team B. Password accounts are
// named by their username.

import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AdminApi, AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import { ADMIN_USERNAME, type Harness, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

const POLICY_DIR = resolve(import.meta.dirname, "../fixtures/blos-team-policy");

let harness: Harness | undefined;
const network = new NetworkInterceptor({ handlers: [mockChatCompletion("Test chat")] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    services: [{ binding: "TEAM_POLICY", dir: POLICY_DIR }],
  });
  using publicApi = connect(harness.url);
  using admin = await signUp(publicApi, ADMIN_USERNAME);
  using adminApi = await admin.getAdminApi();
  if (!adminApi) throw new Error("Harness admin has no admin API");
  await adminApi.setUserSearchEnabled(true);
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

/** Runs `fn` with the admin's AdminApi. */
async function asAdmin<T>(fn: (admin: RpcStub<AdminApi>) => Promise<T>): Promise<T> {
  using publicApi = connect(requireHarness().url);
  using user = await logIn(publicApi, ADMIN_USERNAME);
  using admin = await user.getAdminApi();
  if (!admin) throw new Error("Harness admin has no admin API");
  return await fn(admin);
}

/** Signs `username` up and gives them one opened Workspace; returns its id. */
async function userWithWorkspace(username: string): Promise<string> {
  using publicApi = connect(requireHarness().url);
  using user = await signUp(publicApi, username);
  using workspace: RpcStub<Overseer> = await user.newGadget();
  const { id } = await workspace.getMetadata();
  await workspace.newChat("Make this workspace visible without an agent", null);
  return id;
}

async function gadgetIds(username: string): Promise<string[]> {
  using publicApi = connect(requireHarness().url);
  using user: RpcStub<AuthenticatedApi> = await logIn(publicApi, username);
  return (await user.listGadgets()).map(g => g.id);
}

async function search(username: string, query: string): Promise<string[]> {
  using publicApi = connect(requireHarness().url);
  using user: RpcStub<AuthenticatedApi> = await logIn(publicApi, username);
  return (await user.searchUsers(query, [])).map(r => r.id);
}

it.concurrent("erases the account and its Workspaces, and nothing of anyone else's", async () => {
  const [target, colleague, outsider] = nextUsernames("taerased", "tacolleague", "tboutsider");
  if (!target || !colleague || !outsider) throw new Error("Missing test username");
  const targetWorkspace = await userWithWorkspace(target);
  const colleagueWorkspace = await userWithWorkspace(colleague);
  const outsiderWorkspace = await userWithWorkspace(outsider);
  await waitFor(`${colleague} to find ${target}`,
      async () => (await search(colleague, target)).includes(target) || null);

  const report = await asAdmin(admin => admin.eraseAccount(target, { workspaces: "delete" }));
  expect(report).toEqual({
    erased: true, workspacesDeleted: 1, workspacesKept: 0, connectionsRevoked: 0,
    blueprintsDeleted: 0, failures: [],
  });

  // The account is gone: it cannot sign in, and its Workspace cannot be opened.
  {
    using publicApi = connect(requireHarness().url);
    await expect(logIn(publicApi, target)).rejects.toThrow();
  }
  {
    using publicApi = connect(requireHarness().url);
    using colleagueApi = await logIn(publicApi, colleague);
    await expect(colleagueApi.openGadget(targetWorkspace)).rejects.toThrow();
  }
  expect(await search(colleague, target)).toEqual([]);

  // Everyone else is unchanged, in the same Team and in the other one.
  expect(await gadgetIds(colleague)).toEqual([colleagueWorkspace]);
  expect(await gadgetIds(outsider)).toEqual([outsiderWorkspace]);
  {
    using publicApi = connect(requireHarness().url);
    using colleagueApi = await logIn(publicApi, colleague);
    using workspace = await colleagueApi.openGadget(colleagueWorkspace);
    expect((await workspace.getMetadata()).id).toBe(colleagueWorkspace);
  }
});

it.concurrent("keeps owned Workspaces when asked", async () => {
  const [target] = nextUsernames("takept");
  if (!target) throw new Error("Missing test username");
  await userWithWorkspace(target);

  const report = await asAdmin(admin => admin.eraseAccount(target, { workspaces: "keep" }));
  expect(report).toMatchObject({ erased: true, workspacesDeleted: 0, workspacesKept: 1, failures: [] });
});

it.concurrent("is idempotent", async () => {
  const [target] = nextUsernames("taagain");
  if (!target) throw new Error("Missing test username");
  await userWithWorkspace(target);

  await asAdmin(admin => admin.eraseAccount(target, { workspaces: "delete" }));
  const again = await asAdmin(admin => admin.eraseAccount(target, { workspaces: "delete" }));
  expect(again).toEqual({
    erased: false, workspacesDeleted: 0, workspacesKept: 0, connectionsRevoked: 0,
    blueprintsDeleted: 0, failures: [],
  });
});

it.concurrent("is refused to non-admins and for the admin's own account", async () => {
  const [member, target] = nextUsernames("tamember", "tatarget");
  if (!member || !target) throw new Error("Missing test username");
  await userWithWorkspace(target);
  {
    using publicApi = connect(requireHarness().url);
    using memberApi = await signUp(publicApi, member);
    expect(await memberApi.getAdminApi()).toBeNull();
  }
  await expect(asAdmin(admin => admin.eraseAccount(ADMIN_USERNAME, { workspaces: "delete" })))
      .rejects.toThrow(/signed in with/);
  expect(await gadgetIds(target)).toHaveLength(1);
});
