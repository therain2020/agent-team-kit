import { redirect } from "next/navigation";

/** Bookmarks: /inbox is now the queue view of /approvals (#162). */
export default function InboxRedirect() {
  redirect("/approvals");
}
