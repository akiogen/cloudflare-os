// End to end with the real BLOS Tenant policy Worker (business-loop-os packages/blos-tenant-policy,
// ADR-0007) bound as TENANT_POLICY: two Free sign-ups each get their own Tenant, and the kernel's
// Tenant checks (ADR-0005 P2–P4) keep them apart.
//
// The Worker lives in the business-loop-os repository, next to this submodule. It is present in
// BLOS CI (Upstream verification) and absent in a standalone checkout of this fork, where the suite
// is skipped (ADR-0007 Decision 3).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES, type AuthenticatedApi, type Overseer,
} from "@gadgets/workshop-shared/api";
import { ADMIN_USERNAME, type Harness, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp } from "../src/rpc-client.js";

const BLOS_POLICY_DIR = resolve(import.meta.dirname, "../../../../packages/blos-tenant-policy");
const HAS_BLOS_POLICY = existsSync(resolve(BLOS_POLICY_DIR, "wrangler.jsonc"));
// Run the Worker on the kernel's runtime date rather than its own.
const KERNEL_COMPATIBILITY_DATE = "2026-09-04";

async function activate(workspace: RpcStub<Overseer>): Promise<string> {
  const { id } = await workspace.getMetadata();
  await workspace.newChat("Make this workspace visible without an agent", null);
  return id;
}

async function expectOpenDenied(
    user: RpcStub<AuthenticatedApi>, workspaceId: string, shareKey?: string): Promise<void> {
  let denied: unknown;
  try {
    using _workspace = await user.openGadget(workspaceId, shareKey);
  } catch (error) {
    denied = error;
  }
  if (denied === undefined) throw new Error("Expected workspace open to fail");
  expect(getOpenGadgetErrorCode(denied)).toBe(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
}

describe.skipIf(!HAS_BLOS_POLICY)("real BLOS Tenant policy", () => {
  let harness: Harness | undefined;
  const network = new NetworkInterceptor({ handlers: [mockChatCompletion("Test chat")] });

  beforeAll(async () => {
    network.install();
    harness = await startHarness({
      gatekeepers: [],
      services: [{
        binding: "TENANT_POLICY",
        dir: BLOS_POLICY_DIR,
        patch: config => { config.compatibility_date = KERNEL_COMPATIBILITY_DATE; },
      }],
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

  it("keeps two Free sign-ups in separate Tenants", async () => {
    const [xName, yName] = nextUsernames("freex", "freey");
    if (!xName || !yName) throw new Error("Missing test username");

    using xPublic = connect(requireHarness().url);
    using yPublic = connect(requireHarness().url);
    using x = await signUp(xPublic, xName);
    using y = await signUp(yPublic, yName);

    // Each is a real account: X finds itself only through its own sessions, and its own Gadget
    // opens again after a fresh log-in.
    using workspace = await x.newGadget();
    const id = await activate(workspace);
    {
      using againPublic = connect(requireHarness().url);
      using again = await logIn(againPublic, xName);
      using reopened = await again.openGadget(id);
      expect(await reopened.getMetadata()).toMatchObject({ id });
    }

    // Directory (P2): a single-member Free Tenant has nobody else to find. The sync mechanics are
    // covered by blos-tenant-directory.test.ts; here each user must see nothing of the other.
    expect((await x.searchUsers(yName, [])).map(r => r.id)).toEqual([]);
    expect((await y.searchUsers(xName, [])).map(r => r.id)).toEqual([]);

    // Collaborators (P3): Y cannot be added, and looks exactly like a missing account.
    expect(await workspace.addCollaborator(yName, "use", "cross-tenant")).toBeNull();
    expect(await workspace.listCollaborators()).toEqual([]);

    // Share links and open (P4): X's link grants Y nothing and writes no edge.
    const link = await workspace.createShareLink("use", "cross-tenant link");
    await expectOpenDenied(y, id, link.key);
    await expectOpenDenied(y, id);
    expect(await workspace.listCollaborators()).toEqual([]);
  });
});
