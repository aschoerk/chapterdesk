# Packaging & distribution

This folder holds the pieces that let ChapterDesk be distributed through
**standard Linux repositories** and eventually **certified installable on
Windows**. `electron-builder` produces the binary archives; these files are the
catalog/packaging metadata and channel recipes.

## What electron-builder now emits (`npm run electron:build`)

| Platform | Targets | Output |
|----------|---------|--------|
| Linux    | `AppImage`, `deb`, `rpm` | `dist/*.AppImage`, `dist/*.deb`, `dist/*.rpm` |
| Windows  | `nsis` (unsigned by default) | `dist/*.exe` (+ `latest.yml`, `.blockmap`) |

AppStream metadata (`.metainfo.xml`) and the `.desktop` entry above are the
source for all catalog-side packaging. electron-builder auto-generates the
`.desktop` it installs; the checked-in `ChapterDesk.desktop` mirrors the same
`Exec=ChapterDesk` binary so external recipes (Flatpak/PPA/OBS/AUR) stay
consistent.

## Prune check

The installers are slim by construction now:

- root `node_modules` is **not** glob-included; only the production
  dependencies electron-builder resolves are packaged. Angular is a
  devDependency because the renderer ships as a prebuilt static bundle
  (`electron/renderer` + `dist/chat`).
- `chapterdesk-api-server/**` still includes the server's own `node_modules`
  (express, better-sqlite3, firebase-admin), which the Electron main process
  imports at runtime.

Track the unpacked size with:

```bash
npm run electron:build:dir   # builds dist/linux-unpacked + dist/win-unpacked
du -sh dist/*-unpacked
```

## Linux channels (roadmap / recipes)

### Flathub (recommended, covers every distro)
1. Create `flatpak/io.github.aschoerk.chapterdesk.yml` on the
   `org.electronjs.Electron2.BaseApp` runtime.
   - Build steps in the sandbox: `npm ci`, `npm run build:server`,
     `npm run build`, then copy `dist/**` + server `node_modules` into the
     Flatpak `files/` tree.
   - Extend `finish-args` with `--share=network` (LLM providers) — the local
     server already binds `127.0.0.1` — and make `app.getPath('userData')`
     resolve inside the sandbox's XDG data home.
   - Rebuild `better-sqlite3` against the Flatpak runtime's Node ABI.
2. Submit the recipe + this `metainfo.xml` to `flathub/io.github.aschoerk.chapterdesk`.
   The metainfo already ships real screenshots (referenced from
   `assets/screenshots/` on `main`) and a full OARS content rating, so a
   Flathub submission should pass `appstreamcli validate` once the assets are
   pushed (validate points at `raw.githubusercontent.com/…/main/assets/…`).

### Launchpad PPA (Ubuntu/Debian users)
- Ship the `.deb` that `electron-builder` produces; `debsign` with a GPG key
  and `dput` to a PPA. Add `debian/` metadata if you move to source packages.

### Open Build Service (OBS, one source → many archives)
- Create a project, add a `chapterdesk.spec` and a `_service` that pulls the
  GitHub **source tarball** of the release tag, then run
  `npm ci && npm run electron:build` inside the build loop.

### AUR (Arch)
- A `PKGBUILD` that clones the tag, runs `npm ci`, `npm run electron:build`,
  and packages the contents of `dist/linux-unpacked` with `ChapterDesk.desktop`
  + this metainfo.

## Windows certification (roadmap)

1. **Sign the NSIS build** — set GitHub secrets `CSC_LINK` (base64 or URL of
   the `.pfx`) and `CSC_KEY_PASSWORD`. electron-builder signs the app exe
   automatically; the release workflow already forwards them. For **Azure
   Trusted Signing** add `win.azureSignOptions` to `build` in `package.json`
   (from Key Vault identities) instead of a `.pfx`.
2. **`winget`** — submit a manifest to `microsoft/winget-pkgs` (the signed
   `ChapterDesk-<version>.exe` URL from Releases).
3. **Microsoft Store** — build the MSIX package. electron-builder produces
   the MSIX/AppX store package via its ``appx`` target:

   ```bash
   npm run electron:build:appx   # on Windows; electron-builder -> --win appx
   ```

   Pass the Store/WACK checks (require a real publisher identity, consistent
   `CompanyName`/`ProductName`/`FileVersion`, and no admin elevation — the app
   already binds 127.0.0.1 and stores data under `%APPDATA%`), then submit the
   signed `.msix`/`.appx` to Partner Center. Store-signed apps no longer
   trigger SmartScreen unknowns.

## Metadata to keep in sync

| Setting | File |
|---------|------|
| app id / desktop-id | `packaging/io.github.aschoerk.chapterdesk.metainfo.xml` (launchable) + `.desktop` `StartupWMClass` + Flatpak manifest |
| MSIX identity | `package.json` → `build.appx.identityName` |
| executable name | `package.json` → `build.linux.executableName` (`ChapterDesk`) |
| maintainer e-mail | `package.json` → `build.linux.maintainer` + `author.email` (replace the GitHub noreply with your real address for PPA/OBS) |
| version | `package.json` (single source of truth) + metainfo `<release>` entry |