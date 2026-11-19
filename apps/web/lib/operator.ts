export const DEFAULT_OPERATOR_ID = "operator:web";

/**
 * The console is local-first and has no session layer yet; one deployment is
 * operated by one person. KIT_OPERATOR_ID lets a self-hosted install name that
 * person so takeover badges and audit rows stay attributable.
 */
export function currentOperatorId(): string {
  return process.env.KIT_OPERATOR_ID?.trim() || DEFAULT_OPERATOR_ID;
}
