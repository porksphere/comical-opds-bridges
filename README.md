# Comical self-hosted bridges

Official [Comical](https://github.com/porksphere/comical-app) bridges for servers you run yourself.

| Bridge | Talks to | Status |
|---|---|---|
| **OPDS** (`porksphere.opds`) | Any OPDS 1.x catalog that streams pages with OPDS-PSE: Komga, Kavita, Codex, Stump, Ubooquity… | Available |
| Komga | Komga's REST API (reading progress syncs back) | Planned |
| Kavita | Kavita's REST API | Planned |
| Suwayomi | Suwayomi's GraphQL API | Planned |
| LANraragi | LANraragi's API | Planned |

## Add the registry

In Comical: **Settings → Registries → Add**, and paste:

```
https://raw.githubusercontent.com/porksphere/comical-opds-bridges/main/index.json
```

Then install a bridge and fill in its settings: the server's address and, if it needs one, a
username and password. **Test connection** in the bridge's settings checks both.

### OPDS

- **Catalog URL** is the catalog's own address, as the server's settings show it. Komga's is
  `http://<server>:25600/opds/v1.2/catalog`.
- Books open only on servers that stream pages (OPDS-PSE). A book a server offers only as a
  whole-file download is listed, but says it can't be opened.
- OPDS can't send reading progress back to the server. The dedicated bridges will.

### Plain http:// and your own certificates

Comical connects over `http://` as well as `https://`. A bridge warns in its settings when your
password would cross the internet unencrypted: plain `http://` to a server that is not on your local
network or your Tailscale network. For a server whose HTTPS certificate comes from your own
certificate authority, install that authority on the device.

## Development

This repo builds against a sibling checkout of [comical](https://github.com/porksphere/comical) at
`../comical`, resolved through `tsconfig.json` paths:

```sh
(cd ../comical && bun install)
bun run build       # bundles each bridge to .build/<id>/dist/bridge.js
bun test            # unit tests, fixtures, and the built bundles in the core's sandbox
bun run typecheck
```

`src/core/` is shared code that each bridge bundles what it needs from: the server address, Basic
auth, image interception, ids, and the insecure-HTTP warning. `src/core/opds/` parses OPDS feeds.
It holds only what is genuinely shared; each server's API client lives with its bridge.

Pushing a change under `src/` to `main` rebuilds and republishes the signed registry from CI, with
Bun pinned in `.github/workflows/publish.yml`. Never publish a local build: a different Bun emits
different bytes, and every bundle's hash changes.
