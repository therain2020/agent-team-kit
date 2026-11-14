import { listTemplates } from "@kit/pack";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ templates: await listTemplates() });
}
