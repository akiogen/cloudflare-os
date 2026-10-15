// ADR-0005 P2: user-directory search returns users of the caller's Team only.
//
// The fixture policy puts `ta…` users in Team A and `tb…` users in Team B, and can move a user
// with POST /assign. Directory records are synced asynchronously after authentication, so every
// positive expectation waits for it.

import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, UserDirectoryRecord } from "@gadgets/workshop-shared/api";
import { ADMIN_USERNAME, type Harness, startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

const POLICY_DIR = resolve(import.meta.dirname, "../fixtures/blos-team-policy");
const POLICY_WORKER = "blos-team-policy";

let harness: Harness | undefined;
const network = new NetworkInterceptor({ handlers: [] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    services: [{ binding: "TEAM_POLICY", dir: POLICY_DIR }],
  });
  // User search is off by default while signups are open.
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

async function createUsers(...usernames: string[]): Promise<void> {
  await Promise.all(usernames.map(async username => {
    using publicApi = connect(requireHarness().url);
    using _user = await signUp(publicApi, username);
  }));
}

async function search(username: string, query: string): Promise<string[]> {
  using publicApi = connect(requireHarness().url);
  using user: RpcStub<AuthenticatedApi> = await logIn(publicApi, username);
  const results: UserDirectoryRecord[] = await user.searchUsers(query, []);
  return results.map(r => r.id);
}

/** Wait until `username`'s search for `query` includes `expected`. */
function waitUntilFound(username: string, query: string, expected: string): Promise<string[]> {
  return waitFor(`${username} to find ${expected}`, async () => {
    const ids = await search(username, query);
    return ids.includes(expected) ? ids : null;
  });
}

async function moveToTeam(user: string, team: string): Promise<void> {
  const response = await requireHarness().fetchWorker(POLICY_WORKER,
      `http://policy/assign?user=${encodeURIComponent(user)}&team=${encodeURIComponent(team)}`,
      { method: "POST" });
  expect(response.status).toBe(204);
}

it.concurrent("does not show users of another Team by name or id", async () => {
  const [searcher, colleague, outsider, outsiderColleague] = nextUsernames(
      "tasearcher", "tacolleague", "tboutsider", "tbcolleague");
  if (!searcher || !colleague || !outsider || !outsiderColleague) {
    throw new Error("Missing test username");
  }
  await createUsers(searcher, colleague, outsider, outsiderColleague);

  // Both records are synced: each is found from inside its own Team.
  await waitUntilFound(searcher, colleague, colleague);
  await waitUntilFound(outsiderColleague, outsider, outsider);

  expect(await search(searcher, outsider)).toEqual([]);
  expect(await search(searcher, "tboutsider")).not.toContain(outsider);
  expect(await search(outsider, colleague)).toEqual([]);
});

it.concurrent("filters by Team before the result limit", async () => {
  // Eleven Team B users rank ahead of the Team A target in upstream's ordering (earlier match
  // position), so a filter applied after LIMIT 10 would return none of Team A's matches.
  const prefixes = Array.from({ length: 11 }, (_, i) => `tbcrowd${String.fromCharCode(97 + i)}`);
  const [searcher, target, ...crowd] = nextUsernames("tasearcher", "tazzzzzzcrowd", ...prefixes);
  if (!searcher || !target || crowd.length !== 11) throw new Error("Missing test username");
  await createUsers(searcher, target, ...crowd);

  const ids = await waitUntilFound(searcher, "crowd", target);
  expect(ids.filter(id => id.startsWith("tb"))).toEqual([]);
});

it.concurrent("follows a user who moves to another Team", async () => {
  const [searcherA, searcherB, mover] = nextUsernames("tasearcher", "tbsearcher", "tamover");
  if (!searcherA || !searcherB || !mover) throw new Error("Missing test username");
  await createUsers(searcherA, searcherB, mover);
  await waitUntilFound(searcherA, mover, mover);

  await moveToTeam(mover, "team-b");

  // Hidden from Team A at once, although the record is still in Team A's directory until the
  // mover signs in again.
  expect(await search(searcherA, mover)).toEqual([]);

  // Signing in moves the record to Team B's directory.
  {
    using publicApi = connect(requireHarness().url);
    using _mover = await logIn(publicApi, mover);
  }
  await waitUntilFound(searcherB, mover, mover);
  expect(await search(searcherA, mover)).toEqual([]);
});
