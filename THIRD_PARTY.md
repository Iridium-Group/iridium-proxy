# Third-party software and attribution

This lists every third-party component that ships with or is used by Klyro, its licence, how it is
used, and whether it was modified. Versions are the ones in `package-lock.json` and
`web/package-lock.json` at the time of writing.

Licence texts are shipped with each package in `node_modules/<package>/LICENSE`; the browser client's
texts are collected in [web/THIRD_PARTY_LICENSES.txt](web/THIRD_PARTY_LICENSES.txt).

## Components used by the server (MIT licensed code, root of this repository)

| Project                                                            | Source                                     | Licence                   | Usage                                                                                                  | Modified                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `@iridium-group/config` 0.1.0                                      | github.com/Iridium-Group/iridium-config    | MIT                       | Configuration loading and validation                                                                   | No (our own project)                                                       |
| `@iridium-group/transport` 0.1.0                                   | github.com/Iridium-Group/iridium-transport | MIT                       | `AddressPolicy` (DNS validation), Wisp packet codec                                                    | No (our own project)                                                       |
| `ws` 8.23.0                                                        | github.com/websockets/ws                   | MIT                       | WebSocket server and client                                                                            | No                                                                         |
| `htmlparser2` 12.0.0                                               | github.com/fb55/htmlparser2                | MIT                       | HTML tokenising for the rewriter                                                                       | No                                                                         |
| `entities` 9.0.0                                                   | github.com/fb55/entities                   | BSD-2-Clause              | HTML attribute entity decoding/escaping                                                                | No                                                                         |
| `tough-cookie` 6.1.0                                               | github.com/salesforce/tough-cookie         | BSD-3-Clause              | Per-session cookie jar                                                                                 | No                                                                         |
| `tldts` 7.5.5                                                      | github.com/remusao/tldts                   | MIT                       | Registrable-domain lookup for the same-site cookie rule                                                | No                                                                         |
| Inter 5.3.0 (variable font, via `@fontsource-variable/inter`)      | github.com/rsms/inter                      | SIL Open Font License 1.1 | The interface typeface; the Latin subset is served from `ui/fonts/`                                    | No (copied unmodified; the licence text is `ui/fonts/Inter-OFL.txt`)       |
| IBM Plex Mono 5.3.0 (400 and 500, via `@fontsource/ibm-plex-mono`) | github.com/IBM/plex                        | SIL Open Font License 1.1 | The monospace typeface for addresses and technical values; the Latin subset is served from `ui/fonts/` | No (copied unmodified; the licence text is `ui/fonts/IBMPlexMono-OFL.txt`) |

## Components used by the browser client (`web/`, AGPL-3.0-only)

The browser client is licensed **AGPL-3.0-only** because it loads and serves AGPL-licensed libraries.
See [NOTICE](NOTICE) and [web/LICENSE](web/LICENSE).

| Project                                                        | Source                                       | Licence                                                       | Usage                                                         | Modified                                                            |
| -------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Scramjet 1.1.0 (`@mercuryworkshop/scramjet`)                   | github.com/MercuryWorkshop/scramjet          | MIT                                                           | Browser-side interception and rewriting in compatibility mode | No (installed from npm, copied unmodified into `web/public/scram/`) |
| bare-mux 2.1.9 (`@mercuryworkshop/bare-mux`)                   | github.com/MercuryWorkshop/bare-mux          | MIT (licence file; the package metadata has no licence field) | Connection between the page and the transport                 | No                                                                  |
| libcurl-transport 1.5.2 (`@mercuryworkshop/libcurl-transport`) | github.com/MercuryWorkshop/libcurl-transport | AGPL-3.0-only                                                 | Transport that speaks Wisp, in compatibility mode             | No                                                                  |
| libcurl.js 0.7.5                                               | github.com/ading2210/libcurl.js              | LGPL-3.0-or-later                                             | Bundled inside libcurl-transport                              | No                                                                  |

The front-end files in `web/public/` (`index.html`, `app.js`, `sw.js`, `style.css`) are original
code written for this project, using the documented public APIs of the libraries above.

## Protocol

**Wisp v1**, specified by Mercury Workshop (github.com/MercuryWorkshop/wisp-protocol). Only the
protocol is used. The relay in `src/wisp.ts` and the packet codec in `@iridium-group/transport` are
our own implementation of it. No code from that repository is included.

## What was studied, honestly

The brief asked for a study of the wider proxy ecosystem. What was actually read for this work:

- **Scramjet**: the README and npm package metadata, and the public example application's wiring
  (how the service worker, controller and transport are configured), to build the compatibility
  client. The example application is AGPL-3.0, so its files were **not copied**; `web/public/*` was
  written from the documented API.
- **bare-mux, libcurl-transport, libcurl.js, scramjet-controller**: package metadata and licences only.

**Not read in the course of this work:** the source code of Ultraviolet, Corrosion, epoxy-tls,
Epoxy, Wisp JS, Workerware, adrift, or the Titanium Network `proxy-transports` project. Klyro's
native mode is an original design (path-style proxy URLs, a fast path versus a transform path, a
validating connection pool) and does not derive from any of them. If code from any of those projects
is ever reused, add it here with its licence, and check whether the licence is compatible with the
MIT parts of this repository.

## Licence compatibility notes

- Distributing the repository as one work: the MIT server code and the AGPL `web/` folder are kept
  in separate directories with separate licence files, and the AGPL part is only loaded by the browser
  and served as static files. If you modify `web/` or the libraries it serves and run it as a
  network service, the AGPL requires you to offer your users the corresponding source; the page's
  "Source" link is there for that purpose and should point at your fork.
- MIT code can be used inside an AGPL work, not the reverse. Do not copy AGPL code into the MIT
  directories.
- This is a good-faith summary, not legal advice.
