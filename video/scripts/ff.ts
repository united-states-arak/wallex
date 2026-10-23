import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";

export const FFMPEG = ffmpegPath as unknown as string;
export const FFPROBE = ffprobe.path;

export function run(bin: string, args: string[]) {
  const r = spawnSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(" ")}\n${r.stderr?.toString().slice(-2000)}`);
  return r.stdout.toString();
}

export function probeDuration(file: string): number {
  return Number(run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]).trim());
}
