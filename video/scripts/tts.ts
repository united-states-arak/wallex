// Generates one voiceover clip per scene from narration.json and records durations.
// Usage: bun scripts/tts.ts [--force]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadEnv, VIDEO_DIR } from "./env";
import { probeDuration } from "./ff";

type Scene = { id: string; title: string; text: string };

// Pronunciation hints sent to the TTS engine only; the narration text itself is unchanged.
const PRONUNCIATION: Array<[string, string]> = [["آزادن که بدون", "آزادن که بِدَوَن"]];

const env = loadEnv();
const base = (env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
const model = env.TTS_MODEL ?? "gemini-3.8-flash-tts";
const voice = env.TTS_VOICE ?? "Kore";
const speed = env.TTS_SPEED ? Number(env.TTS_SPEED) : undefined;
if (!base || !env.OPENAI_API_KEY) throw new Error("OPENAI_BASE_URL / OPENAI_API_KEY missing in video/.env.local");

const scenes: Scene[] = JSON.parse(readFileSync(join(VIDEO_DIR, "narration.json"), "utf8"));
const audioDir = join(VIDEO_DIR, "audio");
mkdirSync(audioDir, { recursive: true });
const manifestPath = join(audioDir, "manifest.json");
const manifest: Record<string, { hash: string; duration: number; file: string }> = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : {};
const force = process.argv.includes("--force");

async function speak(input: string): Promise<Buffer> {
  let lastErr = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${base}/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model, input, voice, response_format: "mp3", ...(speed ? { speed } : {}) }),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.ok && buf.length > 1000) return buf;
      lastErr = `HTTP ${res.status}: ${buf.toString("utf8").slice(0, 300).replaceAll(env.OPENAI_API_KEY!, "[redacted]")}`;
    } catch (e) {
      lastErr = String(e);
    }
    console.warn(`  attempt ${attempt} failed: ${lastErr}`);
    await Bun.sleep(2000 * attempt);
  }
  throw new Error(lastErr);
}

async function one(s: Scene) {
  let input = s.text;
  for (const [from, to] of PRONUNCIATION) input = input.replaceAll(from, to);
  const hash = createHash("sha256").update(`${model}|${voice}|${speed ?? 1}|${input}`).digest("hex").slice(0, 16);
  const file = join(audioDir, `${s.id}.mp3`);
  if (!force && manifest[s.id]?.hash === hash && existsSync(file)) {
    console.log(`${s.id}: cached (${manifest[s.id].duration.toFixed(2)}s)`);
    return;
  }
  const buf = await speak(input);
  writeFileSync(file, buf);
  const duration = probeDuration(file);
  manifest[s.id] = { hash, duration, file: `${s.id}.mp3` };
  console.log(`${s.id}: ${duration.toFixed(2)}s`);
}

// Small concurrency to stay polite with the API.
const queue = [...scenes];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) await one(s);
  }),
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
const total = scenes.reduce((a, s) => a + manifest[s.id].duration, 0);
console.log(`voice=${voice} model=${model} total speech ${total.toFixed(1)}s`);
