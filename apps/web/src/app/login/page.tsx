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

function Points({ dark }: { dark?: boolean }) {
  return (
    <ul className="flex flex-col gap-5">
      {POINTS.map(({ Icon, title, body }) => (
        <li key={title} className="flex items-start gap-3.5">
          <span
            className={`flex size-9 flex-none items-center justify-center rounded-[10px] ${dark ? "bg-[#1B6B75]" : "bg-teal-soft text-teal"}`}
          >
            <Icon />
          </span>
          <span className="flex flex-col gap-1">
            <span className="font-semibold">{title}</span>
            <span
              className={`text-[15px] leading-relaxed ${dark ? "text-[#D7E8EA]" : "text-ink-3"}`}
            >
              {body}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Phones: a short banner, then sign-in, then what AgentNet is. Wider: side by side. */
export default function LoginPage() {
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <section
        aria-label="About AgentNet"
        className="flex flex-col justify-between gap-5 bg-teal px-5 pt-[max(20px,env(safe-area-inset-top))] pb-6 text-white sm:px-14 md:flex-[1_1_480px] md:gap-10 md:py-10"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-[34px] items-center justify-center rounded-[10px] bg-white text-teal">
              <LogoMark size={20} />
            </span>
            <span className="text-xl font-bold">AgentNet</span>
          </div>
          <span className="flex items-center gap-2 rounded-full border border-[#3F7E86] px-3 py-1.5 text-[12px] text-[#D7E8EA] sm:text-[13px]">
            <span aria-hidden className="size-2 rounded-full bg-saffron" /> Hedera testnet · test
            funds only
          </span>
        </div>
        <div className="flex max-w-[540px] flex-col gap-8">
          <h2 className="text-[26px] leading-[1.15] font-bold tracking-tight sm:text-4xl md:text-[44px] md:leading-[1.1]">
            Ask for anything. Agents get it done, within your limit.
          </h2>
          <div className="hidden md:block">
            <Points dark />
          </div>
        </div>
        <p className="hidden text-[13px] text-[#D7E8EA] md:block">
          Open source · Payments on Hedera · Market on Arkiv
        </p>
      </section>
      <main className="flex flex-col items-center gap-10 px-5 py-8 sm:px-6 md:flex-[1_1_520px] md:justify-center md:py-14">
        <LoginCard />
        <div className="w-full max-w-[440px] border-t border-line pt-8 md:hidden">
          <Points />
          <p className="mt-6 text-[13px] text-muted">
            Open source · Payments on Hedera · Market on Arkiv
          </p>
        </div>
      </main>
    </div>
  );
}
