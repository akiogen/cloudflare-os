// business-loop-os#57: the BLOS Inquiry Triage Gadget (ADR-0008) inside the kernel, end to end.
//
// The Gadget's source lives in the business-loop-os repository next to this submodule
// (packages/blos-blueprints/inquiry-triage). The Gadget suite runs only when it is present (BLOS CI
// Upstream verification) and is skipped in a standalone checkout of this fork.
//
// Cloudflare Email Routing cannot be dispatched through the test harness, so fixtures/
// blos-email-sender hands the parsed email to gatekeeper-email's per-address Durable Object, the
// call gatekeeper-email's email() handler makes after parsing. That covers DO -> hook -> Gadget;
// the raw-MIME parse and the Email Routing hop are not exercised here.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES,
  type AuthenticatedApi, type Overseer, type WorkpieceSummary,
} from "@gadgets/workshop-shared/api";
import { type Harness, startHarness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, RpcTarget, signUp, stubFor, waitFor,
} from "../src/rpc-client.js";

const BLUEPRINT_FILES = resolve(import.meta.dirname,
    "../../../../packages/blos-blueprints/inquiry-triage/files");
const HAS_BLUEPRINT = existsSync(join(BLUEPRINT_FILES, "server.ts"));

// Upstream's bundled-blueprint source reader compiles a files/ tree into the client.js / server.js a
// running Gadget loads: live Gadgets load only .js modules (overseer.ts), and TypeScript blueprints
// reach them through this same compile step when bundled. Imported by path at runtime only, because
// @gadgets/bundled-blueprints is not a dependency of this package.
const BUNDLED_BLUEPRINTS_SRC = resolve(import.meta.dirname, "../../bundled-blueprints/src/index.ts");
type ReadSourceFiles = (dir: string, label: string) => Promise<Map<string, string>>;
const BLUEPRINT = HAS_BLUEPRINT
    ? [...await ((await import(BUNDLED_BLUEPRINTS_SRC)) as { readSourceFiles: ReadSourceFiles })
        .readSourceFiles(BLUEPRINT_FILES, "blos.inquiry-triage")]
        .map(([filename, content]) => ({ filename, content }))
    : [];

const POLICY_DIR = resolve(import.meta.dirname, "../fixtures/blos-tenant-policy");

const DRAFT = { category: "delivery", draft: "Thank you for asking. The employee will confirm the date.",
                usedEntryIds: [] };
const model = scriptedChatCompletions([
  { toolCall: { id: "create", name: "createGadget",
                arguments: { title: "Inquiry Triage", bindingName: "INQ" } } },
  ...BLUEPRINT.map((file, i) => ({ toolCall: { id: `write-${i}`, name: "writeFile",
                arguments: { workpiece: "INQ", filename: file.filename, content: file.content } } })),
  { text: "Done." },
  // The Gadget's own AI binding, for the first observed (post-baseline) inquiry.
  { text: JSON.stringify(DRAFT) },
]);

const EMAIL_DIR = resolve(import.meta.dirname, "../../gatekeeper-email");
const SENDER_DIR = resolve(import.meta.dirname, "../fixtures/blos-email-sender");

let harness: Harness | undefined;
const network = new NetworkInterceptor({ handlers: [model.handler] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    // Prebuilt by build:blos-email-gatekeeper; do not rebuild at boot.
    gatekeepers: [{ binding: "EMAIL", dir: EMAIL_DIR, patch: config => { delete config.build; } }],
    services: [
      { binding: "BLOS_EMAIL_SENDER", dir: SENDER_DIR },
      { binding: "TENANT_POLICY", dir: POLICY_DIR },
    ],
    enableGadgetExecution: true,
    // Account connections hand off to the Workshop's origin (connect-handoff.ts).
    patchWorkshop: config => { config.vars = { ...config.vars, PUBLIC_BASE_URL: "http://localhost:8787" }; },
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

it("connects an email account and creates a mailbox gatekeeper", async () => {
  const [name] = nextUsernames("taowner");
  using publicApi = connect(requireHarness().url);
  using user = await signUp(publicApi, name!);

  const flow = await user.connectAccount("email");
  const page = await requireHarness().fetchWorker("gatekeeper-email", flow.url);
  const html = await page.text();
  const ticket = /var ticket = "([^"]+)"/.exec(html)?.[1];
  if (!ticket) throw new Error(`No ticket in connect page: ${html.slice(0, 300)}`);
  await user.completeConnectHandoff(ticket, flow.nonce);
  const account = await waitFor("the email account", async () =>
    (await listConnectedAccounts(user)).find(a => a.vendorId === "email") ?? null);

  using workspace = await user.newGadget();
  const mailbox = `tenant-a-inq${name}`;  // Under the fixture Tenant A handle (ADR-0009)
  using gatekeeper = await workspace.newGatekeeper(
      account.id, `http://localhost:8787/gatekeeper/email/mailbox/${mailbox}`);
  expect(gatekeeper).not.toBeNull();
});

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

