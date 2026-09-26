// ADR-0009 / business-loop-os#53 (P6) end to end, with the real BLOS Tenant policy Worker bound as
// TENANT_POLICY and the real gatekeeper-email: each Free Tenant gets its own mailbox handle, may
// bind only names under it, and a denied name is neither claimed nor revealed.
//
// The policy Worker lives in the business-loop-os repository, next to this submodule. The suite is
// skipped in a standalone checkout of this fork (ADR-0007 Decision 3), like blos-tenant-e2e.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import { type Harness, startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor,
} from "../src/rpc-client.js";

const BLOS_POLICY_DIR = resolve(import.meta.dirname, "../../../../packages/blos-tenant-policy");
const HAS_BLOS_POLICY = existsSync(resolve(BLOS_POLICY_DIR, "wrangler.jsonc"));
// Run the Worker on the kernel's runtime date rather than its own.
const KERNEL_COMPATIBILITY_DATE = "2026-09-04";
const EMAIL_DIR = resolve(import.meta.dirname, "../../gatekeeper-email");
const MAILBOX_BASE = "http://localhost:8787/gatekeeper/email/mailbox/";
const HANDLE_IN_MESSAGE = /start with "([a-z0-9]{10})"/;

describe.skipIf(!HAS_BLOS_POLICY)("real BLOS Tenant policy: mailbox names", () => {
  let harness: Harness | undefined;
  const network = new NetworkInterceptor({ handlers: [] });

  beforeAll(async () => {
    network.install();
    harness = await startHarness({
      // Prebuilt by build:blos-email-gatekeeper; do not rebuild at boot.
      gatekeepers: [{ binding: "EMAIL", dir: EMAIL_DIR, patch: config => { delete config.build; } }],
      services: [{
        binding: "TENANT_POLICY",
        dir: BLOS_POLICY_DIR,
        patch: config => { config.compatibility_date = KERNEL_COMPATIBILITY_DATE; },
      }],
      // Account connections hand off to the Workshop's origin (connect-handoff.ts).
      patchWorkshop: config => {
        config.vars = { ...config.vars, PUBLIC_BASE_URL: "http://localhost:8787" };
      },
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

  async function connectEmailAccount(user: RpcStub<AuthenticatedApi>): Promise<number> {
    const flow = await user.connectAccount("email");
    const page = await requireHarness().fetchWorker("gatekeeper-email", flow.url);
    const html = await page.text();
    const ticket = /var ticket = "([^"]+)"/.exec(html)?.[1];
    if (!ticket) throw new Error(`No ticket in connect page: ${html.slice(0, 300)}`);
    await user.completeConnectHandoff(ticket, flow.nonce);
    const account = await waitFor("the email account", async () =>
      (await listConnectedAccounts(user)).find(a => a.vendorId === "email") ?? null);
    return account.id;
  }

  /** Binds mailbox `name` in `workspace`; returns the denial message, or null when it was bound. */
  async function bind(workspace: RpcStub<Overseer>, accountId: number, name: string)
      : Promise<string | null> {
    try {
      using _gatekeeper = await workspace.newGatekeeper(accountId, MAILBOX_BASE + name);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  function handleIn(message: string | null): string {
    const handle = message === null ? undefined : HANDLE_IN_MESSAGE.exec(message)?.[1];
    if (!handle) throw new Error(`No mailbox handle in denial: ${message}`);
    return handle;
  }

  it("keeps each Free Tenant to names under its own handle", async () => {
    const [xName, yName] = nextUsernames("mailx", "maily");
    if (!xName || !yName) throw new Error("Missing test username");
    using xPublic = connect(requireHarness().url);
    using yPublic = connect(requireHarness().url);
    using x = await signUp(xPublic, xName);
    using y = await signUp(yPublic, yName);
    const xAccount = await connectEmailAccount(x);
    const yAccount = await connectEmailAccount(y);
    using xWorkspace = await x.newGadget();
    using yWorkspace = await y.newGadget();

    // A name outside the handle is denied, and the denial tells the user their own handle.
    const hx = handleIn(await bind(xWorkspace, xAccount, "support"));
    const hy = handleIn(await bind(yWorkspace, yAccount, "support"));
    expect(hx).not.toBe(hy);
    // The handle is stable across calls.
    expect(handleIn(await bind(xWorkspace, xAccount, `x${hx}`))).toBe(hx);

    // X may use its handle alone and with a suffix.
    expect(await bind(xWorkspace, xAccount, `${hx}-inq`)).toBeNull();
    expect(await bind(xWorkspace, xAccount, hx)).toBeNull();

    // Y is denied X's names with one message, whether the name is claimed or not, and the message
    // names only Y's handle.
    const claimed = await bind(yWorkspace, yAccount, `${hx}-inq`);
    const unused = await bind(yWorkspace, yAccount, `${hx}-unused`);
    expect(claimed).not.toBeNull();
    expect(claimed).toBe(unused);
    expect(claimed).toContain(hy);
    expect(claimed).not.toContain(hx);

    // Y's denied attempt claimed nothing: X can still bind that name.
    expect(await bind(xWorkspace, xAccount, `${hx}-unused`)).toBeNull();
    // And Y can use its own handle.
    expect(await bind(yWorkspace, yAccount, `${hy}-inq`)).toBeNull();
  });
});
