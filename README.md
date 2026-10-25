# Reefhue

**Live app: https://lgeoff.github.io/reefhue/** · single-file version: [reefhue-single-file.html](https://lgeoff.github.io/reefhue/reefhue-single-file.html)

Restore the colours of underwater photos and videos in the browser, one file at a time or as a batch. Drag files in, adjust, compare before/after live, download the results. All processing runs locally: a Rust engine compiled to WebAssembly analyses every frame, and exports run its per-pixel formula on the GPU. Nothing is uploaded.

## Run it

- **Quickest:** open `dist/reefhue.html` directly in Chrome, Edge, Firefox or Safari. It is a single self-contained file (engine embedded).
- **From source:** serve the `web/` folder, for example `python3 -m http.server -d web 8000`, then open http://localhost:8000. (ES modules need http://, not file://.)

## Using it

- **Help** in the header starts a guided tour of every feature (offered once on the first visit). On phones the preview stays pinned at the top while you scroll the settings.
- **Open** JPEG/PNG/WebP photos or MP4/MOV/WebM videos (button or drag and drop). One file opens it; several files make a batch. The app starts with a generated demo reef; *Demo clip* renders a short test video in the browser.
- **Presets:** Auto, Shallow (0–5 m), Mid (5–15 m), Deep (15 m +), Green water, Natural, Vivid, plus three **Looks** (Teal matte, Moody blue, Tropical light). Every slider can be fine-tuned; double-click a slider to reset it to the preset value.
- **Water controls:** saturation, hue (turquoise ↔ deep blue) and brightness of blue/cyan water only, like Lightroom's HSL "Aqua/Blue" adjustments.
- **Compare:** Split (drag the divider), After, Before, or hold `B`.
- **Quality readout:** highlight cast on the a*b* plane, RGB histograms, colourfulness, contrast, tonal range, UCIQE and clipping, with a plain-language verdict.
- **Video preview** plays frame by frame through the engine. The automatic correction is smoothed over time (≈0.7 s) to avoid flicker, or can be locked to the current frame. Space = play/pause, ←/→ = step a frame.

### Batch

1. Drop or add several photos and videos. A **Batch** column lists them with a thumbnail, duration and size.
2. Every file uses **Auto** until you change it. Click a file to preview it; any preset or slider change applies to that file only, and its chip switches from *Auto* to the preset name or *Custom*. **Use for all files** copies the current settings to the others; **Back to Auto** resets one.
3. Pick the **Output** (MP4 at original size, up to 4K/1080p/720p, or WebM) and press **Process all**. Files are processed one after another; you can keep previewing and editing others meanwhile. **Stop** cancels.
4. **Download all (.zip)** saves every processed file in one archive (stored, ZIP64 for large batches). Single files also have their own ↓ button. A file whose settings change after processing is marked *Settings changed* and is redone on the next run.

## Export pipeline

```
MP4/MOV file ─ mp4.js demuxer ─ VideoDecoder (hardware) ─┬─ 256 px thumbnail ─ Rust analysis (auto WB, levels, tone LUT, clarity grid)
                                                         └─ full frame ─ WebGL2 shader (gpu.js) ─ VideoEncoder H.264/HEVC ─ MP4 muxer
                                                                          (or Rust/WASM on CPU)      original AAC sound copied as is
```

- **Direct decoding.** Before, the exporter seeked the `<video>` element to every frame. Each seek decodes from the previous key frame, so on long-GOP camera files it cost 150–450 ms per frame. Now the file is demuxed (`web/mp4.js`, no dependencies, reads only the index so multi-GB clips are fine) and decoded once, in order, with WebCodecs.
- **GPU.** The Rust engine still computes everything per frame: white balance, levels, tone curve and the clarity grid. The WebGL2 shader in `web/gpu.js` only evaluates the same formula as `process()`. GPU and CPU outputs match within 1 level (`tests/pipeline/parity.mjs`). No full-size pixels go through JavaScript on this path.
- **MP4 output.** H.264 (or HEVC above 4096 px, or for HEVC sources when supported) with the source's rotation, and the original AAC sound copied without re-encoding. Other sound is re-encoded to AAC or Opus. WebM (VP9 + Opus) remains available.
- **Fallback.** Files the demuxer or decoder can't handle (WebM, unusual codecs) go through the old seek-based path, with the same processing and MP4 output.

**Speed test.** *Test export speed on this device* (bottom of the right panel) renders a 4-second 1080p clip and exports it three ways. Measured on a desktop with an NVIDIA RTX 2080 SUPER (Chrome, Windows):

| Method | 1080p export speed | 4 s clip |
|---|---|---|
| Previous method: seek every frame, Rust/WASM on the CPU | 5.0 fps | 24.1 s |
| Direct decoding, Rust/WASM on the CPU | 6.4 fps | 18.7 s |
| Direct decoding + GPU | **72.1 fps** | **1.7 s** |

That is 14.5× faster; a 10-minute 1080p30 dive video exports in about 4 minutes. On the GPU path the colour correction itself takes 0.8 ms per frame; most of the remaining time is the 256 px analysis thumbnail (7 ms) and the Rust analysis (2 ms). The seek cost of the old method grows with the camera's key-frame interval (up to ~450 ms per frame on long-GOP files).

