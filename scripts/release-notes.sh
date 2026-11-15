#!/usr/bin/env bash
# Prints the top of a release's notes: which file to download for which system.
#
#   scripts/release-notes.sh v0.2.0 owner/repo
set -euo pipefail
TAG="$1"
REPO="$2"
FILES="https://github.com/$REPO/releases/download/$TAG"

cat <<NOTES
## 下载 · Download

| 系统 · System | 文件 · File |
| --- | --- |
| **macOS**（Apple 芯片 · Apple silicon: M1/M2/M3/M4…） | [Seed-mac-arm64.dmg]($FILES/Seed-mac-arm64.dmg) |
| **macOS**（Intel） | [Seed-mac-x64.dmg]($FILES/Seed-mac-x64.dmg) |
| **Windows** | [Seed-Setup-x64.exe]($FILES/Seed-Setup-x64.exe) |
| **Windows**（ARM） | [Seed-Setup-arm64.exe]($FILES/Seed-Setup-arm64.exe) |
| **Linux** | [Seed-linux-x86_64.AppImage]($FILES/Seed-linux-x86_64.AppImage) |

点文件名即可下载，其余的 zip 文件是免安装版。第一次打开被系统拦住时，按[这里的步骤](https://github.com/$REPO#下载安装)操作一次即可。

Click a file name to download it. The zip files are the same app without an installer. If your system blocks the first launch, follow [these steps](https://github.com/$REPO/blob/main/README.en.md#download) once.
NOTES
