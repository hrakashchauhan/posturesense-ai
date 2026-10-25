# PostureSense

PostureSense is a browser-based posture check-in for desk work. Sit comfortably in view, set a personal reference in four seconds, and get a clear reminder when visible body alignment changes and stays changed.

**Live demo:** [posturesense-ai-delta.vercel.app](https://posturesense-ai-delta.vercel.app/)

Pose inference runs in the browser. Camera frames and pose landmarks are not sent to an application server or saved. The app does download the site, MediaPipe model, and WASM runtime from the host when needed. No account, API key, database, or environment variable is required. It uses system fonts and does not request hosted fonts.

> **Scope:** This is an educational wellness aid, not a medical or ergonomic assessment. Camera angle, visibility, thresholds, and model quality affect results. The measurements are relative to your calibration and are not a posture score or clinically validated threshold.

## Features

- Live camera pose detection for one person, with visible body landmarks.
- Automatic camera-angle selection; no front or side setting is needed.
- Body-area status for head and neck, shoulders, torso and hips, and knees and ankles.
- Tracking-confidence percentage based on visible landmark quality, not a posture score.
- Four-second calibration that pauses during unclear framing or large shifts and preserves progress.
- A single actionable reminder for a change that lasts; small movement stays normal.
- Local browser inference using MediaPipe Tasks Vision and WebAssembly.
- Responsive Vue interface for desktop and mobile browsers.

## Requirements

- Node.js 20.19 or newer and npm.
- A modern browser with camera access.
- HTTPS for deployed sites. `localhost` is permitted for development.

## Run locally

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`) and grant camera permission. Build and preview the production site with:

```bash
npm run build
npm run preview
```

Run the posture-logic checks with `npm test`.

## Deploy to Vercel

This Git repository's root is the web app directory. When importing `hrakashchauhan/posturesense-ai` (or a fork of this repository), keep the Vercel **Root Directory** at the repository root (`./`, the default). If you instead place this directory inside a larger monorepo, set **Root Directory** to the path of this directory, `posturesense-mobile`.

Use the following settings:

| Setting | Value |
| --- | --- |
| Framework preset | Vite |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node.js | 20.x or newer (20.19+) |
| Environment variables | None |

Steps:

1. Import the repository in Vercel and select the root directory as described above.
2. Confirm the build settings in the table. Leave environment variables empty.
3. Deploy. Open the HTTPS deployment URL, choose a view, start the camera, and set a comfortable reference.

No backend, Vercel Functions, database, or custom domain is required. The included [`vercel.json`](vercel.json) sets basic browser security headers, permits camera use for this site, and caches WASM files for one day. Vercel creates preview deployments for branches and pull requests.

### Vercel CLI

Run from this directory:

```bash
npm ci
npm run build
npx vercel
```

Link or create a Vercel project when prompted. For a production deploy after linking, run `npx vercel --prod`.

## Use the monitor

1. Sit comfortably in view. PostureSense adapts automatically to the camera angle.
2. Select **Start Camera** and allow camera access.
3. Select **Set Reference**. Calibration collects four seconds of clear, steady frames and then starts checking automatically. Small natural movement is okay.

PostureSense selects the usable camera angle automatically and keeps the reference in this tab's memory until you reload or close it. No backend or account is needed. Missing body areas show **Not in view** rather than being counted as good. Tracking confidence measures landmark visibility, not posture quality. If calibration is unstable, choose **Retry Reference** or **Continue Without Reference**. Continuing without a reference keeps visibility tracking on, while posture comparisons stay off; you can set a reference later at any time.

## Troubleshooting

- **Camera access is unavailable:** use HTTPS or `localhost`, allow camera access in the browser's site settings, and check that another app is not using the camera.
- **Model or WASM files fail to load:** deploy the complete repository, including `public/models` and `public/wasm`; do not publish only the generated HTML file.
- **A body area says Not in view:** improve lighting and keep your head, shoulders, and hips unobstructed in frame. Knees and ankles are tracked when visible.
- **Calibration pauses:** correct the brief on-screen framing or position hint. Progress is preserved while the view is missing or you shift too far.
- **Camera angle changes:** set a new reference after moving the camera or changing your seating setup.
- **Inference is slow:** close other heavy apps and use a recent browser. The app limits inference to about 15 frames per second to keep the camera preview responsive.
- **Camera works locally but not on a preview URL:** verify the deployment uses HTTPS and returns `Permissions-Policy: camera=(self)`.

## Project structure

```text
public/models/        MediaPipe Lite pose model
public/wasm/          MediaPipe WebAssembly runtime
src/App.vue           Camera interface and frame lifecycle
src/poseDetector.js   MediaPipe initialization and inference
src/postureLogic.js   Calibration, smoothing, and warning rules
vercel.json           Hosting headers
```

## Technology

- Vue 3
- Vite 8
- MediaPipe Tasks Vision Pose Landmarker Lite
- WebAssembly, running locally in the browser
- Vercel static hosting

This repository does not currently include a license file. Add a license before redistributing or reusing the project.
