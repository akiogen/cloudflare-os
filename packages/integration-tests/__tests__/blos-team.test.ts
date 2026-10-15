// BLOS ADR-0012: Team Admins open the Team's Gadgets without a permission edge (P7), departed
// members cannot sign in or use a session (P8), and Team Admins list the Team's Gadgets (P9).
//
// The fixture policy puts `ta…` users in Team A and `tb…` users in Team B. POST /admin makes a
// user a Team administrator and POST /depart marks a user as departed.

import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getAuthErrorCode, getOpenGadgetErrorCode, AUTH_ERROR_CODES, OPEN_GADGET_ERROR_CODES,
  type AuthenticatedApi, type Overseer,
} from "@gadgets/workshop-shared/api";
import { type Harness, settleRestart, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, passwordHashFor, signUp } from "../src/rpc-client.js";

const POLICY_DIR = resolve(import.meta.dirname, "../fixtures/blos-team-policy");
const POLICY_WORKER = "blos-team-policy";

let harness: Harness | undefined;
const network = new NetworkInterceptor({ handlers: [mockChatCompletion("Test chat")] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    services: [{ binding: "TEAM_POLICY", dir: POLICY_DIR }],
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

async function policy(path: "admin" | "depart", user: string): Promise<void> {
  const response = await requireHarness().fetchWorker(POLICY_WORKER,
      `http://policy/${path}?user=${encodeURIComponent(user)}`, { method: "POST" });
  expect(response.status).toBe(204);
}

async function expectOpenDenied(
    authenticated: RpcStub<AuthenticatedApi>, workspaceId: string): Promise<void> {
  let denied: unknown;
  try {
    using _workspace = await authenticated.openGadget(workspaceId);
  } catch (error) {
    denied = error;
  }
  if (denied === undefined) throw new Error("Expected workspace open to fail");
  expect(getOpenGadgetErrorCode(denied)).toBe(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
}

async function expectSessionRefused(token: string): Promise<void> {
  using publicApi = connect(requireHarness().url);
  let refused: unknown;
  try {
    using _user = await publicApi.authenticate(token);
  } catch (error) {
    refused = error;
  }
  if (refused === undefined) throw new Error("Expected the session to be refused");
  expect(getAuthErrorCode(refused)).toBe(AUTH_ERROR_CODES.invalidSessionToken);
}

/** Open as `username` in a fresh session and return the Gadget's metadata role. */
async function openAs(username: string, workspaceId: string): Promise<string | undefined> {
  using publicApi = connect(requireHarness().url);
  using user = await logIn(publicApi, username);
  using opened = await user.openGadget(workspaceId);
  return (await opened.getMetadata()).role;
}

/** A member of `prefix`'s Team with one activated Gadget. */
async function memberWithGadget(name: string): Promise<{ id: string }> {
  using publicApi = connect(requireHarness().url);
  using member = await signUp(publicApi, name);
  using workspace = await member.newGadget();
  return { id: await activate(workspace) };
}

async function signUpOnly(name: string): Promise<void> {
  using publicApi = connect(requireHarness().url);
  using _user = await signUp(publicApi, name);
}

it.concurrent("P7: a Team Admin opens a member's Gadget with build and writes no edge", async () => {
  const [ownerName, adminName] = usernames("taowner", "taadmin");
  using ownerPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName!);
  using workspace = await owner.newGadget();
  const id = await activate(workspace);
  await signUpOnly(adminName!);
  await policy("admin", adminName!);

  expect(await openAs(adminName!, id)).toBe("build");
  expect(await workspace.listCollaborators()).toEqual([]);
  await settleRestart();
});

it.concurrent("P7: a member who is not a Team Admin is refused", async () => {
  const [ownerName, colleagueName] = usernames("taowner", "tacolleague");
  const { id } = await memberWithGadget(ownerName!);
  using colleaguePublic = connect(requireHarness().url);
  using colleague = await signUp(colleaguePublic, colleagueName!);

  await expectOpenDenied(colleague, id);
});

it.concurrent("P7: an administrator of another Team is refused", async () => {
  const [ownerName, adminName] = usernames("taowner", "tbadmin");
  const { id } = await memberWithGadget(ownerName!);
  using adminPublic = connect(requireHarness().url);
  using admin = await signUp(adminPublic, adminName!);
  await policy("admin", adminName!);

  await expectOpenDenied(admin, id);
});

it.concurrent("P7: an existing edge is not widened for a Team Admin", async () => {
  const [ownerName, adminName] = usernames("taowner", "taadmin");
  using ownerPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName!);
  using workspace = await owner.newGadget();
  const id = await activate(workspace);
  await signUpOnly(adminName!);
  expect(await workspace.addCollaborator(adminName!, "use", "viewer")).not.toBeNull();
  await policy("admin", adminName!);

  expect(await openAs(adminName!, id)).toBe("use");
  await settleRestart();
});

it.concurrent("P8: a departed member cannot sign in, and their session is refused", async () => {
  const [memberName] = usernames("taleaver");
  using publicApi = connect(requireHarness().url);
  const token = await publicApi.createAccount(memberName!, memberName!, passwordHashFor(memberName!));
  if (!token) throw new Error("Signup failed");
  {
    using _session = await publicApi.authenticate(token);
  }

  await policy("depart", memberName!);
  await expectSessionRefused(token);
  const fresh = await publicApi.login(memberName!, passwordHashFor(memberName!));
  if (fresh === null) throw new Error("Expected login to issue a token");
  await expectSessionRefused(fresh);
});

it.concurrent("P7/P8: a Team Admin still opens a departed member's Gadget", async () => {
  const [ownerName, adminName] = usernames("taleaver", "taadmin");
  const { id } = await memberWithGadget(ownerName!);
  await signUpOnly(adminName!);
  await policy("admin", adminName!);
  await policy("depart", ownerName!);

  expect(await openAs(adminName!, id)).toBe("build");
  await settleRestart();
});

it.concurrent("P9: a Team Admin lists the Team's own Gadgets, and nobody else's", async () => {
  const [memberName, adminName, outsiderName] = usernames("tamember", "taadmin", "tboutsider");
  const mine = await memberWithGadget(memberName!);
  const theirs = await memberWithGadget(outsiderName!);
  using adminPublic = connect(requireHarness().url);
  using admin = await signUp(adminPublic, adminName!);

  // Not yet an administrator: nothing.
  expect(await admin.listTeamGadgets()).toEqual([]);

  await policy("admin", adminName!);
  const listed = await admin.listTeamGadgets();
  expect(listed.find(g => g.id === mine.id)?.ownerId).toBe(memberName);
  expect(listed.some(g => g.id === theirs.id)).toBe(false);
  expect(listed.every(g => !g.owner)).toBe(true);
});

it.concurrent("P9: a member who is not a Team Admin lists nothing", async () => {
  const [memberName, colleagueName] = usernames("tamember", "tacolleague");
  await memberWithGadget(memberName!);
  using colleaguePublic = connect(requireHarness().url);
  using colleague = await signUp(colleaguePublic, colleagueName!);

  expect(await colleague.listTeamGadgets()).toEqual([]);
});
