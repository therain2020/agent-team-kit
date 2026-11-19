"use client";

import { setLocale } from "@/app/actions/locale";
import { type Locale, locales } from "@/i18n/config";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations("locale");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function change(next: Locale) {
    if (next === locale) {
      return;
    }
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  }

  return (
    <fieldset
      className="m-0 flex min-w-0 items-center rounded-none border border-px-line2 bg-px-ink p-0.5"
      aria-label={t("label")}
    >
      {locales.map((item) => (
        <button
          key={item}
          type="button"
          disabled={pending}
          aria-pressed={locale === item}
          onClick={() => change(item)}
          className={cn(
            "rounded-none px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-[0.1em] text-px-muted uppercase transition-colors hover:text-px-text disabled:opacity-50",
            locale === item && "bg-px-accent text-px-accent-ink",
          )}
        >
          {t(item)}
        </button>
      ))}
    </fieldset>
  );
}
