// SkyHop as the market runs it: Duffel test mode, with booking management (its records in a
// gitignored file, like StayWise's).
import { fileURLToPath } from "node:url";
import { arkivReader } from "@eth/arkiv";
import { DuffelClient, DuffelOrders } from "@eth/travel";
import type { SpecialistIdentity } from "../src/identities";
import { skyhop } from "../src/specialists/skyhop";
import type { FlightRecord } from "../src/specialists/skyhop-manage";
import { JsonStore } from "../src/store";

const STORE = fileURLToPath(new URL("../.skyhop.local.json", import.meta.url));

export function skyhopAgent(identity: SpecialistIdentity) {
  const duffel = new DuffelClient(process.env.DUFFEL_ACCESS_TOKEN ?? "");
  const manage = {
    orders: new DuffelOrders(duffel),
    store: new JsonStore<FlightRecord>(STORE),
    arkiv: arkivReader(),
    me: identity.evm,
  };
  // Test mode: Duffel Airways bookings are the ones that can be changed (SKYHOP_AIRLINE= to drop).
  return skyhop(duffel, manage, process.env.SKYHOP_AIRLINE ?? "ZZ");
}
