# Troubleshooting

## First Launch Takes Too Long

The initial setup downloads Python, PyTorch, ML models, and video backgrounds. On a slow connection this can take 10–20 minutes. Subsequent launches skip setup entirely.

## Analysis Fails

If song analysis fails:

1. Check the error message in the UI for details
2. Ensure you have enough disk space (~5 GB for models and cache)
3. Try selecting **Re-run Setup** from the sidebar actions menu to reset the vendor environment
4. GPU memory errors may occur with very long songs — CPU fallback will be used automatically

## YouTube Imports Show `.f251` / `.f401` or 0:00

Files such as `song.f251.webm` and `song.f401.mp4` are separate downloader
streams, not complete karaoke videos. Renaming them to `.mp4` does not merge
audio and video. Older builds could leave these in the library when FFmpeg
could not run, particularly when an Intel FFmpeg was installed on Apple Silicon.

The Vocal Studio fork now checks FFmpeg before downloading, stages unfinished
streams outside the library, and requests H.264 video with AAC audio in one MP4.
It also ignores old `.f<number>` streams during library scans. Keep any old files
as a backup and reimport the original video URL after updating; do not delete
your whole library or analysis cache. A watch URL containing a radio mix now
imports only that video. Use a `/playlist?list=...` URL to import a whole playlist.

The downloader uses an existing Node 22+ runtime when available (including
Homebrew paths on macOS). If it reports a missing JavaScript runtime, install a
supported runtime following the [official yt-dlp guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS).

On Apple Silicon, setup also selects the official macOS 12-compatible SciPy
1.15.3 wheel for its Python 3.10 environment and runs an analysis-import health
check. This avoids the PROPACK `__thread_bss` loader failure from the macOS 14
wheel on newer macOS versions.

## No Sound

- Verify your audio output device is correctly configured
- Check that the audio file format is supported (`.mp3`, `.flac`, `.ogg`, `.opus`, `.wav`, `.m4a`, `.aac`, `.wma`)
- Try a different audio file to rule out file-specific issues

## Microphone Not Detected

- Press `N` to cycle through available microphones
- Press `R` to toggle mic monitoring if you want live monitor audio
- Ensure microphone permissions are granted to the application
- On macOS, check System Settings > Privacy & Security > Microphone

## GPU Acceleration Not Working

The analyzer auto-detects the best backend:

- **NVIDIA GPU**: Requires CUDA-compatible drivers
- **Apple Silicon**: Uses MPS backend (some operations fall back to CPU)
- **CPU**: Always works as a fallback

Check the setup progress screen for which backend was detected.

## Updates

The auto-updater runs on **macOS and Windows only** — Linux ships without it. If you're on Linux and the **Update** dialog says "Auto-update isn't supported on Linux", that's expected. Click **Open GitHub Releases** to grab the new `.deb` or `.rpm` and install it the normal way for your distro.

If the **Update** dialog reports a problem on macOS or Windows:

- **Stuck on "Checking for updates…"** — the update server couldn't be reached. Confirm you have a working internet connection and that GitHub is reachable; the manifest is fetched from `github.com/rzru/nightingale/releases/latest`. If the dialog shows a Wi-Fi-off icon, you're offline.
- **"Couldn't reach the update server" / network error** — same cause as above. Click **Retry** once your connection is back, or download the new build manually from the [Releases](https://github.com/rzru/nightingale/releases) page.
- **"Signature error"** — the downloaded bundle didn't match the public key baked into the app. This usually means you're running an unofficial build. Re-download Nightingale from the [Releases](https://github.com/rzru/nightingale/releases) page and try again.

## Reset Everything

To completely reset Nightingale, delete your selected data directory. If you use the default location:

```bash
rm -rf ~/.nightingale
```

If you use a custom data folder, delete that folder instead, then relaunch and run setup again.
