/**
 * Publish this repo as a single Comical registry, served from the repo root via raw.githubusercontent
 * (`index.json` + `bridges/**`).
 *
 * The signing key is this registry's identity: clients pin it when the registry is added, so losing
 * it means every user has to re-add the registry. CI reads it from the COMICAL_REGISTRY_KEY secret.
 *
 *   [COMICAL_BASE_URL=https://raw.githubusercontent.com/porksphere/comical-opds-bridges/main] \
 *     [COMICAL_KEY=registry.key.json] bun run publish:registry
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const cli = join(ROOT, "..", "comical", "packages", "cli", "src", "index.ts");
const baseUrl =
  process.env.COMICAL_BASE_URL ??
  "https://raw.githubusercontent.com/porksphere/comical-opds-bridges/main";

const args = [
  "run", cli, "registry", "publish",
  "--bridges-dir", join(ROOT, ".build"),
  "--base-url", baseUrl,
  "--out", ROOT,
  "--display-name", "Comical self-hosted servers",
];
if (process.env.COMICAL_KEY) args.push("--key", process.env.COMICAL_KEY);

const proc = Bun.spawn(["bun", ...args], { stdout: "inherit", stderr: "inherit" });
const code = await proc.exited;
if (code !== 0) process.exit(code);

// The CLI emits bridges in filesystem-discovery order, which differs between machines and would
// reshuffle index.json on every publish. Sort by id so republishing identical bundles changes only
// the `updated` timestamp (which CI ignores), keeping the CLI's exact serialization.
const indexPath = join(ROOT, "index.json");
const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
  bridges?: { id: string }[];
  trackers?: { id: string }[];
};
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
index.bridges?.sort(byId);
index.trackers?.sort(byId);
writeFileSync(indexPath, JSON.stringify(index, null, 2));

process.exit(0);
