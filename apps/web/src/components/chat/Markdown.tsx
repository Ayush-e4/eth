import type { ReactNode } from "react";

/** Positions as stable ids: a finished message's blocks and parts never reorder. */
const withIds = <T,>(items: T[], prefix: string) =>
  items.map((value, n) => ({ id: `${prefix}${n}`, value }));

/**
 * The little Markdown the concierge writes: paragraphs, "-" or "1." lists, **bold** and
 * `code`. Built as React elements (never raw HTML), so model text can't inject markup.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-3 text-[15px] leading-relaxed">
      {withIds(text.trim().split(/\n{2,}/), "b").map(({ id, value: block }) => {
        const lines = block.split("\n");
        const bullet = lines.every((l) => /^\s*[-*]\s+/.test(l));
        const numbered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
        if (!bullet && !numbered) {
          return (
            <p key={id} className="whitespace-pre-wrap">
              {inline(block)}
            </p>
          );
        }
        const List = numbered ? "ol" : "ul";
        const items = lines.map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""));
        return (
          <List
            key={id}
            className={`flex flex-col gap-1 pl-5 ${numbered ? "list-decimal" : "list-disc"}`}
          >
            {withIds(items, `${id}i`).map((item) => (
              <li key={item.id}>{inline(item.value)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

/** **bold** and `code` inside a line. */
export function inline(text: string): ReactNode[] {
  return withIds(text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g), "p").map(({ id, value: part }) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={id}>{part.slice(2, -2)}</strong>;
    }
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={id} className="rounded bg-side px-1 font-mono text-[13px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}