async function gadgetsIn(workspace: RpcStub<Overseer>): Promise<WorkpieceSummary[]> {
  const found: WorkpieceSummary[] = [];
  const { promise: ready, resolve: done } = Promise.withResolvers<void>();
  class Subscriber extends RpcTarget {
    entry(summary: WorkpieceSummary) { found.push(summary); }
    removed() {}
    ready() { done(); }
  }
  using subscriber = stubFor(new Subscriber());
  using _subscription = await workspace.subscribeToWorkpieces(subscriber);
  await ready;
  return found.filter(w => w.type === "gadget");
}

async function deliver(mailbox: string, n: number): Promise<void> {
  const response = await requireHarness().fetchWorker("blos-email-sender",
      `http://sender/deliver?to=${encodeURIComponent(mailbox)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: { name: "Customer", address: `customer${n}@customer.example` },
          to: [{ name: "", address: `${mailbox}@localhost` }],
          cc: [],
          subject: `Delivery date question ${n}`,
          date: new Date().toISOString(),
          text: `When will order ${n} arrive?`,
          html: null,
        }),
      });
  expect(response.status, await response.clone().text()).toBe(204);
}

describe.skipIf(!HAS_BLUEPRINT)("BLOS Inquiry Triage Gadget in the kernel", () => {
  it("receives email into the owner's Gadget and drafts after the baseline", async () => {
    const [name] = nextUsernames("taowner");
    using publicApi = connect(requireHarness().url);
    using user = await signUp(publicApi, name!);
    await user.addModel(SCRIPTED_MODEL_PROFILE, SCRIPTED_MODEL_CONFIG);
    const accountId = await connectEmailAccount(user);

    using workspace = await user.newGadget();
    const chatId = await workspace.newChat("Set up the inquiry gadget.", SCRIPTED_MODEL_ID);
    await waitFor("the agent turn to finish", async () => {
      const chat = (await workspace.listChats()).find(c => c.id === chatId);
      return chat && !chat.activeAgent && (await gadgetsIn(workspace)).length > 0 ? true : null;
    }, 120_000);
    const merged = await workspace.mergeChanges(chatId);
    expect(merged.outcome).toBe("merged");
    const [inq] = await gadgetsIn(workspace);
    if (!inq) throw new Error("No gadget was created");

    const mailbox = `tenant-a-inq${name}`;  // Under the fixture Tenant A handle (ADR-0009)
    using emailGk = await workspace.newGatekeeper(
        accountId, `http://localhost:8787/gatekeeper/email/mailbox/${mailbox}`);
    if (!emailGk) throw new Error("No email gatekeeper");
    using aiGk = await workspace.newAiModelGatekeeper(SCRIPTED_MODEL_ID);
    using client = await workspace.getGadget(inq.id);
    await client.bind("EMAIL", await emailGk.getId());
    await client.bind("AI", await aiGk.getId());

    using gadget = await client.connectToGadget() as unknown as RpcStub<{
      subscribeMailbox(): Promise<string | null>;
      listInquiries(): Promise<{ baseline: boolean; status: string; draft?: unknown }[]>;
    }>;
    const address = await gadget.subscribeMailbox();
    expect(address).toContain(mailbox);
    // The hook binding is recorded as approved but created disabled: the user turns it on.
    const [hook] = await workspace.listHooks();
    expect(hook).toMatchObject({ resourceUrl: expect.stringContaining(mailbox), enabled: false });
    await workspace.enableHook(hook!.id);

    for (let n = 1; n <= 6; n++) await deliver(mailbox, n);
    const inquiries = await waitFor("six inquiries, the last one drafted", async () => {
      const list = await gadget.listInquiries();
      return list.length === 6 && list.some(i => !i.baseline && i.status === "drafted") ? list : null;
    }, 60_000);
    expect(inquiries.filter(i => i.baseline)).toHaveLength(5);
    expect(inquiries.filter(i => i.baseline && i.draft)).toHaveLength(0);
    const observed = inquiries.find(i => !i.baseline);
    expect(observed).toMatchObject({ status: "drafted", draft: { category: "delivery" } });

    // The inquiries live in the owner's Gadget: a user of another Tenant cannot open the workspace
    // (ADR-0005 P4), with or without a share link.
    const { id: workspaceId } = await workspace.getMetadata();
    const [outsider] = nextUsernames("tboutsider");
    using outsiderPublic = connect(requireHarness().url);
    using outsiderApi = await signUp(outsiderPublic, outsider!);
    const link = await workspace.createShareLink("use", "cross-tenant");
    for (const key of [undefined, link.key]) {
      let denied: unknown;
      try {
        using _ws = await outsiderApi.openGadget(workspaceId, key);
      } catch (error) {
        denied = error;
      }
      expect(getOpenGadgetErrorCode(denied)).toBe(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
    }
  });
});
