# AQR Transfer — native iOS scanner

A native iOS receiver for the **Animated QR Transfer** web app. The web app
(your `text-to-qr` project) stays the **encoder**: it turns a file into a loop of
animated QR frames shown on your computer screen. This app is the **scanner**:
it points the iPhone camera at that animation, collects the frames, verifies
them, and rebuilds the original file.

The whole reason this exists: iOS Safari's `getUserMedia` won't drive the camera
hard enough (it caps resolution, won't lock focus, hunts in low light). VisionKit
uses Apple's own camera pipeline — the same engine as the Camera app — so the
blurry/dark-frame problem the browser version hit essentially disappears.

## Wire format (must match the web app)

```
AQR1|id|index|total|alg|fileHash|chunkHash|nameB64|mimeB64|data
```

`nameB64`, `mimeB64`, and `data` are base64url, so they never contain the `|`
delimiter. `alg` is `gzip` or `raw`. `chunkHash` is the first 16 hex chars of the
chunk's SHA-256; `fileHash` is the full-file SHA-256. This is parsed in
`FrameParser.swift`, a direct port of `parseFrame()` in `app.debug4.js`.

## Files

| File | Role |
|------|------|
| `AQRScannerApp.swift` | App entry point |
| `ContentView.swift` | SwiftUI UI: scanner, progress bar, chunk grid, share sheet |
| `ScannerView.swift` | `UIViewControllerRepresentable` wrapper over VisionKit's `DataScannerViewController` |
| `TransferReceiver.swift` | Frame ingest, dedupe, per-chunk + whole-file verification, rebuild (port of `handleQrDecoded` + `rebuildTransfer`) |
| `FrameParser.swift` | AQR1 parsing, base64url, SHA-256 (CryptoKit) |
| `Gzip.swift` | gzip → raw DEFLATE shim so pako output decodes with Apple's Compression framework |
| `ChunkGrid.swift` | Grid of squares that fill green as chunks arrive |
| `Haptics.swift` | Tick per chunk, success buzz on completion |
| `Info.plist` | Reference camera-usage plist (manual builds only; XcodeGen generates its own from `project.yml`) |
| `project.yml` | XcodeGen project definition — generates the `.xcodeproj` and injects the camera permission key |

## Requirements

- A Mac with **Xcode 15+**
- An iPhone running **iOS 16+** with an **A12 Bionic** chip or newer (iPhone XS / XR, late 2018, or later)
- For an install that lasts beyond 7 days: an **Apple Developer Program** membership ($99/yr). With a free Apple ID, Xcode will still sideload to your own device, but the app expires every 7 days and must be re-deployed from Xcode.

## Building (recommended: XcodeGen)

The repo ships a `project.yml` so you can generate the `.xcodeproj` in one
command instead of hand-building it. This keeps the project reproducible from the
repo and injects the camera permission key automatically.

```sh
brew install xcodegen        # one-time
cd /path/to/qrtransfer       # the cloned repo root (where project.yml lives)
xcodegen generate            # creates AQRScanner.xcodeproj
open AQRScanner.xcodeproj
```

Then in Xcode:

1. Select the **AQRScanner** target → **Signing & Capabilities** → ensure
   **Automatically manage signing** is on and pick your **Team** (a free Apple
   ID works). Alternatively, set `DEVELOPMENT_TEAM` in `project.yml` and re-run
   `xcodegen generate`.
2. Plug in your iPhone, select it as the run destination.
3. Press **⌘R**.

Re-run `xcodegen generate` whenever you add/remove source files or edit
`project.yml`. The generated `.xcodeproj` is git-ignored — it's disposable.

### First launch on a free Apple ID

The first on-device run installs the app but iOS won't launch it until you trust
the cert: on the phone, **Settings → General → VPN & Device Management** → tap
your Apple ID under "Developer App" → **Trust**. Then tap the app icon. With a
free account the app stops launching after 7 days and must be re-run from Xcode;
a paid Developer Program membership ($99/yr) extends that to a year.

## Building (manual alternative, no XcodeGen)

If you'd rather not install XcodeGen:

1. Open Xcode → **File → New → Project → iOS → App**.
   - Product Name: `AQRScanner`
   - Interface: **SwiftUI**, Language: **Swift**
   - Uncheck Core Data / Tests.
2. Delete the auto-generated `ContentView.swift` and `<Name>App.swift`.
3. Drag the `.swift` files from `AQRScanner/` into the project navigator
   ("Copy items if needed" checked). Do **not** add `Info.plist` — instead add
   the camera key under Target → **Info** → add
   **Privacy - Camera Usage Description** (`NSCameraUsageDescription`).
4. Target → **General** → Minimum Deployments → **iOS 16.0**.
5. Set your Team under **Signing & Capabilities**, pick your iPhone, press ⌘R.

## Usage

1. On your computer, open the web encoder, pick a file, **Generate QR Frames**,
   and (optional but recommended) bump **Repeat each frame** to 2–3× so each QR
   lingers long enough to catch.
2. On the phone, open this app, tap **Start Camera Scan**, point at the screen.
3. The chunk grid fills green; you get a haptic tick per new chunk and a success
   buzz when the file verifies.
4. Tap **Save / Share** to drop the rebuilt file into Files, AirDrop, etc.

## Notes

- **gzip is optional.** If you'd rather not rely on `Gzip.swift`, untick
  "Compress with gzip" in the web encoder. Raw mode skips decompression entirely
  and still verifies/rebuilds correctly. gzip only reduces the number of QR
  frames; it isn't required for correctness.
- This app only **receives**. Encoding stays in the web app, which is the right
  place for it (the computer screen is the display surface).
