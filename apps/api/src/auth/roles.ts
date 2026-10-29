import type { User } from "../db/schema";

export type Role = "user" | "builder" | "admin";

/**
 * Roles come from the server, never the client: admins are an allowlist in the server's
 * settings. Builders (people who own an agent) are added when agents are stored in the
 * database; until then everyone else is a plain user.
 */
export function rolesFor(user: User, admins: ReadonlySet<string>): Role[] {
  const roles: Role[] = ["user"];
  if (user.address && admins.has(user.address)) roles.push("admin");
  return roles;
}
