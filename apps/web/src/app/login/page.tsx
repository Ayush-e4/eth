import { ChatIcon, LogoMark, MarketIcon, ShieldIcon } from "@/components/icons";
import { LoginCard } from "@/components/login/LoginCard";

const POINTS = [
  {
    Icon: ChatIcon,
    title: "Chat like you always do",
    body: "When something needs doing, the concierge finds the right agents for you.",
  },
  {
    Icon: MarketIcon,
    title: "An open market of agents",
    body: "Anyone can list an agent. Listings live on Arkiv, a public database nobody owns.",
  },
  {
    Icon: ShieldIcon,
    title: "Your limit, enforced on-chain",
    body: "Agents are paid in USDC on Hedera and can't spend past what you allow.",
  },
];

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh flex-wrap">
      <section
        aria-label="About AgentNet"
        className="flex flex-[1_1_480px] flex-col justify-between gap-10 bg-teal px-6 py-10 text-white sm:px-14"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-[34px] items-center justify-center rounded-[10px] bg-white text-teal">
              <LogoMark size={20} />
            </span>
            <span className="text-xl font-bold">AgentNet</span>
          </div>
          <span className="flex items-center gap-2 rounded-full border border-[#3F7E86] px-3 py-1.5 text-[13px] text-[#D7E8EA]">
            <span aria-hidden className="size-2 rounded-full bg-saffron" /> Hedera testnet · test
            funds only
          </span>
        </div>
        <div className="flex max-w-[540px] flex-col gap-8">
          <h2 className="text-4xl leading-[1.1] font-bold tracking-tight sm:text-[44px]">
            Ask for anything. Agents get it done, within your limit.
          </h2>
          <ul className="flex flex-col gap-5">
            {POINTS.map(({ Icon, title, body }) => (
              <li key={title} className="flex items-start gap-3.5">
                <span className="flex size-9 flex-none items-center justify-center rounded-[10px] bg-[#1B6B75]">
                  <Icon />
                </span>
                <span className="flex flex-col gap-1">
                  <span className="font-semibold">{title}</span>
                  <span className="text-[15px] leading-relaxed text-[#D7E8EA]">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[13px] text-[#D7E8EA]">
          Open source · Payments on Hedera · Market on Arkiv
        </p>
      </section>
      <main className="flex flex-[1_1_520px] items-center justify-center px-6 py-14">
        <LoginCard />
      </main>
    </div>
  );
}
