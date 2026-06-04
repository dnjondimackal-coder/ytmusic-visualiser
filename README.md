# WinXP Visualizer for YouTube Music 🎵📺

A Firefox extension that **replaces the album cover** for the currently-playing
song on [music.youtube.com](https://music.youtube.com) with **Windows XP Media
Player-style visualizations** that change at random.

It overlays the big "Now Playing" art **and** the little player-bar thumbnail with
a live canvas, cycling through six classic-feeling visualizations:

| Mode | Vibe |
|------|------|
| **Bars** | Neon spectrum analyzer with falling peak caps |
| **Waves** | Glowing multi-color oscilloscope |
| **Ambience** | Flowing plasma blobs that breathe with the bass |
| **Spikes** | Rotating radial spectrum (mirrored) |
| **Battery** | Beat-triggered particle bursts + spinning rays |
| **Alchemy** | Swirling Lissajous curves warped by the waveform |

The visualization switches **on every song change** and **at random intervals**
(default 12–30s). Real audio is analyzed via the Web Audio API; if the stream
can't be analyzed it falls back to a synthetic signal so the visuals never freeze.

---

## Install (temporary — for testing)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select the **`manifest.json`** file in this folder
4. Open <https://music.youtube.com>, play a song, and open the full-screen player

> Temporary add-ons are removed when Firefox restarts. To keep it permanently you
> must package and sign it (see below).

## Install (permanent)

Firefox only runs signed extensions outside of debugging. Options:

- **Self-distribution signing:** zip the folder's contents and submit to
  [addons.mozilla.org](https://addons.mozilla.org) → *Developer Hub* →
  *Submit a New Add-on* → *On your own* to get a signed `.xpi`. Then install it
  via `about:addons` → gear → *Install Add-on From File*.
- Or use **Firefox Developer Edition / Nightly** with
  `xpinstall.signatures.required = false` in `about:config`, then install the
  zipped `.xpi` directly.

Package command (run inside this folder):

```powershell
Compress-Archive -Path .\* -DestinationPath ..\winxp-visualizer.zip -Force
# then rename winxp-visualizer.zip -> winxp-visualizer.xpi
```

---

## Controls (toolbar popup)

- **Enabled** — turn the overlay on/off
- **Visualization** — pin one mode, or leave on **Random** for auto-switching
- **Intensity** — how strongly it reacts to audio
- **Cover** — overlay opacity (100% = fully replaces art, lower = blends with it)
- **Auto-switch min/max** — random switch interval in seconds
- **Show name on switch** — flash the visualization's name (WMP homage)
- **Skip to next visualization** — jump immediately

All changes apply live to the open tab.

---

## Notes & troubleshooting

- **It never mutes your music:** the extension only routes audio through its
  analyzer once the browser audio context is actually running, so playback is
  never silenced. If analysis isn't possible, visuals run on synthetic data.
- **Selectors may drift:** YouTube Music changes its DOM over time. The art is
  located via `#song-image` (big player) and the first image in
  `ytmusic-player-bar` (thumbnail). If a future YT Music update moves these,
  update `artContainers()` in `content.js`.
- **Performance:** the glow-heavy modes (Spikes / Battery) do the most drawing.
  If you notice CPU use on a low-power machine, pin a lighter mode (Bars/Waves)
  or lower Intensity. Rendering pauses automatically when the tab is hidden or
  the art is off-screen.
- **Nothing appears?** Make sure a song is actually loaded and the player is
  visible. Open the browser console on the YT Music tab and look for `[WMPX]`
  messages.

## Files

```
manifest.json   extension manifest (MV3, Firefox)
content.js      injects canvases + all visualizations + audio engine
popup.html      toolbar control panel (XP-Luna styled)
popup.js        wires the popup to extension storage
icon.svg        toolbar / add-on icon
```
