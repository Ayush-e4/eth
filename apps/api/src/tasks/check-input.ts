/**
 * A small check of a task's input against an agent's published JSON Schema (`required`, `type`,
 * `pattern`, `enum`, `minimum`/`maximum`), so a public task isn't posted with input no agent can
 * bid on. Agents validate fully on their side; this catches the common slips (an empty date).
 */
type Json = Record<string, unknown>;

const typeOk = (t: unknown, v: unknown) => {
  const types = Array.isArray(t) ? t : [t];
  return types.some(
    (x) =>
      (x === "string" && typeof v === "string") ||
      (x === "number" && typeof v === "number") ||
      (x === "integer" && Number.isInteger(v)) ||
      (x === "boolean" && typeof v === "boolean") ||
      (x === "null" && v === null) ||
      (x === "object" && v !== null && typeof v === "object" && !Array.isArray(v)) ||
      (x === "array" && Array.isArray(v)),
  );
};

export function inputProblems(schema: unknown, input: Json): string[] {
  const s = (schema ?? {}) as Json;
  const props = (s.properties ?? {}) as Record<string, Json>;
  const problems: string[] = [];
  for (const name of (s.required as string[] | undefined) ?? [])
    if (!(name in input)) problems.push(`${name} is missing`);
  for (const [name, p] of Object.entries(props)) {
    if (!(name in input)) continue;
    const v = input[name];
    if (p.type !== undefined && !typeOk(p.type, v)) problems.push(`${name} should be ${p.type}`);
    else if (
      typeof v === "string" &&
      typeof p.pattern === "string" &&
      !new RegExp(p.pattern).test(v)
    )
      problems.push(`${name} "${v}" doesn't match ${p.pattern}`);
    else if (Array.isArray(p.enum) && !p.enum.includes(v))
      problems.push(`${name} must be one of ${p.enum.join(", ")}`);
    else if (typeof v === "number" && typeof p.minimum === "number" && v < p.minimum)
      problems.push(`${name} is below ${p.minimum}`);
    else if (typeof v === "number" && typeof p.maximum === "number" && v > p.maximum)
      problems.push(`${name} is above ${p.maximum}`);
  }
  return problems;
}
