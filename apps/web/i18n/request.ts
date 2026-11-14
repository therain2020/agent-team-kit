import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { type Locale, defaultLocale, isLocale } from "./config";

export default getRequestConfig(async () => {
  const store = await cookies();
  const requested = store.get("NEXT_LOCALE")?.value;
  const locale = isLocale(requested)
    ? requested
    : pickLocale((await headers()).get("accept-language"));

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});

function pickLocale(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) {
    return defaultLocale;
  }
  const preferred = acceptLanguage.split(",")[0]?.trim().toLowerCase() ?? "";
  return preferred.startsWith("zh") ? "zh" : defaultLocale;
}
