import { redirect } from "next/navigation";

/**
 * Bookmarks: an approval detail is now the shared drawer of /approvals, and
 * the request id survives the redirect so the drawer opens on the same item.
 */
export default async function ApprovalRedirect({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  redirect(
    `/approvals?request=${encodeURIComponent(decodeURIComponent(requestId))}`,
  );
}
