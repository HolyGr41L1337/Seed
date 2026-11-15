// electron-builder configuration for the Seed desktop app.
//
// Signing is optional and driven by environment variables (GitHub Actions
// secrets in .github/workflows/release.yml):
//   macOS:   CSC_LINK + CSC_KEY_PASSWORD (Developer ID Application .p12), and for
//            notarization APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER
//            (or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID)
//   Windows: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD (code signing .pfx)
// Without them, macOS builds are ad-hoc signed and Windows builds are unsigned:
// they work, but the system warns on first launch (see README).
const signMac = !!(process.env.CSC_LINK || process.env.CSC_NAME);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.github.holygr41l1337.seed',
  productName: 'Seed',
  copyright: 'Copyright © 2026 Seed',
  directories: { output: 'dist', buildResources: 'build' },
  files: [
    'package.json',
    'desktop/**',
    'src/**',
    'web/**',
    'docs/**',
    '!docs/images/**', // README pictures, not needed inside the app
    'examples/**',
    'build/icon-win.png',
    'README.md',
  ],
  // Keep the app's files as plain files: the agent reads the docs and the
  // example extensions with ordinary file tools and shell commands.
  asar: false,
  // File names carry no version, so that
  // https://github.com/<owner>/<repo>/releases/latest/download/<name> always
  // points at the newest build. The READMEs' download buttons rely on this.
  artifactName: '${productName}-${os}-${arch}.${ext}',
  publish: null,

  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.png',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    identity: signMac ? undefined : '-',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
  },
  dmg: {
    artifactName: '${productName}-mac-${arch}.${ext}',
    title: '${productName} ${version}',
  },

  win: {
    icon: 'build/icon-win.png',
    target: [
      { target: 'nsis', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
  },
  nsis: {
    oneClick: true,
    perMachine: false, // installs for the current user: no administrator rights needed
    buildUniversalInstaller: false, // one installer per architecture, not one with both inside
    artifactName: '${productName}-Setup-${arch}.${ext}',
    shortcutName: 'Seed',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
  },

  linux: {
    executableName: 'seed',
    syncDesktopName: true,
    icon: 'build/icon-win.png',
    category: 'Development',
    target: [{ target: 'AppImage', arch: ['x64'] }],
  },
};
