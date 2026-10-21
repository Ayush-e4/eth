import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

/**
 * One structured Claude call: system + user text in, a validated object out.
 * - claude-opus-5-5 (thinking is always on; effort controls depth — "low" suits extraction)
 * - server-side refusal fallbacks ("default" routes by refusal category)
 * - typed result via structured outputs; refusals surface as errors, never as data
 */
const MODEL = "claude-opus-5-5";

let client: Anthropic | undefined;
function anthropic() {
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
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
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
