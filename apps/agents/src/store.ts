import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * A tiny key→value store an agent keeps for itself (its own "database"), saved as JSON so it
 * survives restarts. Local and gitignored (`*.local.json`); Postgres replaces it later.
 * Without a path it lives in memory only (tests).
 */
export class JsonStore<T> {
  private data: Record<string, T>;

  constructor(private readonly path?: string) {
    this.data =
      path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, T>) : {};
  }

  get(key: string): T | undefined {
    return this.data[key];
  }

  set(key: string, value: T): void {
    this.data[key] = value;
    if (this.path)
      writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
  }

  values(): T[] {
    return Object.values(this.data);
  }
}
