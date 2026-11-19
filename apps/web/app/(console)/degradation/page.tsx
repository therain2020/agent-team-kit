import { LEGACY_OPS_REDIRECTS, opsSectionHref } from "@/lib/ops-sections";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function DegradationRedirect() {
  redirect(opsSectionHref(LEGACY_OPS_REDIRECTS["/degradation"]));
}
