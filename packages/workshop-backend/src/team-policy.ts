import {
  SINGLE_TEAM_ID,
  SINGLE_TEAM_POLICY,
  type TeamPolicy,
} from "@gadgets/workshop-shared/team-policy";

/** Optional binding read by getTeamPolicy. */
export type TeamPolicyEnv = Readonly<{
  TEAM_POLICY?: TeamPolicy;
}>;

/**
 * The deployment's Team membership policy: the bound `TEAM_POLICY` service, or the
 * single-Team default when the deployment does not bind one.
 */
export function getTeamPolicy(env: TeamPolicyEnv): TeamPolicy {
  return env.TEAM_POLICY ?? SINGLE_TEAM_POLICY;
}

/**
 * Name of the user-directory Durable Object that holds `teamId`'s users. The single Team keeps
 * the original deployment-wide directory (""), so deployments without a policy see no change.
 */
export function userDirectoryName(teamId: string): string {
  return teamId === SINGLE_TEAM_ID ? "" : `team:${teamId}`;
}
