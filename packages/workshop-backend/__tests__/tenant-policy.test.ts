import { describe, expect, it, vi } from "vitest";
import {
  SINGLE_TENANT_ID,
  SINGLE_TENANT_POLICY,
  type TenantPolicy,
} from "@gadgets/workshop-shared/tenant-policy";
import { getTenantPolicy, userDirectoryName } from "../src/tenant-policy.js";

describe("getTenantPolicy", () => {
  it("falls back to the single-Tenant policy when TENANT_POLICY is not bound", () => {
    expect(getTenantPolicy({})).toBe(SINGLE_TENANT_POLICY);
  });

  it("returns the bound TENANT_POLICY service", () => {
    const bound: TenantPolicy = {
      tenantOf: vi.fn(),
      sameTenant: vi.fn(),
      onUserCreated: vi.fn(),
    };
    expect(getTenantPolicy({ TENANT_POLICY: bound })).toBe(bound);
  });
});

describe("SINGLE_TENANT_POLICY", () => {
  it("puts every user in one Tenant", async () => {
    await expect(SINGLE_TENANT_POLICY.tenantOf("alice@example.com")).resolves.toBe(SINGLE_TENANT_ID);
    await expect(SINGLE_TENANT_POLICY.tenantOf("bob")).resolves.toBe(SINGLE_TENANT_ID);
    await expect(SINGLE_TENANT_POLICY.sameTenant("alice@example.com", "bob")).resolves.toBe(true);
  });

  it("does nothing when an account is created", async () => {
    await expect(SINGLE_TENANT_POLICY.onUserCreated("alice@example.com")).resolves.toBeUndefined();
  });
});

describe("userDirectoryName", () => {
  it("keeps the deployment-wide directory for the single Tenant", () => {
    expect(userDirectoryName(SINGLE_TENANT_ID)).toBe("");
  });

  it("gives every other Tenant its own directory", () => {
    expect(userDirectoryName("tenant-a")).toBe("tenant:tenant-a");
    expect(userDirectoryName("tenant-b")).not.toBe(userDirectoryName("tenant-a"));
  });
});
