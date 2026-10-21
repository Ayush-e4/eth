/** A traveller as both flight providers need them (sandbox: generated fake people only). */
export interface Traveller {
  title: "mr" | "ms" | "mrs";
  givenName: string;
  familyName: string;
  gender: "m" | "f";
  bornOn: string; // YYYY-MM-DD
  nationality: string; // ISO 3166-1 alpha-2, e.g. IN
  email: string;
  phoneCountryCode: string; // e.g. 91
  phone: string; // national number, e.g. 9876543210
}
