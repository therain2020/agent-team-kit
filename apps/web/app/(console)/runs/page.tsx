import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Runs merged into the world surface (issue #161). */
export default async function RunsRedirect() {
  redirect("/world?tab=runs");
}
