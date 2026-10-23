// Probe the TTS endpoint without printing secrets.
// Usage: bun scripts/probe-tts.ts <voice> [sceneIndex] [speed]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, VIDEO_DIR } from "./env";
import { probeDuration } from "./ff";

const env = loadEnv();
const base = (env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
const voice = process.argv[2] ?? "alloy";
const idx = Number(process.argv[3] ?? -1);
const speed = process.argv[4] ? Number(process.argv[4]) : undefined;
const input =
  idx >= 0 ? JSON.parse(readFileSync(join(VIDEO_DIR, "narration.json"), "utf8"))[idx].text : "سلام. این یک آزمایش است.";
const res = await fetch(base + "/audio/speech", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
  body: JSON.stringify({ model: env.TTS_MODEL, input, voice, response_format: "mp3", ...(speed ? { speed } : {}) }),
});
const ct = res.headers.get("content-type");
const buf = Buffer.from(await res.arrayBuffer());
if (ct?.includes("audio") || ct?.includes("octet")) {
  const out = `/private/var/folders/nl/1wn69r892dn5sfrny5s5j48r0000gn/T/opencode/probe-${voice}-${idx}-${speed ?? 1}.mp3`;
  await Bun.write(out, buf);
  console.log(voice, idx, speed ?? 1, "status", res.status, "duration", probeDuration(out).toFixed(2));
} else {
  console.log("status", res.status, buf.toString("utf8").slice(0, 800).replaceAll(env.OPENAI_API_KEY ?? "\u0000", "[redacted]"));
}
