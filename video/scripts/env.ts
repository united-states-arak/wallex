import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const VIDEO_DIR = join(import.meta.dir, "..");

export function loadEnv(): Record<string, string> {
  const file = join(VIDEO_DIR, ".env.local");
  const env: Record<string, string> = {};
  if (existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 0) continue;
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[line.slice(0, i).trim()] = v;
    }
  }
  for (const k of ["OPENAI_BASE_URL", "OPENAI_API_KEY", "TTS_MODEL", "TTS_VOICE", "TTS_SPEED"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}