**Parallelism.** WebAssembly threads need cross-origin isolation (COOP/COEP headers), which a shared artifact page or a file:// page can't have, so CPU parallelism would mean one engine per Web Worker. The GPU path makes that unnecessary: decoding, the shader and encoding already run concurrently on dedicated hardware.

## How the correction works

Per pixel, in `engine/src/lib.rs`:

1. **Red channel compensation** (Ancuti et al. 2018): `R' = R + α·(mean(G) − mean(R))·(1 − R)·G`. The donor is mostly green; pixels much bluer than green (open water, backscatter) get less red, so water stays blue instead of violet. In green water, blue is compensated too.
2. **White balance** from a grey-edge estimate blended with a white-patch estimate.
3. **Levels / dehaze:** per-channel black and white points (0.4 % / 99.6 %), black points pulled part-way to a common value so the water hue doesn't rotate.
4. Warmth/tint, **clarity** (local contrast from a low-res luminance grid built on the analysis thumbnail), **tone curve** LUT, **water hue / brightness**, **saturation, vibrance, water saturation**, **strength** blend.

### Measured accuracy

`tests/eval.py` simulates underwater capture of reference photos (attenuation + backscatter, four water types), restores them with the real `engine.wasm` and compares to the originals (CIEDE2000):

| | mean ΔE2000 (lower is better) |
|---|---|
| Simulated underwater input | 30.5 |
| Plain grey-world correction | 19.3 |
| Reefhue, Auto preset | 11.2 |

### Against Lightroom presets

`tests/preset-benchmark/` compares Reefhue with the before/after examples of The Presets Room's free underwater presets (images not included). The optimiser searches Reefhue's sliders for the closest match to each preset's result (ΔE2000, lower is better; ~2 is barely visible, ~5 clearly visible side by side):

| Preset | Size of the preset's edit | Reefhue Auto | Best Reefhue settings, before | …with water hue/brightness | Best any global colour mapping could do |
|---|---|---|---|---|---|
| Ocean Lights | 15.7 | 9.9 | 3.3 | **3.2** | 3.7 |
| Diving Close-up | 13.4 | 19.4 | 6.9 | **5.3** | 3.3 |
| Maldives Islands | 10.2 | 9.0 | 4.6 | **2.4** | 1.9 |

The presets are stylised grades rather than neutral restoration, so Auto is not meant to match them. Reefhue's sliders can reach their looks closely, and the fitted settings ship as the three **Looks**. Lightroom's remaining edge on Diving Close-up comes from per-colour HSL and split toning, which Reefhue does not have.

## Deployment

Every push to `main` runs `.github/workflows/pages.yml`: it installs Rust with the `wasm32-unknown-unknown` target, runs the engine tests, builds `engine.wasm`, checks that it loads, builds the single-file version and publishes `web/` to GitHub Pages. The site is fully static; photos and videos never leave the visitor's computer.

## Build the engine

The engine is plain `no_std` Rust with **no dependencies** and no wasm-bindgen; the page passes pixel buffers by pointer.

```sh
rustup target add wasm32-unknown-unknown   # once
./engine/build.sh                          # writes web/engine.wasm
python3 tools/bundle.py                    # writes dist/reefhue.html (+ artifact variant)
```

`engine/build-offline.sh` builds the same source without the downloadable wasm32 standard library, using `src/minicore.rs` (only for air-gapped machines; the wasm shipped here was built that way).

## Tests

- `node tests/android-sim.mjs <url> <photo.jpg>` reproduces the Android photo-picker failure (the photo changes between picking and reading, so Chrome throws NotReadableError) in Pixel 7 emulation, and checks the pick-again recovery.

```sh
cd engine && cargo test --lib                      # math, neutrality, thumbnail grid, metrics
python3 tests/eval.py                               # ground-truth accuracy (numpy, scikit-image, node)
tests/make-clips.sh photo.jpg web/_clips            # test videos (ffmpeg)
node tests/e2e.mjs http://localhost:8000/ shots web/_clips   # batch UI, exports, zip (playwright)
node tests/pipeline/parity.mjs http://localhost:8000/index.html   # GPU vs CPU pixels
node tests/pipeline/pipe.mjs http://localhost:8000/ _clips/dive1080.mp4 fast-gpu fast-cpu compat-cpu
python3 tests/preset-benchmark/compare.py           # needs the preset example images
```

## Files

```
engine/                 Rust engine (lib.rs pipeline + GPU exports, math.rs, tests.rs, minicore.rs)
web/  index.html, style.css, app.js     UI, batch queue, preview, readout
      engine.js                          wasm wrapper, presets
      pipeline.js                        export: fast path + fallback
      gpu.js                             WebGL2 renderer
      mp4.js                             MP4/MOV demuxer and muxer
      webm.js                            WebM muxer + Opus
      zip.js                             ZIP/ZIP64 writer
      demo.js                            procedural demo reef and clip
dist/                   single-file builds
tests/                  eval.py, e2e.mjs, make-clips.sh, pipeline/, preset-benchmark/
tools/bundle.py         single-file bundler
```

## Notes

- Video export needs WebCodecs (current Chrome, Edge, Firefox and Safari). H.264 encoding is available in all of them; HEVC depends on the platform.
- Videos the browser cannot decode (for example HEVC/H.265 in Chrome without hardware support) are flagged in the batch and skipped.
- 10-bit/HDR footage is exported as 8-bit SDR.
- HEIC and RAW photos are not supported by browsers; export to JPEG first. EXIF metadata is not copied.
