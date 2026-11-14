import { BootstrapForm } from "@/components/welcome/bootstrap-form";
import { PreflightPanel } from "@/components/welcome/preflight-panel";
import {
  collectPreflight,
  hasApiKey,
  readBootstrapProfileSync,
} from "@kit/bootstrap";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  const t = await getTranslations("welcome");
  const profile = readBootstrapProfileSync();
  const configured = hasApiKey();
  const report = await collectPreflight({
    probe: configured,
    probeTimeoutMs: 5000,
    includeToolchain: false,
  });

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <header className="space-y-2">
        <span className="inline-flex items-center rounded border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          agent team kit · 0.9.0
        </span>
        <h1 className="text-xl font-semibold text-zinc-100">{t("title")}</h1>
        <p className="text-[12px] leading-relaxed text-zinc-400">
          {t("description")}
        </p>
      </header>

      <BootstrapForm
        initial={{
          configured,
          baseUrl: profile?.baseUrl ?? "https://api.deepseek.com",
          flash: profile?.models.flash ?? "deepseek-flash",
          pro: profile?.models.pro ?? "deepseek-v4-pro",
        }}
      />

      <PreflightPanel report={report} />

      <p className="text-center text-[10px] text-zinc-600">
        {t("securityNote")}
      </p>
    </div>
  );
}
