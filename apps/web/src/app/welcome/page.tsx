import { Setup } from "@/components/setup/Setup";
import { SessionProvider } from "@/lib/session";

export default function WelcomePage() {
  return (
    <SessionProvider>
      <Setup />
    </SessionProvider>
  );
}
