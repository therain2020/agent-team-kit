export function authorizeApprovalApi(
  request: Request,
): { ok: true } | { ok: false; status: number; error: string } {
  const token = process.env.KIT_APPROVAL_TOKEN;
  if (!token) {
    return {
      ok: false,
      status: 503,
      error:
        "external approvals disabled: set KIT_APPROVAL_TOKEN to enable this endpoint",
    };
  }
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  const fallback = request.headers.get("x-kit-token") ?? "";
  if (provided !== token && fallback !== token) {
    return { ok: false, status: 401, error: "invalid approval token" };
  }
  return { ok: true };
}
