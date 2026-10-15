import type { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Team membership seam for deployments that host several organizations (Teams) on one
 * Workshop. A deployment opts in by binding a Worker that implements `TeamPolicyEntrypoint` as
 * `TEAM_POLICY`; without that binding every user belongs to one Team and the Workshop behaves
 * exactly as it does for a single organization.
 *
 * `userId` is the Workshop's account key: the verified email, or the username on password
 * deployments.
 */
export interface TeamPolicy {
  /** The Team `userId` belongs to. */
  teamOf(userId: string): Promise<string>;
  /** Whether `a` and `b` belong to the same Team. */
  sameTeam(a: string, b: string): Promise<boolean>;
  /** Called once after a new account is created, so the policy can assign it a Team. */
  onUserCreated(userId: string): Promise<void>;
  /**
   * Called before `resourceUrl` of the gatekeeper `vendorId` becomes a capability for `userId`,
   * and before the gatekeeper is asked, so a denied resource is never claimed or created. A denial
   * message must not reveal anything about other Teams.
   */
  authorizeResource(userId: string, vendorId: string, resourceUrl: string)
      : Promise<ResourceAuthorization>;
  /**
   * The role a Team role grants `userId` on a Gadget owned by `ownerId`, for a caller with no
   * permission edge (BLOS ADR-0012 P7); `null` grants nothing. Never consulted when an edge exists,
   * and the same-Team check and observer verification still apply.
   */
  teamRole(ownerId: string, userId: string): Promise<"build" | "use" | null>;
  /** Whether `userId` may sign in and use a session; false for a departed member (ADR-0012 P8). */
  allowSignIn(userId: string): Promise<boolean>;
  /**
   * The members of `userId`'s Team, departed members included, when `userId` administers it;
   * `null` otherwise (ADR-0012 P9).
   */
  teamMembers(userId: string): Promise<string[] | null>;
}

/** Outcome of `TeamPolicy.authorizeResource`. `message` is shown to the caller as is. */
export type ResourceAuthorization = { allowed: true } | { allowed: false; message: string };

/** Native Workers RPC capability a deployment binds as `TEAM_POLICY`. */
export interface TeamPolicyEntrypoint extends WorkerEntrypoint, TeamPolicy {}

/** The Team every user belongs to when no `TEAM_POLICY` is bound. */
export const SINGLE_TEAM_ID = "default";

/** Policy used when no `TEAM_POLICY` is bound: one Team for the whole deployment. */
export const SINGLE_TEAM_POLICY: TeamPolicy = Object.freeze({
  teamOf: async (_userId: string) => SINGLE_TEAM_ID,
  sameTeam: async (_a: string, _b: string) => true,
  onUserCreated: async (_userId: string) => {},
  authorizeResource: async (_userId: string, _vendorId: string, _resourceUrl: string)
      : Promise<ResourceAuthorization> => ({ allowed: true }),
  teamRole: async (_ownerId: string, _userId: string) => null,
  allowSignIn: async (_userId: string) => true,
  teamMembers: async (_userId: string) => null,
});
