/**
 * Build every bridge to a self-contained CJS bundle Comical can load. Output uses the transient
 * `.build/<id>/dist/bridge.js` layout (gitignored) so `comical registry publish --bridges-dir
 * ./.build` discovers them; the published index.json + served bundles land at the repo root.
 *
 * `src/core/` is shared code, not a bridge: each bundle inlines what it imports from there.
 * @comical/* is resolved via tsconfig paths (local link to ../comical for now).
 */
import { join } from "node:path";

const ROOT = import.meta.dir;

// Some on-device engines (JSC on iOS, QuickJS on Android) define no global `console`, so a stray
// `console.log` would throw a ReferenceError there. Install a no-op one only when it is missing.
const CONSOLE_SHIM =
  "if(typeof console==='undefined'){var __noop=function(){};" +
  "globalThis.console={log:__noop,info:__noop,warn:__noop,error:__noop,debug:__noop,trace:__noop};}";

const bridges: Array<{ id: string; src: string }> = [{ id: "opds", src: "opds.ts" }];

for (const { id, src } of bridges) {
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src", src)],
    outdir: join(ROOT, ".build", id, "dist"),
    target: "browser",
    format: "cjs",
    naming: "bridge.js",
    minify: false,
    sourcemap: "external",
    banner: CONSOLE_SHIM,
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new AggregateError(result.logs, `${id} bridge build failed`);
  }
  console.log(`✓ built → .build/${id}/dist/bridge.js`);
}
