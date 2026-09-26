// ADR-0005 P3: only users in the Gadget owner's Tenant can be added as collaborators.
//
// The fixture policy puts `ta…` users in Tenant A and `tb…` users in Tenant B, and can move a user
// with POST /assign. Another Tenant's user must get exactly what a missing account gets: `null`.

import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Overseer } from "@gadgets/workshop-shared/api";
import { type Harness, settleRestart, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp } from "../src/rpc-client.js";

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

it.concurrent("refuses another Tenant's user exactly like a missing account", async () => {
  const [ownerName, outsiderName, missingName] = usernames("taowner", "tboutsider", "tamissing");
  using ownerPublic = connect(requireHarness().url);
  using outsiderPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName!);
  using _outsider = await signUp(outsiderPublic, outsiderName!);
  using workspace = await owner.newGadget();
  await activate(workspace);

  const forOutsider = await workspace.addCollaborator(outsiderName!, "use", "cross-tenant");
  const forMissing = await workspace.addCollaborator(missingName!, "use", "missing");
  expect(forOutsider).toBeNull();
  expect(forOutsider).toEqual(forMissing);
  expect(await workspace.listCollaborators()).toEqual([]);
});

it.concurrent("adds a user of the owner's Tenant", async () => {
  const [ownerName, colleagueName] = usernames("taowner", "tacolleague");
  using ownerPublic = connect(requireHarness().url);
  using colleaguePublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName!);
  using colleague = await signUp(colleaguePublic, colleagueName!);
  using workspace = await owner.newGadget();
  const id = await activate(workspace);

  const added = await workspace.addCollaborator(colleagueName!, "use", "same tenant");
  expect(added).toMatchObject({ profile: { id: colleagueName }, role: "use" });
  using opened = await colleague.openGadget(id);
  expect(await opened.getMetadata()).toMatchObject({ id, role: "use" });
  await settleRestart();
});

it.concurrent("keeps a build collaborator from adding another Tenant's user", async () => {
  const [ownerName, builderName, outsiderName] = usernames("taowner", "tabuilder", "tboutsider");
  using ownerPublic = connect(requireHarness().url);
  using builderPublic = connect(requireHarness().url);
  using outsiderPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName!);
  using builder = await signUp(builderPublic, builderName!);
  using _outsider = await signUp(outsiderPublic, outsiderName!);
  using workspace = await owner.newGadget();
  const id = await activate(workspace);
  expect(await workspace.addCollaborator(builderName!, "build", "builder")).not.toBeNull();

  using builderWorkspace = await builder.openGadget(id);
  expect(await builderWorkspace.addCollaborator(outsiderName!, "use", "via builder")).toBeNull();
  expect((await workspace.listCollaborators()).map(c => c.profile.id)).toEqual([builderName]);
  await settleRestart();
});

it.concurrent("uses the Tenant a user moved to", async () => {
  const [ownerName, moverName] = usernames("taowner", "tamover");
  using ownerPublic = connect(requireHarness().url);
  using moverPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName!);
  using _mover = await signUp(moverPublic, moverName!);
  using workspace = await owner.newGadget();
  await activate(workspace);

  await moveToTenant(moverName!, "tenant-b");
  expect(await workspace.addCollaborator(moverName!, "use", "moved away")).toBeNull();
  expect(await workspace.listCollaborators()).toEqual([]);
});
