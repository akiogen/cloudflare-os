// BLOS ADR-0015: a person can belong to many Teams, with one account per Team membership, named
// `<email>#<team>`. The fixture policy lets a person switch to a Team after `POST /member`, and
// names the person's account in the caller's Team for typed names (accountInTeamOf).

import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp } from "../src/rpc-client.js";

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

async function addMembership(user: string, team: string): Promise<void> {
  const response = await requireHarness().fetchWorker(POLICY_WORKER,
      `http://policy/member?user=${encodeURIComponent(user)}&team=${encodeURIComponent(team)}`,
      { method: "POST" });
  expect(response.status).toBe(204);
}

it.concurrent("switches to a Team the person belongs to, as a separate account", async () => {
  const [name] = usernames("taperson");
  using publicApi = connect(requireHarness().url);
  using home = await signUp(publicApi, name!);
  using homeGadget = await home.newGadget();
  const { id: homeGadgetId } = await homeGadget.getMetadata();
  await addMembership(name!, "team-x");

  const token = await home.switchTeam("team-x");
  expect(token).toMatch(new RegExp(`^${name}#team-x:`));
  using switchedPublic = connect(requireHarness().url);
  using switched = await switchedPublic.authenticate(token!);
  expect((await switched.whoami()).id).toBe(`${name}#team-x`);
  // The Team's account has its own data: the home Team's Gadget is not listed there.
  expect((await switched.listGadgets()).map(g => g.id)).not.toContain(homeGadgetId);
  // Switching back reuses the same account.
  await addMembership(name!, "team-a");
  const again = await switched.switchTeam("team-x");
  expect(again).toMatch(new RegExp(`^${name}#team-x:`));
});

it.concurrent("refuses a Team the person does not belong to", async () => {
  const [name] = usernames("taperson");
  using publicApi = connect(requireHarness().url);
  using home = await signUp(publicApi, name!);
  await expect(home.switchTeam("team-y")).resolves.toBeNull();
});

it.concurrent("adds a typed name as that person's account in the owner's Team", async () => {
  const [ownerName, memberName, outsiderName] = usernames("taowner", "tamember", "taoutsider");
  using ownerPublic = connect(requireHarness().url);
  using memberPublic = connect(requireHarness().url);
  using outsiderPublic = connect(requireHarness().url);
  using ownerHome = await signUp(ownerPublic, ownerName!);
  using memberHome = await signUp(memberPublic, memberName!);
  using _outsider = await signUp(outsiderPublic, outsiderName!);
  await addMembership(ownerName!, "team-z");
  await addMembership(memberName!, "team-z");
  using ownerSwitchPublic = connect(requireHarness().url);
  using owner = await ownerSwitchPublic.authenticate((await ownerHome.switchTeam("team-z"))!);
  // The member's team-z account exists once they have switched there.
  expect(await memberHome.switchTeam("team-z")).not.toBeNull();

  using workspace = await owner.newGadget();
  await workspace.newChat("Make this workspace visible without an agent", null);
  const added = await workspace.addCollaborator(memberName!, "use", "same Team");
  expect(added).toMatchObject({ profile: { id: `${memberName}#team-z` } });
  // The outsider has no team-z account, so the typed name finds nobody.
  await expect(workspace.addCollaborator(outsiderName!, "use", "no account")).resolves.toBeNull();
});
