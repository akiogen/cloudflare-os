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
}

/** Native Workers RPC capability a deployment binds as `TENANT_POLICY`. */
export interface TenantPolicyEntrypoint extends WorkerEntrypoint, TenantPolicy {}

/** The Tenant every user belongs to when no `TENANT_POLICY` is bound. */
export const SINGLE_TENANT_ID = "default";

/** Policy used when no `TENANT_POLICY` is bound: one Tenant for the whole deployment. */
export const SINGLE_TENANT_POLICY: TenantPolicy = Object.freeze({
  tenantOf: async (_userId: string) => SINGLE_TENANT_ID,
  sameTenant: async (_a: string, _b: string) => true,
  onUserCreated: async (_userId: string) => {},
});
