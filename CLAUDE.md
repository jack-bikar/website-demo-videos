# Website Demo Videos — Multi-Mode Website→Video Studio

Turns a website URL into a polished MP4. Modes: Walkthrough (browser recording), Screenshot-Based (Ken Burns scenes), Marketing Shorts (9:16). Engine-first pnpm monorepo; single-user for now, architected to grow into SaaS.

## Layout
- `packages/schema` — Zod models (plan, moments, clips, keyframes, storyboard, scenes, jobs). Deps: zod only.
- `packages/timeline` — pure functions (trim, keyframes, clip layout, caption timing, Ken Burns math). Only built package (tsup CJS+ESM). Tests live here.
- `packages/capture` — puppeteer-core + steel-sdk recorder, screenshots, page extraction. Node-only.
- `packages/compositions` — ALL Remotion compositions, source-exported (no build). Owns the registerRoot entry.
- `packages/render` — ffmpeg fast path + programmatic Remotion render.
- `packages/providers` — ScriptProvider/TtsProvider/MusicProvider interfaces + stubs (no AI vendors wired yet).
- `packages/engine` — mode orchestration (capture→storyboard→props→render), transport-agnostic.
- `packages/db` — Drizzle + better-sqlite3. UUIDs + JSON columns (Postgres-portable).
- `packages/cli` — bins behind the root npm scripts.
- `apps/studio` — Next.js studio (job runner singleton, SSE, Range streaming, @remotion/player).
- `scripts/` + `remotion/` — LEGACY pipeline, being migrated; keep `npm run record/trim/keyframes/render/demo` and `scripts/browse-plan.json` working (the screen-demo skill depends on them).

## Rules
- Remotion packages are exact-pinned (4.0.469) and enforced via `pnpm.overrides` — never add a caret or a second version.
- Web requests never run captures or renders; heavy work goes through jobs (child processes).
- Trim/keyframe constants (lead 500 / tail 1000 / merge 2000 / gap 3000 ms, zoom 1.3) are the product's look — don't "fix" them.
- Strict TypeScript everywhere new; no `any`.
- ffmpeg/ffprobe must be on PATH; Chrome via puppeteer-core (never bundled puppeteer).

## Reference code policy
Read-only reference clones live in `~/Workspace/references/` (NOT in this repo, never runtime deps — Remotion npm packages are the only exception).

- **Tier A — may adapt code, with attribution:** webreel (Apache-2.0), pagecast (MIT), snapcrawl (MIT), sample-video-demo-generator-system (MIT-0), short-video-maker (MIT), a-react-video-editor (MIT), next-supabase-stripe-starter (MIT), claude-code-video-toolkit (MIT), hyperframes (Apache-2.0).
  Every adapted file gets a header `// Adapted from <repo>@<sha> (<license>)` plus a row in `LICENSES/THIRD-PARTY.md`.
- **Tier B — patterns only, NEVER copy code:** remotion source, openshorts, react-video-editor (designcombo), remotion-templates, template-prompt-to-video, vidosy.

When first consulting a reference repo, write `docs/references/<repo>.md` (≤1 page: data model, files worth reading, adapt-vs-imitate, license).

Remotion license note: free while the company is ≤3 people; a Company License is required if this becomes a commercial SaaS.
