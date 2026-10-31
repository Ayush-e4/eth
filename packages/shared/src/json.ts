/** JSON for jsonb columns that keeps bigints (fees are bigints): stored as {"$bigint":"123"}. */
export const encodeJson = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $bigint: x.toString() } : x)));

export const decodeJson = <T>(v: unknown): T =>
  JSON.parse(JSON.stringify(v), (_k, x) =>
    x && typeof x === "object" && Object.keys(x).length === 1 && typeof x.$bigint === "string"
      ? BigInt(x.$bigint)
      : x,
  ) as T;
