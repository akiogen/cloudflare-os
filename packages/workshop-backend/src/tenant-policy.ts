import {
  SINGLE_TENANT_POLICY,
  type TenantPolicy,
} from "@gadgets/workshop-shared/tenant-policy";

/** Optional binding read by getTenantPolicy. */
export type TenantPolicyEnv = Readonly<{
  TENANT_POLICY?: TenantPolicy;
}>;

/**
 * The deployment's Tenant membership policy: the bound `TENANT_POLICY` service, or the
 * single-Tenant default when the deployment does not bind one.
 */
export function getTenantPolicy(env: TenantPolicyEnv): TenantPolicy {
  return env.TENANT_POLICY ?? SINGLE_TENANT_POLICY;
}
