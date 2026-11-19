import { LEGACY_OPS_REDIRECTS, opsSectionHref } from "@/lib/ops-sections";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function AutopilotRedirect() {
  redirect(opsSectionHref(LEGACY_OPS_REDIRECTS["/autopilot"]));
}
