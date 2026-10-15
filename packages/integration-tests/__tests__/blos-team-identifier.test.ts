// business-loop-os INV-001 cases 3 and 4 (Critical Invariants §3):
//
// 3. A caller cannot select another Team. The Team is derived on the server from the verified
//    user (ADR-0005, ADR-0006, ADR-0007); no Workshop endpoint takes a Team identifier, and the
//    Team policy is reachable only over the Workshop's service binding, never over HTTP.
//    (A Team-scoped name in a request, a mailbox handle, is covered by blos-team-mailbox.)
// 4. Team B cannot observe Team A's state: A's Gadgets never appear in B's listings.
//
// The fixture policy puts `ta…` users in Team A and `tb…` users in Team B.

import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Overseer } from "@gadgets/workshop-shared/api";
import { type Harness, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp } from "../src/rpc-client.js";

const POLICY_DIR = resolve(import.meta.dirname, "../fixtures/blos-team-policy");

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

async function activate(workspace: RpcStub<Overseer>): Promise<string> {
  const { id } = await workspace.getMetadata();
  await workspace.newChat("Make this workspace visible without an agent", null);
  return id;
}

it("does not expose the Team policy over HTTP (INV-001 case 3)", async () => {
  // The policy's own test routes (/assign, /team-of) would let a caller move or read Teams; none
  // of them may be reachable through the Workshop, under any plausible path.
  for (const path of [
    "/gatekeeper/team-policy/assign?user=x&team=team-a",
    "/gatekeeper/TEAM_POLICY/team-of?user=x",
    "/team-policy/assign?user=x&team=team-a",
    "/assign?user=x&team=team-a",
  ]) {
    const response = await fetch(new URL(path, requireHarness().url), { method: "POST" });
    expect(response.status, path).not.toBe(204);
    expect(response.status, path).toBeGreaterThanOrEqual(400);
  }
});

it("keeps Team A's Gadgets out of Team B's listings (INV-001 case 4)", async () => {
  const [aName, bName] = nextUsernames("taowner", "tbviewer");
  if (!aName || !bName) throw new Error("Missing test username");
  using aPublic = connect(requireHarness().url);
  using bPublic = connect(requireHarness().url);
  using a = await signUp(aPublic, aName);
  using b = await signUp(bPublic, bName);

  using workspace = await a.newGadget();
  const id = await activate(workspace);

  // A sees its own Gadget (case 1) ...
  expect((await a.listGadgets()).map(g => g.id)).toContain(id);
  // ... and B, in another Team, sees nothing of it.
  expect((await b.listGadgets()).map(g => g.id)).not.toContain(id);
});
