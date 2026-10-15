import { describe, expect, it, vi } from "vitest";
import {
  SINGLE_TEAM_ID,
  SINGLE_TEAM_POLICY,
  type TeamPolicy,
} from "@gadgets/workshop-shared/team-policy";
import { getTeamPolicy, userDirectoryName } from "../src/team-policy.js";

describe("getTeamPolicy", () => {
  it("falls back to the single-Team policy when TEAM_POLICY is not bound", () => {
    expect(getTeamPolicy({})).toBe(SINGLE_TEAM_POLICY);
  });

  it("returns the bound TEAM_POLICY service", () => {
    const bound: TeamPolicy = {
      teamOf: vi.fn(),
      sameTeam: vi.fn(),
      onUserCreated: vi.fn(),
    };
    expect(getTeamPolicy({ TEAM_POLICY: bound })).toBe(bound);
  });
});

describe("SINGLE_TEAM_POLICY", () => {
  it("puts every user in one Team", async () => {
    await expect(SINGLE_TEAM_POLICY.teamOf("alice@example.com")).resolves.toBe(SINGLE_TEAM_ID);
    await expect(SINGLE_TEAM_POLICY.teamOf("bob")).resolves.toBe(SINGLE_TEAM_ID);
    await expect(SINGLE_TEAM_POLICY.sameTeam("alice@example.com", "bob")).resolves.toBe(true);
  });

  it("does nothing when an account is created", async () => {
    await expect(SINGLE_TEAM_POLICY.onUserCreated("alice@example.com")).resolves.toBeUndefined();
  });

  // BLOS ADR-0012: without a bound policy, P7–P9 change nothing.
  it("grants no Team role, refuses no sign-in and lists no members", async () => {
    await expect(SINGLE_TEAM_POLICY.teamRole("alice@example.com", "bob")).resolves.toBeNull();
    await expect(SINGLE_TEAM_POLICY.allowSignIn("alice@example.com")).resolves.toBe(true);
    await expect(SINGLE_TEAM_POLICY.teamMembers("alice@example.com")).resolves.toBeNull();
  });
});

describe("userDirectoryName", () => {
  it("keeps the deployment-wide directory for the single Team", () => {
    expect(userDirectoryName(SINGLE_TEAM_ID)).toBe("");
  });

  it("gives every other Team its own directory", () => {
    expect(userDirectoryName("team-a")).toBe("team:team-a");
    expect(userDirectoryName("team-b")).not.toBe(userDirectoryName("team-a"));
  });
});
