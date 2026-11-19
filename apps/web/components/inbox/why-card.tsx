import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ApprovalWhy } from "@/lib/inbox";
import { GitBranch, ShieldQuestion } from "lucide-react";
import { getTranslations } from "next-intl/server";

export async function WhyCard({ why }: { why: ApprovalWhy | null }) {
  const t = await getTranslations("inbox");
  const hasEvidence = Boolean(
    why &&
      (why.producedBy.length > 0 ||
        why.consumedBy.length > 0 ||
        why.gates.length > 0),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldQuestion className="size-4 text-sky-400" />
          {t("whyTitle")}
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">{t("whyDesc")}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {why?.draftArtifactId ? (
          <p className="truncate font-mono text-[10px] text-zinc-500">
            {t("whyDraft")} {why.draftArtifactId}
          </p>
        ) : null}

        {!hasEvidence ? (
          <p className="text-xs text-muted-foreground">{t("whyNone")}</p>
        ) : null}

        {why && why.producedBy.length > 0 ? (
          <EvidenceGroup
            title={t("whyProduced")}
            refs={why.producedBy}
            unknown={t("whyNone")}
          />
        ) : null}

        {why && why.consumedBy.length > 0 ? (
          <EvidenceGroup
            title={t("whyConsumed")}
            refs={why.consumedBy}
            unknown={t("whyNone")}
          />
        ) : null}

        {why && why.gates.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">
              {t("whyGates")}
            </p>
            {why.gates.map((gate) => (
              <div
                key={gate.artifactId}
                className="rounded border border-border px-2 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      gate.pass === false
                        ? "danger"
                        : gate.pass === true
                          ? "success"
                          : "outline"
                    }
                    className="text-[9px]"
                  >
                    {gate.pass === true
                      ? t("gatePass")
                      : gate.pass === false
                        ? t("gateFail")
                        : t("gateNone")}
                  </Badge>
                  <span className="truncate font-mono text-[10px] text-zinc-500">
                    {gate.artifactId}
                  </span>
                </div>
                {gate.scores.length > 0 ? (
                  <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-zinc-400 sm:grid-cols-3">
                    {gate.scores.map((score) => (
                      <div
                        key={score.dimension}
                        className="flex justify-between gap-2"
                      >
                        <dt className="truncate">{score.dimension}</dt>
                        <dd className="font-mono text-zinc-300">
                          {score.value.toFixed(2)}
                          {score.threshold !== null
                            ? ` / ${score.threshold.toFixed(2)}`
                            : ""}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {gate.rationale ? (
                  <p className="mt-1 line-clamp-3 text-[10px] leading-4 text-zinc-500">
                    {gate.rationale}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <p className="flex items-center gap-1 text-[10px] text-zinc-600">
          <GitBranch className="size-3" />
          {t("whyBackfillHint")}
        </p>
      </CardContent>
    </Card>
  );
}

function EvidenceGroup({
  title,
  refs,
  unknown,
}: {
  title: string;
  refs: Array<{
    artifactId: string;
    version: number;
    stageId: string;
    relation: string;
  }>;
  unknown: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">
        {title}
      </p>
      <ul className="space-y-0.5">
        {refs.map((ref) => (
          <li
            key={`${ref.artifactId}:${ref.version}`}
            className="flex min-w-0 items-center gap-2 text-[10px]"
          >
            <span className="truncate font-mono text-zinc-400">
              {ref.artifactId} v{ref.version}
            </span>
            <span className="truncate text-zinc-600">
              {ref.stageId
                ? ref.stageId.split(":").slice(1).join(":") || ref.stageId
                : unknown}
            </span>
            <span className="ml-auto shrink-0 text-zinc-600">
              {ref.relation}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
