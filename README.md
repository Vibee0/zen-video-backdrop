# Zen Video Backdrop

A [Sine](https://github.com/CosmoCreeper/Sine) mod for [Zen Browser](https://zen-browser.app/) that plays looping videos from a local folder **behind the entire Zen UI**.

It does not modify Bonjourr or Nebula. Instead it makes the browser's content layer optionally transparent so they show through to the video that this mod paints in chrome.

```
 ┌────────────────────────────────────────┐
 │ Nebula (chrome glass / animations)      │   ← unchanged
 ├────────────────────────────────────────┤
 │ Bonjourr (clock, links, etc.)           │   ← unchanged, background=None
 ├────────────────────────────────────────┤
 │ Zen Video Backdrop (this mod)           │   ← plays your videos here
 └────────────────────────────────────────┘
```

## Settings (mirrors Bonjourr's video background settings)

| Setting | Default | Notes |
| --- | --- | --- |
| Folder with videos | `D:\Users\user\Videos\zen` | Absolute path. Auto-rescanned every minute and when the path changes. |
| Pick next video randomly | on | Off = cycle in filename order. |
| Change video | Every new tab page | `pause` / `tabs` / `period (every N minutes)` / `hour` / `day`. Same vocabulary Bonjourr uses. |
| Period (minutes) | 15 | Used when *Change video* = `period`. |
| Fit | cover | `cover` / `contain` / `fill` / `none`. |
| Zoom | 100 % | CSS `transform: scale(...)`. |
| Brightness | 100 % | CSS `filter: brightness(...)`. |
| Blur | 0 px | CSS `filter: blur(...)`. |
| Dim overlay | 0 % | Black overlay on top of the video. |
| Fade duration | 600 ms | Cross-fade between consecutive videos. |
| Playback speed | 100 % | CSS-independent — `video.playbackRate`. |
| Mute | on | |
| Make the browser content layer transparent | on | Lets Bonjourr / about: pages show the video behind them. |

All settings live in **Sine → Mod → Zen Video Backdrop**. Changes apply live; restarting Zen is not required.

## Install

### 1. Drop your videos

Put any `.mp4` / `.webm` / `.mov` / `.m4v` / `.ogv` / `.ogg` files into the folder you'll configure (default `D:\Users\user\Videos\zen`). Subfolders are ignored.

### 2. Add the mod to Sine

Open Zen → **Settings → Sine → Marketplace**, paste this URL into "Install Mod from URL":

```
Vibee0/zen-video-backdrop
```

or the full form: `https://github.com/Vibee0/zen-video-backdrop`. Sine will fetch `theme.json`, download the files into `chrome/sine-mods/zen-video-backdrop/`, and add the entry to `chrome/sine-mods/mods.json`. Reload Zen if Sine asks you to.

### 3. Tell Bonjourr to stop playing videos

We want the video to come from *this* mod, not from Bonjourr. In Bonjourr (new tab) → **Settings → Backgrounds**:

* **Type** → `Color`.
* **Color** → set its hex to `#00000000` (eight zeros = transparent). If your colour picker doesn't accept alpha, type the hex string directly into the box.

Bonjourr will keep its clock, search, links, etc. — only its own background renderer goes dark, letting whatever is behind the new-tab page (= this mod's video) show through.

### 4. Nebula

Nothing to do. Nebula's glass / blur / animations remain on top and now sit over the video. No files are touched by this mod.

## Rolling back the previous `bonjourr-nebula-sync` setup

If you installed the earlier patched Bonjourr / Python bridge / `BonjourrNebulaSync` Sine mod, undo it as follows.

1. **Stop the bridge**: open Task Manager, kill any `pythonw.exe` or `python.exe` running `bonjourr_nebula_bridge.py`.
2. **Disable autostart**: delete `BonjourrNebulaBridge.vbs` from
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`.
3. **Delete the bridge folder** wherever you copied it (e.g. `C:\Tools\bonjourr-nebula-bridge\`). Optional but cleaner.
4. **Remove the env var**:
   ```
   reg delete "HKCU\Environment" /v BONJOURR_NEBULA_VIDEOS_DIR /f
   ```
5. **Replace patched Bonjourr with the official one**:
   * In Zen → `about:addons` → **Bonjourr · Nebula Sync** → ⋯ → **Remove**.
   * Install official Bonjourr from <https://addons.mozilla.org/firefox/addon/bonjourr-startpage/>.
6. **Remove the old Sine mod**:
   * Close Zen completely.
   * Delete `…\chrome\sine-mods\BonjourrNebulaSync\` from your Zen profile.
   * Edit `…\chrome\sine-mods\mods.json` and remove the `"BonjourrNebulaSync": { … }` entry (or use the Sine UI: Settings → Sine → Manage → remove).

After this, *only* this `zen-video-backdrop` mod handles the video.

## Troubleshooting

Open the Browser Console with `Ctrl+Shift+J` and filter on `[zen-video-backdrop]`. The mod logs:

* `init, cfg = {...}` — initial settings read from prefs.
* `rescan: found N videos in <path>` — directory listing result. If N=0, double-check the folder path and that files have one of the allowed extensions.
* `→ filename.mp4` — switched to that file.
* `pref changed: <name>` — a setting was updated in the Sine UI.

### "Black screen, no video"

* Wrong path. The console should say `dir missing or not a directory: ...` — fix in the Sine UI.
* Zero files match the supported extensions. Use `.mp4` / `.webm`.
* `transparent-newtab` is off and Bonjourr is painting a solid background on top — turn it on and follow step 3 above.

### "Video plays but Bonjourr still shows its own video"

You haven't switched Bonjourr's background to `Color = #00000000` (or `Files` with all files removed). Bonjourr will keep rendering whatever it has — there's no way for this mod to stop it short of patching Bonjourr (which we deliberately don't do).

### "Nebula effects look weird"

This mod doesn't touch Nebula. If something looks off, it's most likely because Nebula's glass is now layered over a bright animated background and small artefacts you didn't notice on a static colour become visible. Tweak this mod's **Brightness**, **Blur**, or **Dim overlay** until Nebula reads cleanly.

## Building locally / hacking

```
.
├── theme.json                          # Sine mod manifest
├── preferences.json                    # Sine settings UI
├── userChrome.css                      # backdrop styling + transparent content layer
└── js/
    └── zen-video-backdrop.uc.js        # all of the runtime logic
```

The only entry point is `js/zen-video-backdrop.uc.js`. It is plain ES2020 — no build step. Drop the whole tree into `chrome/sine-mods/zen-video-backdrop/` and register it in `chrome/sine-mods/mods.json` to side-load without the Sine marketplace.

## License

MIT.
