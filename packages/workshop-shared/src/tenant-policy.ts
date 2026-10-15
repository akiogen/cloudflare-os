import type { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Tenant membership seam for deployments that host several organizations (Tenants) on one
 * Workshop. A deployment opts in by binding a Worker that implements `TenantPolicyEntrypoint` as
 * `TENANT_POLICY`; without that binding every user belongs to one Tenant and the Workshop behaves
 * exactly as it does for a single organization.
 *
 * `userId` is the Workshop's account key: the verified email, or the username on password
 * deployments.
 */
export interface TenantPolicy {
  /** The Tenant `userId` belongs to. */
  tenantOf(userId: string): Promise<string>;
  /** Whether `a` and `b` belong to the same Tenant. */
  sameTenant(a: string, b: string): Promise<boolean>;
  /** Called once after a new account is created, so the policy can assign it a Tenant. */
  onUserCreated(userId: string): Promise<void>;
  /**
   * Called before `resourceUrl` of the gatekeeper `vendorId` becomes a capability for `userId`,
   * and before the gatekeeper is asked, so a denied resource is never claimed or created. A denial
   * message must not reveal anything about other Tenants.
   */
  authorizeResource(userId: string, vendorId: string, resourceUrl: string)
      : Promise<ResourceAuthorization>;
  /**
   * The role a Tenant role grants `userId` on a Gadget owned by `ownerId`, for a caller with no
   * permission edge (BLOS ADR-0012 P7); `null` grants nothing. Never consulted when an edge exists,
   * and the same-Tenant check and observer verification still apply.
   */
  teamRole(ownerId: string, userId: string): Promise<"build" | "use" | null>;
  /** Whether `userId` may sign in and use a session; false for a departed member (ADR-0012 P8). */
  allowSignIn(userId: string): Promise<boolean>;
  /**
   * The members of `userId`'s Tenant, departed members included, when `userId` administers it;
   * `null` otherwise (ADR-0012 P9).
   */
  teamMembers(userId: string): Promise<string[] | null>;
}

/** Outcome of `TenantPolicy.authorizeResource`. `message` is shown to the caller as is. */
export type ResourceAuthorization = { allowed: true } | { allowed: false; message: string };

/** Native Workers RPC capability a deployment binds as `TENANT_POLICY`. */
export interface TenantPolicyEntrypoint extends WorkerEntrypoint, TenantPolicy {}

/** The Tenant every user belongs to when no `TENANT_POLICY` is bound. */
export const SINGLE_TENANT_ID = "default";

/** Policy used when no `TENANT_POLICY` is bound: one Tenant for the whole deployment. */
export const SINGLE_TENANT_POLICY: TenantPolicy = Object.freeze({
  tenantOf: async (_userId: string) => SINGLE_TENANT_ID,
  sameTenant: async (_a: string, _b: string) => true,
  onUserCreated: async (_userId: string) => {},
  authorizeResource: async (_userId: string, _vendorId: string, _resourceUrl: string)
      : Promise<ResourceAuthorization> => ({ allowed: true }),
  teamRole: async (_ownerId: string, _userId: string) => null,
  allowSignIn: async (_userId: string) => true,
  teamMembers: async (_userId: string) => null,
});
