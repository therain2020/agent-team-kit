export function sameOriginError(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) {
    return null;
  }
  const host = request.headers.get("host");
  try {
    const parsed = new URL(origin);
    if (!host || parsed.host !== host) {
      return "origin mismatch";
    }
  } catch {
    return "invalid origin";
  }
  return null;
}

export function tokenError(request: Request): string | null {
  const expected = process.env.KIT_UI_TOKEN;
  if (!expected) {
    return null;
  }
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("kit_token="))
    ?.slice("kit_token=".length);
  const provided = bearer ?? cookie;
  return provided === expected ? null : "unauthorized";
}
