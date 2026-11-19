import { redirect } from "next/navigation";

/** Bookmarks: /factory is now the line view of /approvals (#162). */
export default function FactoryRedirect() {
  redirect("/approvals?view=factory");
}
