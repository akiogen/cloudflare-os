// Test double for the TENANT_POLICY binding (see workshop-shared/src/tenant-policy.ts).
//
// The Tenant is read from the username so tests need no setup: `ta…` is Tenant A, `tb…` is Tenant
// B, and anything else is the default Tenant. Pair it with nextUsernames("taowner", "tbguest").
// `POST /assign?user=<id>&tenant=<tenant>` overrides one user's Tenant, to simulate a move.
// `GET /created?user=<id>` counts onUserCreated calls, and `POST /fail?user=<id>` makes the next
// onUserCreated for that user throw once.
//
// authorizeResource follows ADR-0009 with the Tenant ID as the mailbox handle: an email mailbox
// name must be `<tenant>` or `<tenant>-<anything>`. Every other resource is allowed.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { ResourceAuthorization, TenantPolicy } from "@gadgets/workshop-shared/tenant-policy";

type Env = { OVERRIDES: DurableObjectNamespace<TenantOverrides> };

// Module exports of a Worker must be handlers, so these stay module-private.
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const DEFAULT_TENANT = "default";

function tenantForUsername(userId: string): string {
  if (userId.startsWith("ta")) return TENANT_A;
  if (userId.startsWith("tb")) return TENANT_B;
  return DEFAULT_TENANT;
}

/** One instance holds every override and counter; tests are few and small. */
export class TenantOverrides extends DurableObject<Env> {
  assign(userId: string, tenant: string): void {
    this.ctx.storage.kv.put(`tenant:${userId}`, tenant);
  }

  get(userId: string): string | undefined {
    return this.ctx.storage.kv.get<string>(`tenant:${userId}`);
  }

  failNext(userId: string): void {
    this.ctx.storage.kv.put(`fail:${userId}`, true);
  }

  /** Records one onUserCreated call; throws (without counting) when a failure was requested. */
  userCreated(userId: string): void {
    if (this.ctx.storage.kv.get<boolean>(`fail:${userId}`)) {
      this.ctx.storage.kv.delete(`fail:${userId}`);
      throw new Error(`Tenant policy failure requested for ${userId}`);
    }
    this.ctx.storage.kv.put(`created:${userId}`, this.createdCount(userId) + 1);
  }

  createdCount(userId: string): number {
    return this.ctx.storage.kv.get<number>(`created:${userId}`) ?? 0;
  }
}

export default class BlosTenantPolicy extends WorkerEntrypoint<Env> implements TenantPolicy {
  #overrides(): DurableObjectStub<TenantOverrides> {
    return this.env.OVERRIDES.getByName("");
  }

  async tenantOf(userId: string): Promise<string> {
    return (await this.#overrides().get(userId)) ?? tenantForUsername(userId);
  }

  async sameTenant(a: string, b: string): Promise<boolean> {
    const [tenantA, tenantB] = await Promise.all([this.tenantOf(a), this.tenantOf(b)]);
    return tenantA === tenantB;
  }

  async onUserCreated(userId: string): Promise<void> {
    await this.#overrides().userCreated(userId);
  }

  async authorizeResource(userId: string, vendorId: string, resourceUrl: string)
      : Promise<ResourceAuthorization> {
    if (vendorId.toLowerCase() !== "email") return { allowed: true };
    const handle = await this.tenantOf(userId);
    const at = resourceUrl.lastIndexOf("/mailbox/");
    const name = at < 0 ? "" : decodeURIComponent(resourceUrl.slice(at + "/mailbox/".length));
    if (name === handle || name.startsWith(`${handle}-`)) return { allowed: true };
    return { allowed: false, message: `Mailbox names on this deployment start with "${handle}".` };
  }

  /** Test control routes; see the header comment. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const user = url.searchParams.get("user");
    if (user === null) return new Response(null, { status: 404 });
    if (url.pathname === "/tenant-of" && request.method === "GET") {
      return Response.json({ tenant: await this.tenantOf(user) });
    }
    if (url.pathname === "/created" && request.method === "GET") {
      return Response.json({ count: await this.#overrides().createdCount(user) });
    }
    if (url.pathname === "/fail" && request.method === "POST") {
      await this.#overrides().failNext(user);
      return new Response(null, { status: 204 });
    }
    const tenant = url.searchParams.get("tenant");
    if (url.pathname === "/assign" && request.method === "POST" && tenant !== null) {
      await this.#overrides().assign(user, tenant);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }
}
