# StarCoach demo video

Persian-narrated demo (11 HTML scenes rendered in headless Chrome, voiceover from `audio/`).

```sh
cd video
bun install
bun run render            # renders every scene, muxes audio -> out/starcoach-demo.mp4
```

Options: `bun scripts/render.ts --fps 30 --jobs 4 --only s03,s08` or `--stills` for quick layout PNGs in `out/`.
Scene segments are written to `frames/` and can be deleted after the export.

The voiceover already lives in `audio/` (`audio/manifest.json` holds clip durations). Run `bun run tts`
only when `narration.json` changes. It calls the TTS API using keys from `.env.local`.
Chrome is expected at `/Applications/Google Chrome.app` (override with `CHROME_PATH`).
