import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Iterations merged into the world surface (issue #161). */
export default async function IterationsRedirect() {
  redirect("/world?tab=iterations");
}
