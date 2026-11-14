import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { bootstrapProfilePath } from "./paths";

export const bootstrapProfileSchema = z.object({
  apiVersion: z.literal("agentteam/v1").default("agentteam/v1"),
  mode: z.enum(["local", "scale"]).default("local"),
  baseUrl: z.string().url(),
  models: z.object({
    flash: z.string().min(1),
    pro: z.string().min(1),
  }),
  workspaceId: z.string().min(1).default("default"),
  createdAt: z.string(),
});

export type BootstrapProfile = z.infer<typeof bootstrapProfileSchema>;

export function readBootstrapProfileSync(
  env: Record<string, string | undefined> = process.env,
): BootstrapProfile | null {
  const file = bootstrapProfilePath(env);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = bootstrapProfileSchema.safeParse(
      JSON.parse(readFileSync(file, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeBootstrapProfile(
  profile: BootstrapProfile,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const file = bootstrapProfilePath(env);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(profile, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return file;
}

export function loadModelDefaults(
  env: Record<string, string | undefined> = process.env,
): { baseUrl?: string; flash?: string; pro?: string } {
  const profile = readBootstrapProfileSync(env);
  return {
    baseUrl: profile?.baseUrl,
    flash: profile?.models.flash,
    pro: profile?.models.pro,
  };
}
