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
      className="m-0 flex min-w-0 items-center rounded-md border border-border p-0.5"
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
            "rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-50",
            locale === item && "bg-zinc-800 text-zinc-100",
          )}
        >
          {t(item)}
        </button>
      ))}
    </fieldset>
  );
}
