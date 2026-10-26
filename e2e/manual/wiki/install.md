# Download & Install

ChapterDesk runs on **Linux** and **Windows** as a desktop app. It starts its
own local server automatically — you do not need to set up anything else.

## Linux (AppImage / .deb / .rpm)

1. Go to the [Releases](https://github.com/aschoerk/chapterdesk/releases) page.
2. Download one of:
   - `.AppImage` — run anywhere, no installation
   - `.deb` — Debian / Ubuntu / Mint …
   - `.rpm` — Fedora / RHEL / openSUSE …

Make the AppImage executable and start it:

```bash
chmod +x ChapterDesk-*.AppImage
./ChapterDesk-*.AppImage
```

Or install with your distro tooling:

```bash
# Debian/Ubuntu
sudo apt install ./ChapterDesk-*.deb

# Fedora
sudo dnf install ./ChapterDesk-*.rpm
```

Your data is stored in:

```
~/.config/ChapterDesk/data/chapterdesk.sqlite
```

## Windows

1. Go to the [Releases](https://github.com/aschoerk/chapterdesk/releases) page.
2. Download the **`ChapterDesk Setup *.exe`** installer (NSIS).
3. Run it — you can choose the install folder.
4. Start **ChapterDesk** from the Start menu or the desktop shortcut.

Your data is stored in:

```
%APPDATA%\ChapterDesk\data\chapterdesk.sqlite
```

> If Windows Defender SmartScreen warns about an unknown publisher, choose
> **More info → Run anyway**. The build is unsigned unless a code-signing
> certificate is added.

## What you need for AI

ChapterDesk does not ship a model. You bring a provider that speaks the
OpenAI-style chat API — **OpenRouter** is the usual choice (one key, many
models). A long-context, instruction-following model is enough; you are giving
scene directions, not running a toolbox agent.

See [Settings](settings) for connecting a provider and choosing a model.

## Build it yourself (developers)

```bash
git clone https://github.com/aschoerk/chapterdesk.git
cd chapterdesk
npm install
npm install --prefix chapterdesk-api-server   # bundled API server deps
npm run electron:build                        # AppImage / .deb / .rpm / .exe
```

For daily development:

```bash
npm run electron:dev   # Angular dev server + Electron + local chat-server
```