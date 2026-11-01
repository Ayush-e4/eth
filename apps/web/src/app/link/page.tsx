import { LogoMark } from "@/components/icons";
import { LinkDevice } from "@/components/login/LinkDevice";

export default function LinkPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center gap-10 px-5 pt-[max(32px,env(safe-area-inset-top))] pb-10 sm:justify-center">
      <span className="flex items-center gap-2.5 self-center">
        <span className="flex size-[34px] items-center justify-center rounded-[10px] bg-teal text-white">
          <LogoMark size={20} />
        </span>
        <span className="text-xl font-bold">AgentNet</span>
      </span>
      <LinkDevice />
    </main>
  );
}
