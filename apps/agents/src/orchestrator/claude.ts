import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

/**
 * One structured Claude call: system + user text in, a validated object out.
 * - Claude Haiku only (project rule: cheap and fast); thinking is adaptive, effort sets depth
 *   ("low" suits extraction). Haiku has no server-side refusal fallback.
 * - typed result via structured outputs; refusals surface as errors, never as data
 */
export const MODEL = "claude-haiku-5-5";

let client: Anthropic | undefined;
export function anthropic() {
  client ??= new Anthropic();
  return client;
}

export async function askStructured<T extends z.ZodType>(opts: {
  schema: T;
  system: string;
  user: string;
  effort?: "low" | "medium" | "high";
}): Promise<z.infer<T>> {
  const response = await anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    output_config: { effort: opts.effort ?? "low", format: betaZodOutputFormat(opts.schema) },
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined: ${response.stop_details?.explanation ?? "refusal"}`);
  }
  if (response.stop_reason === "max_tokens") throw new Error("Claude ran out of output tokens");
  if (response.parsed_output == null) throw new Error("Claude returned no parseable output");
  return response.parsed_output as z.infer<T>;
}
