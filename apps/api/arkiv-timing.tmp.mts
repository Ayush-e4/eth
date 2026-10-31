import { arkivReader, findListings, liveQuotes, liveTasks, openTasks } from "@eth/arkiv";

const r = arkivReader();
const t = async (name: string, f: () => Promise<unknown>) => {
  const s = Date.now();
  try {
    const v = await f();
    console.log(name, Date.now() - s, "ms", Array.isArray(v) ? v.length : "");
  } catch (e) {
    console.log(name, "FAILED", Date.now() - s, "ms", String(e).slice(0, 200));
  }
};
await t("blockNumber", () => r.getBlockNumber());
await t("liveTasks", () => liveTasks(r));
await t("openTasks flights", () => openTasks(r, { skill: "flights" }));
await t("listings flights", () => findListings(r, { skill: "flights" }));
await t("liveQuotes", () => liveQuotes(r, "open-9f210444-mvw719hm"));
