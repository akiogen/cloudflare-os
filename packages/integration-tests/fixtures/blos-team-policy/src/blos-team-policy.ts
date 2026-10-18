// Test double for the TEAM_POLICY binding (see workshop-shared/src/team-policy.ts).
//
// The Team is read from the username so tests need no setup: `ta…` is Team A, `tb…` is Team
// B, and anything else is the default Team. Pair it with nextUsernames("taowner", "tbguest").
// `POST /assign?user=<id>&team=<team>` overrides one user's Team, to simulate a move.
// `GET /created?user=<id>` counts onUserCreated calls, and `POST /fail?user=<id>` makes the next
// onUserCreated for that user throw once.
//
// BLOS ADR-0012: `POST /admin?user=<id>` makes a user an administrator of their Team and
// `POST /depart?user=<id>` marks a user as departed. teamRole grants `build` to an administrator
// of the owner's Team; allowSignIn refuses departed users; teamMembers lists, for an
// administrator, every user created in their Team, departed users included.
//
// authorizeResource follows ADR-0009 with the Team ID as the mailbox handle: an email mailbox
// name must be `<team>` or `<team>-<anything>`. Every other resource is allowed.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { ResourceAuthorization, TeamPolicy } from "@gadgets/workshop-shared/team-policy";

// The Worker's own TeamOverrides class, reached through ctx.exports (no durable_objects binding).
type Exports = { TeamOverrides: DurableObjectNamespace<TeamOverrides> };
type Env = Record<string, never>;

// Module exports of a Worker must be handlers, so these stay module-private.
const TEAM_A = "team-a";
const TEAM_B = "team-b";
const DEFAULT_TEAM = "default";

function teamForUsername(userId: string): string {
  if (userId.startsWith("ta")) return TEAM_A;
  if (userId.startsWith("tb")) return TEAM_B;
  return DEFAULT_TEAM;
}

/** One instance holds every override and counter; tests are few and small. */
export class TeamOverrides extends DurableObject<Env> {
  assign(userId: string, team: string): void {
    this.ctx.storage.kv.put(`team:${userId}`, team);
  }

  get(userId: string): string | undefined {
    return this.ctx.storage.kv.get<string>(`team:${userId}`);
  }

  failNext(userId: string): void {
    this.ctx.storage.kv.put(`fail:${userId}`, true);
  }

  /** Records one onUserCreated call; throws (without counting) when a failure was requested. */
  userCreated(userId: string): void {
    if (this.ctx.storage.kv.get<boolean>(`fail:${userId}`)) {
      this.ctx.storage.kv.delete(`fail:${userId}`);
      throw new Error(`Team policy failure requested for ${userId}`);
    }
    this.ctx.storage.kv.put(`created:${userId}`, this.createdCount(userId) + 1);
  }

  createdCount(userId: string): number {
    return this.ctx.storage.kv.get<number>(`created:${userId}`) ?? 0;
  }

  createdUsers(): string[] {
    return [...this.ctx.storage.kv.list<number>({ prefix: "created:" })]
        .map(([key]) => key.slice("created:".length));
  }

  setFlag(flag: "admin" | "departed", userId: string): void {
    this.ctx.storage.kv.put(`${flag}:${userId}`, true);
  }

  hasFlag(flag: "admin" | "departed", userId: string): boolean {
    return this.ctx.storage.kv.get<boolean>(`${flag}:${userId}`) ?? false;
  }
}

export default class BlosTeamPolicy extends WorkerEntrypoint<Env> implements TeamPolicy {
  #overrides(): DurableObjectStub<TeamOverrides> {
    return (this.ctx.exports as unknown as Exports).TeamOverrides.getByName("");
  }

  async teamOf(userId: string): Promise<string> {
    return (await this.#overrides().get(userId)) ?? teamForUsername(userId);
  }

  async sameTeam(a: string, b: string): Promise<boolean> {
    const [teamA, teamB] = await Promise.all([this.teamOf(a), this.teamOf(b)]);
    return teamA === teamB;
  }

  async onUserCreated(userId: string): Promise<void> {
    await this.#overrides().userCreated(userId);
  }

  async teamRole(ownerId: string, userId: string): Promise<"build" | "use" | null> {
    if (!(await this.#overrides().hasFlag("admin", userId))) return null;
    return (await this.sameTeam(ownerId, userId)) ? "build" : null;
  }

  async allowSignIn(userId: string): Promise<boolean> {
    return !(await this.#overrides().hasFlag("departed", userId));
  }

  async teamMembers(userId: string): Promise<string[] | null> {
    if (!(await this.#overrides().hasFlag("admin", userId))) return null;
    const team = await this.teamOf(userId);
    const users = await this.#overrides().createdUsers();
    const teams = await Promise.all(users.map(u => this.teamOf(u)));
    return users.filter((_, i) => teams[i] === team);
  }

  async authorizeResource(userId: string, vendorId: string, resourceUrl: string)
      : Promise<ResourceAuthorization> {
    if (vendorId.toLowerCase() !== "email") return { allowed: true };
    const handle = await this.teamOf(userId);
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
    if (url.pathname === "/team-of" && request.method === "GET") {
      return Response.json({ team: await this.teamOf(user) });
    }
    if (url.pathname === "/created" && request.method === "GET") {
      return Response.json({ count: await this.#overrides().createdCount(user) });
    }
    if (url.pathname === "/fail" && request.method === "POST") {
      await this.#overrides().failNext(user);
      return new Response(null, { status: 204 });
    }
    if ((url.pathname === "/admin" || url.pathname === "/depart") && request.method === "POST") {
      await this.#overrides().setFlag(url.pathname === "/admin" ? "admin" : "departed", user);
      return new Response(null, { status: 204 });
    }
    const team = url.searchParams.get("team");
    if (url.pathname === "/assign" && request.method === "POST" && team !== null) {
      await this.#overrides().assign(user, team);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }
}
