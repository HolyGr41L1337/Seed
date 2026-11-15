# Development and releases

[中文](DEVELOPMENT.md) · **English**

This document is for people who want to change Seed itself or publish a new version. To just use it, the [README](../README.en.md) is enough.

## Running from source

You need Node.js 22 or later.

```bash
npm install
```

Run it as a desktop app:

```bash
npm run desktop
```

Run it as a local web server (used from the browser):

```bash
npm start
```

The terminal prints an address with the access token. Open it in a browser:

```
  Open        http://127.0.0.1:7333/?token=…
```

If you only want the command-line version and not the desktop app, `npm install --omit=dev` skips the Electron download. To install it as a global command:

```bash
npm link
```

After that, run `seed` in any project folder, and that folder is the working folder.

There is no build step: change the code and restart. The only runtime dependency is `@anthropic-ai/sdk` (the desktop app also uses Electron).

## Project layout

```
bin/seed.js            command-line entry point
desktop/main.js        the desktop app (Electron): window, menus, system proxy
build/                 app icons, macOS signing settings
electron-builder.config.cjs   packaging settings
.github/workflows/     tests on three platforms (ci.yml), building and publishing installers (release.yml)
src/
  app.js               wires the parts together
  agent/               agent loop, approval policy, system prompt, context summarizing
  providers/           model API adapters: openai.js (compatible protocol), anthropic.js (official SDK)
  tools/               built-in tools
  extensions/host.js   extension loading, hot reload, error collection
  server/              HTTP server, REST API, OpenAI-compatible endpoint, auth
web/                   the interface (plain JavaScript, no build step)
docs/                  API.md, EXTENDING.md, ARCHITECTURE.md, DEVELOPMENT.md (the last two also in English, *.en.md)
examples/extensions/   example extensions
scripts/               scripts that make the README pictures and the release notes
test/                  automated tests
```

The design is explained in [ARCHITECTURE.en.md](ARCHITECTURE.en.md).

## Tests

```bash
npm test                 # tools, approval policy, agent loop, both model APIs, HTTP API, extension system, interface text
node test/e2e/ui.mjs     # browser end-to-end test (needs Playwright, installed separately)
node test/e2e/desktop.mjs   # desktop smoke test (needs Playwright; add --app <path> to test a packaged app)
```

The tests drive the real agent loop and the real interface with scripted mock model servers that answer in the wire protocols of OpenAI and Anthropic.

## Publishing a new version

The installers are built by GitHub Actions on real macOS, Windows and Linux machines. The easiest way to publish a version is a click on the website:

1. Open the repository's **Actions** page and choose **Release** on the left.
2. Click **Run workflow** on the right, type the version number (for example `0.2.0`) into "version", and click the green **Run workflow** button.

About 15 to 20 minutes later, `v0.2.0` appears on the [Releases](https://github.com/HolyGr41L1337/Seed/releases) page with the installers for every system. Its notes begin with a table of which file is for which system (made by `scripts/release-notes.sh`). Before publishing, every installer is actually started and taken through a complete conversation as a check. With "version" left empty, the workflow only builds and does not publish; the built files can be downloaded at the bottom of that run's page.

You can also publish by pushing a tag from your own computer, with the same result:

```bash
git tag v0.2.0
```

```bash
git push origin v0.2.0
```

To package on your own computer:

```bash
npm run dist:mac
```

(On Windows use `npm run dist:win`, on Linux `npm run dist:linux`. The results are in `dist/`.)

**File names.** The installers' file names carry no version number (for example `Seed-mac-arm64.dmg`). That way `https://github.com/<owner>/<repo>/releases/latest/download/<file name>` always points at the newest version, and the download buttons and the table in the READMEs use addresses of this kind. To change a file name, change `electron-builder.config.cjs`, `scripts/release-notes.sh` and the five READMEs together.

**Who can download.** While the repository is private, the files under Releases can only be downloaded by people with access to the repository. To let anyone download them, make the repository public, or create a separate public repository just for the installers.

### Signing the installers

An unsigned installer is stopped by the system the first time it is opened (see "Download" in the README). To spare users these prompts entirely, add these secrets under the repository's Settings → Secrets and variables → Actions; installers published afterwards are signed automatically:

| Secret | What it holds | Purpose |
| --- | --- | --- |
| `MAC_CERT_P12_BASE64` / `MAC_CERT_PASSWORD` | An Apple "Developer ID Application" certificate (.p12, base64-encoded) and its password | macOS signing (needs an Apple developer account, 99 US dollars a year) |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | Apple ID, an app-specific password, the team ID | macOS notarization, after which a double-click opens the app |
| `WIN_CERT_PFX_BASE64` / `WIN_CERT_PASSWORD` | A Windows code-signing certificate (.pfx, base64-encoded) and its password | Windows signing |

## Interface languages

The interface comes in Chinese, English, Japanese, French and Russian, chosen from the system language. All of its text is in `web/assets/js/i18n.js`, one table per language; `test/i18n.test.js` checks that the five tables have the same entries. The desktop app's menu text is in `desktop/main.js`.

To add a language, add a table to `i18n.js` and register it in `languages`, then add the matching entry to each menu text in `desktop/main.js`. Text in extensions uses `seed.tr('中文', 'English', { ja, fr, ru })`; a language without its own text gets the English one.

## READMEs and pictures

The README exists in five languages: `README.md` (Chinese), `README.en.md`, `README.ja.md`, `README.fr.md` and `README.ru.md`. A change of content has to be made in all five.

The demo animations, screenshots, badges and download buttons in the READMEs are all made by one script. After a change to the interface, run it again:

```bash
node scripts/readme-media.mjs
```

It needs Playwright (with Chromium) and ffmpeg, and the fonts Inter and Noto Sans CJK (on Ubuntu: `fonts-inter`, `fonts-noto-cjk`). The pictures go to `docs/images/`, one set for each of the five interface languages, in light and dark. The app in the animation is the real one; the model is a scripted stand-in, and the sidebar it "writes" is `examples/extensions/history-sidebar`.
