import { describe, expect, it } from "vitest";
import { AGENT_REGISTRY, dataUri, ERC8004, registrationFile } from "./erc8004";

const agent = {
  name: "AirNest",
  description: "Books the cheapest fare.",
  endpoint: "http://localhost:8413",
  arkivProfile: "https://rabdi.explorer.arkiv.network/entity/0xabc",
  hederaAccount: "0.0.11116757",
};

describe("ERC-8004 registration file", () => {
  it("follows registration-v1 and links the Arkiv profile and Hedera account", () => {
    const f = registrationFile({ ...agent, agentId: 131n });
    expect(f.type).toBe("https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    expect(f.services).toEqual([
      { name: "web", endpoint: agent.endpoint },
      { name: "arkiv", endpoint: agent.arkivProfile },
      { name: "hedera", endpoint: "hedera:testnet:0.0.11116757" },
    ]);
    expect(f.registrations).toEqual([{ agentId: 131, agentRegistry: AGENT_REGISTRY }]);
    expect(AGENT_REGISTRY).toBe(`eip155:296:${ERC8004.identity}`);
    expect(f).toMatchObject({ x402Support: true, active: true, supportedTrust: ["reputation"] });
  });

  it("names no registration before the agent has an id, and fits in a data: URI", () => {
    expect(registrationFile(agent).registrations).toEqual([]);
    const uri = dataUri(registrationFile(agent));
    expect(uri.startsWith("data:application/json;base64,")).toBe(true);
    expect(JSON.parse(Buffer.from(uri.split(",")[1] ?? "", "base64").toString()).name).toBe(
      "AirNest",
    );
  });
});
