# Nightingale Vocal Studio Fork

## Origin and license

This project is an independently modified fork of
[rzru/nightingale](https://github.com/rzru/nightingale), based on upstream commit
`382f0b5` (`fix: sidebar remains opened after playback`). The upstream project and
this fork are licensed under the GNU General Public License v3.0 or later. The
complete license remains in [LICENSE](LICENSE).

The fork is not an official upstream Nightingale release. Changes made here should
not be attributed to the upstream maintainers.

## What this fork adds

- YouTube import as playback-compatible H.264/AAC MP4s, with Unicode-safe metadata, isolated download staging, and audio/video validation. Watch links import one video; explicit playlist links import playlists.
- Versioned melody maps from UltraStar data, TorchCREPE, or pYIN, plus a correction editor.
- Compiled Rust McLeod live-pitch analysis on desktop, with octave-aware scoring, JOYSOUND-style guidance, and phrase replay.
- A local Vocal Studio with voice checkups, range visualization, adaptive exercises, ear training, and history.
- Mono 24-bit vocal masters, synchronized replay mixes, crash recovery, and M4A/MP4 export.
- Windows data-folder and Desktop-shortcut automation, including Japanese path and filename support.

## UI, logo, and product identity

The application code, UI, icons, and artwork may be modified under their applicable
licenses. This working fork currently retains upstream Nightingale branding while
the feature set is being developed. Before distributing it as a separate product:

1. Replace the app name, logo, icons, bundle identifiers, updater endpoints, and installer metadata.
2. Preserve upstream copyright and GPL notices in the source distribution and About/legal material.
3. Audit every third-party font, model, binary, and media asset for redistribution terms.

## Packaging status

`cargo desktop build` currently creates Windows NSIS and MSI installers. The desktop
application itself is compiled, but the analyzer toolchain is provisioned on first
launch: FFmpeg, `uv`, a managed Python runtime, Python packages, and machine-learning
models are downloaded into Nightingale's selected data directory. The user does not
need to install Python manually.

Git is a source-development tool and is not required by the installed application,
so a release installer should not bundle a Git client. The Git repository contains
the complete corresponding source required by the GPL.

## Planned single offline installer

The future Windows deliverable should be one signed setup `.exe` that can complete
installation without network access. It should contain:

- The Tauri desktop executable and WebView assets.
- FFmpeg and `uv`, with pinned versions and checksums.
- A relocatable Python runtime and a locked wheelhouse for every analyzer dependency.
- Required model manifests, with either redistributable model payloads or a clearly separated optional model pack.
- Third-party notices, licenses, a software bill of materials, and payload integrity verification.

Large neural models can make a literal all-in-one executable many gigabytes. The
preferred design is still one user-facing setup `.exe`, with compressed internal
payloads installed into the selected Nightingale data directory. Keep the current
online bootstrap installer as a smaller alternative.

## Repository remotes

After publishing this fork, use `origin` for the fork and retain the original project
as `upstream`:

```powershell
git remote rename origin upstream
git remote add origin https://github.com/OWNER/nightingale-vocal-studio.git
```

Upstream changes can then be reviewed and merged deliberately without overwriting
the Vocal Studio work.
