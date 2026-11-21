import { sameOriginError } from "@/lib/http";
import {
  loadInformationView,
  parseSaveProfileBody,
  saveProfile,
} from "@/lib/information";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/information` → current profile, versions and audit trail. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId") || "default";
  try {
    const view = await loadInformationView(workspaceId);
    return NextResponse.json(
      {
        workspaceId: view.workspaceId,
        profile: view.profile,
        persisted: view.persisted,
        versions: view.versions,
        audit: view.audit,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "failed to load interest profile",
      },
      { status: 500 },
    );
  }
}

/** `PUT /api/information` → append a new profile version plus audit. */
export async function PUT(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const input = parseSaveProfileBody(body);
    const profile = await saveProfile(input);
    return NextResponse.json({ ok: true, profile }, { status: 201 });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const status = code === "interest_profile_version_conflict" ? 409 : 400;
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "failed to save profile",
      },
      { status },
    );
  }
}
