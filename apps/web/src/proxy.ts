import { type NextRequest, NextResponse } from "next/server";

/**
 * Optimistic check only: no session cookie → straight to /login. The API still checks every
 * request properly; this just avoids flashing an empty app at signed-out visitors.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.has("eth_session")) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/chat/:path*", "/tasks", "/wallet", "/log", "/board", "/welcome", "/market/:path*"],
};
