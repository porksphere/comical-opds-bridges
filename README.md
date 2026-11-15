# Comical self-hosted bridges

Official [Comical](https://github.com/porksphere/comical-app) bridges for servers you run yourself.

| Bridge | Talks to | Status |
|---|---|---|
| **OPDS** (`porksphere.opds`) | Any OPDS 1.x catalog that streams pages with OPDS-PSE: Komga, Kavita, Codex, Stump, Ubooquity… | Available |
| **Komga** (`porksphere.komga`) | Komga 1.19 or later, through its REST API. Read books sync both ways | Available |
| **Kavita** (`porksphere.kavita`) | Kavita's REST API, signed in with your API key. Read chapters sync both ways | Available |
| **Suwayomi** (`porksphere.suwayomi`) | Suwayomi-Server v2, through its GraphQL API: your library and installed sources. Read chapters sync both ways | Available |
| **LANraragi** (`porksphere.lanraragi`, NSFW) | LANraragi's API: each archive opens as one book. Reading progress syncs | Available |

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

### Komga

- **Server address** is Komga's address as you open it in a browser, such as
  `http://192.168.1.5:25600`. A pasted Komga page or OPDS link works too.
- Sign in with an **API key** (Komga: **Account settings → API keys**) or your email and password.
  The account needs Komga's **Page streaming** role to open books. **Test connection** checks both.
- Lists: Keep reading and On deck (once you have something in them), Recently added, Recently
  updated, then each library and collection.
- Finishing a book in Comical marks it read on Komga. Books you read elsewhere show as read after
  the next library refresh.
- Komga links (`/series/…`, `/book/…`) open in Comical.

### Kavita

- **Server address** is Kavita's address as you open it in a browser, such as
  `http://192.168.1.5:5000`. Paste Kavita's **OPDS URL** instead and the API key comes with it.
- Otherwise copy an **API key** from Kavita (**User settings → Auth keys**). **Test connection**
  says which Kavita you reached and who you are signed in as.
- Lists: On deck (once you have started something), Recently added, then each library and
  collection.
- Chapters keep Kavita's order: volumes, loose chapters (a comic library's issues), then specials.
  PDFs open page by page; text EPUBs don't.
- Finishing a chapter in Comical marks it read on Kavita, and chapters you read elsewhere show as
  read after the next library refresh.

### Suwayomi

- **Server address** is Suwayomi's address as you open it in a browser, such as
  `http://192.168.1.5:4567`.
- Leave the username and password empty if Suwayomi has no sign-in. With **Basic auth** or **UI
  login** turned on, enter its username and password. Simple login can't be used from Comical.
- Lists: Recently updated and your library (one list per category) when they have something in
  them, then each installed source, the Local source first. Each source's list searches that
  source.
- Search looks in your library and in up to 8 sources at once.
- Finishing a chapter in Comical marks it read on Suwayomi, and chapters you read elsewhere show as
  read after the next library refresh.

### LANraragi

- Marked NSFW, since that's what most LANraragi libraries hold: Comical shows it only where NSFW
  sources are allowed.
- **Server address** is LANraragi's address as you open it in a browser, such as
  `http://192.168.1.5:3000`.
- The **API key** (LANraragi: **Settings → Security**) is needed in No-Fun Mode, and to sync
  reading progress or clear the New flag. Without it an open server still reads fine.
- Each archive is one book, with no chapters. Lists: Continue reading, New, Recently added, each
  category with something in it, and All archives. Search takes LANraragi's own syntax, such as
  `artist:someone`.
- Finishing an archive sets its progress on the server to the last page and clears New.

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
