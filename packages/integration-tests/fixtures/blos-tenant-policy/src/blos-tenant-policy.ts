// Test double for the TENANT_POLICY binding (see workshop-shared/src/tenant-policy.ts).
//
// The Tenant is read from the username so tests need no setup: `ta…` is Tenant A, `tb…` is Tenant
// B, and anything else is the default Tenant. Pair it with nextUsernames("taowner", "tbguest").

import { WorkerEntrypoint } from "cloudflare:workers";
import type { TenantPolicy } from "@gadgets/workshop-shared/tenant-policy";

// Module exports of a Worker must be handlers, so these stay module-private.
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const DEFAULT_TENANT = "default";

function tenantForUsername(userId: string): string {
  if (userId.startsWith("ta")) return TENANT_A;
  if (userId.startsWith("tb")) return TENANT_B;
  return DEFAULT_TENANT;
}

export default class BlosTenantPolicy extends WorkerEntrypoint implements TenantPolicy {
  async tenantOf(userId: string): Promise<string> {
    return tenantForUsername(userId);
  }

  async sameTenant(a: string, b: string): Promise<boolean> {
    return tenantForUsername(a) === tenantForUsername(b);
  }

  async onUserCreated(_userId: string): Promise<void> {}

  /** `GET /tenant-of?user=<id>`, so tests can check the mapping without going through the Workshop. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const user = url.searchParams.get("user");
    if (url.pathname !== "/tenant-of" || user === null) return new Response(null, { status: 404 });
    return Response.json({ tenant: tenantForUsername(user) });
  }
}
