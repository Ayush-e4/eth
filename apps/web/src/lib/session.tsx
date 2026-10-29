"use client";

import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { ApiError, api, type ChatSummary, type Me } from "./api";

interface Session {
  me: Me | null;
  chats: ChatSummary[];
  refreshChats: () => Promise<void>;
  setMe: (me: Me) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

/**
 * Loads the signed-in user and their chats once for the whole app. A 401 means the cookie is
 * gone or expired, so we go to /login (the API is the real gatekeeper, not this).
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);

  const refreshChats = useCallback(async () => {
    setChats((await api<{ chats: ChatSummary[] }>("/chats")).chats);
  }, []);

  useEffect(() => {
    let live = true;
    api<{ user: Me }>("/me")
      .then(({ user }) => {
        if (!live) return;
        setMe(user);
        if (!user.onboarded && window.location.pathname !== "/welcome") router.replace("/welcome");
        return refreshChats();
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
      });
    return () => {
      live = false;
    };
  }, [router, refreshChats]);

  const signOut = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
  }, [router]);

  return (
    <SessionContext.Provider value={{ me, chats, refreshChats, setMe, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession must be used inside SessionProvider");
  return s;
}
