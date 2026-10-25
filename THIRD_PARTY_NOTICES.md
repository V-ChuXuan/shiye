# Third-party notices

The project-owned source code is distributed under the [MIT License](LICENSE). Third-party components retain their own licenses; the project license does not replace them.

## Included UI source

Local shadcn/ui Base Nova component source is under `client/src/components/ui/`. Its upstream URLs, hashes and local transformations are recorded in [docs/ui-component-sources.json](docs/ui-component-sources.json). Preserve the full [shadcn MIT notice](docs/shadcn-LICENSE.md) when distributing this source or its compiled form.

The local selection and date controls also use the installed Base UI primitives. Their local adaptations remain part of the project source; the dependency keeps its own license.

## Direct dependencies

The following identifiers were checked against the installed package metadata and the project lockfile. This list describes direct dependencies; it is not a complete inventory of every transitive component or runtime.

| Component | License identifier | Role |
|---|---|---|
| React, React DOM | MIT | Interface |
| Base UI (`@base-ui/react`) | MIT | Interactive primitives |
| Lucide React | ISC | Interface icons |
| Motion | MIT | Interface animation |
| Zustand | MIT | Interface preferences and state |
| react-resizable-panels | MIT | Reading layout |
| class-variance-authority | Apache-2.0 | Component variants |
| cn | MIT | Class names |
| Fastify, `@fastify/static` | MIT | Local HTTP service |
| better-sqlite3 | MIT | SQLite binding; embedded SQLite has separate notices |
| Vite, React Vite plugin, Tailwind CSS and its Vite plugin | MIT | Interface build |
| Electron | MIT | Desktop shell; Chromium and other bundled components have separate notices |
| `@electron/packager` | BSD-2-Clause | Desktop packaging |
| TypeScript | Apache-2.0 | Type checking and compilation |
| tsx | MIT | Development and tests |
| Playwright Core | Apache-2.0 | Browser and desktop tests |
| Type declaration packages (`@types/*`) | MIT | Development types |

Before distributing compiled binaries, preserve the license and notice files of the actual packaged dependency versions, including frontend code compiled into JavaScript. Keep the Node runtime `LICENSE` and Electron's license and Chromium notices. A table of identifiers does not substitute for the required license texts or notices.

## Project source and assets

`abstract-logging@2.0.1` links to its author's [MIT notice](https://jsumners.mit-license.org/) rather than including the full text in its npm package. A [local copy](docs/licenses/abstract-logging-LICENSE.txt), retrieved on 2026-10-25, is included for offline distribution.

- `server/parser.js` retains its provenance comment: its pure HTML helpers were adapted from the earlier local `wechat-mp-archiver/src/article.js` prototype. The application has no runtime dependency on the old project.
- The README screenshot contains an isolated test library, not a user's account or archived article collection.
- Downloaded public-account articles, avatars, covers and other content remain subject to their respective rights. They are not licensed by this repository's MIT text and are excluded from the source distribution.
