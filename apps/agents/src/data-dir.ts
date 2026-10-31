import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where an agent keeps a local file (its keys, its job records, what it booked): next to the
 * code while developing (apps/agents/.<name>, gitignored), or in AGENT_DATA_DIR on a server, so
 * a persistent volume keeps them across deploys.
 */
export function dataFile(name: string): string {
  const dir = process.env.AGENT_DATA_DIR;
  return dir ? join(dir, name) : fileURLToPath(new URL(`../${name}`, import.meta.url));
}
