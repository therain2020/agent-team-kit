/**
 * Office view switch (97 §3.1): the floor is the default, `?view=list` (and
 * any unknown value) demotes to the list so a deep link never breaks.
 */
export type OfficeView = "floor" | "list";

export const OFFICE_VIEWS: readonly OfficeView[] = ["floor", "list"];

export function parseOfficeView(
  value: string | string[] | null | undefined,
): OfficeView {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "list" ? "list" : "floor";
}
