# PostureSense AI

A privacy-first, browser-based real-time posture monitoring tool. Uses [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) to detect head and shoulder position via your webcam — all inference runs locally in the browser. No video or data is uploaded.

## Features

- **Real-time pose detection** — MediaPipe Pose Landmarker Lite, running via WASM in the browser
- **Posture calibration** — set your natural upright position as a 10-second baseline
- **Deviation warnings** — alert when head shift or shoulder tilt exceeds your calibrated baseline
- **Live telemetry** — head displacement, shoulder tilt change, inference latency, visible landmark count, and sustained bad-posture duration
- **Dark hacker-console UI** — high-contrast monitoring dashboard with neon-green accents
- **Fully local** — no server, no cloud, no tracking

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173/` in your browser. Grant camera permission when prompted.

## Workflow

1. **START MONITORING** — initializes the pose model and starts the camera.
2. **CALIBRATE** — sit upright and press Calibrate. Hold position for 10 seconds.
3. **Monitor** — the AI tracks your posture against the baseline and warns when you deviate.
4. **RECALIBRATE** — press at any time to update your baseline.
5. **STOP MONITORING** — stops AI and resets state.

## Build

```bash
npm run build    # Production bundle → dist/
npm run preview  # Serve the production build locally
```

## Project Structure

```
posturesense-mobile/
├── index.html              # App shell — title, meta, font imports
├── package.json
├── vite.config.js
├── public/
│   ├── favicon.svg
│   ├── models/
│   │   └── pose_landmarker_lite.task   # MediaPipe model (5.5 MB)
│   └── wasm/                            # MediaPipe WASM runtime
└── src/
    ├── main.js             # Vue app entry
    ├── App.vue             # Main dashboard component
    ├── poseDetector.js     # MediaPipe initialization and detection
    ├── postureLogic.js     # Calibration, smoothing and warning logic
    └── style.css           # Design system — dark hacker-console theme
```

## Privacy

All pose inference runs in the browser using WebAssembly. The camera stream is processed locally and never leaves the device.

## Tech Stack

- [Vue 3](https://vuejs.org/) — Composition API
- [Vite](https://vite.dev/) — build tool
- [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) — pose detection
- Vanilla CSS — custom design system

## License

MIT
