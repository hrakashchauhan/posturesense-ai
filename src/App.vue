
<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import {
  initializePoseDetector,
  detectPose,
  closePoseDetector
} from './poseDetector.js'
import { PostureMonitor } from './postureLogic.js'

// ── DOM refs ──────────────────────────────────────────────
const video = ref(null)
const canvas = ref(null)

// ── Reactive state ────────────────────────────────────────
const cameraActive   = ref(false)
const aiActive       = ref(false)
const cameraFacing   = ref('user')
const errorMessage   = ref('')
const aiInitializing = ref(false)
const postureState   = ref('idle')
const postureMessage = ref('Start monitoring to begin.')
const inferenceMs    = ref(0)
const visibleLandmarks = ref(0)
const metrics        = ref(null)
const calibProgress  = ref(0)        // 0–100 during calibration
const isCalibrated   = ref(false)

// ── Internal state ────────────────────────────────────────
const monitor       = new PostureMonitor()
let stream          = null
let animationId     = null
let lastVideoTime   = -1
let detectorReady   = false
let lastVibrationAt = 0

// ── Skeleton connections (MediaPipe body joints) ──────────
const connections = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [24, 26], [26, 28], [27, 29], [29, 31], [28, 30], [30, 32]
]

// ── Derived state ─────────────────────────────────────────
const stateClass = computed(() => {
  if (postureState.value === 'monitoring' || postureState.value === 'ready') return 'state-good'
  if (postureState.value === 'warning')     return 'state-warning'
  if (postureState.value === 'calibrating') return 'state-calibrating'
  return 'state-idle'
})

const statusIcon = computed(() => {
  switch (postureState.value) {
    case 'monitoring': return '✓'
    case 'ready':      return '✓'
    case 'warning':    return '!'
    case 'calibrating': return '◎'
    case 'unavailable': return '⌁'
    default:           return '◎'
  }
})

const headShiftClass = computed(() => {
  if (!metrics.value?.headShift) return ''
  return metrics.value.headShift > 0.16 ? 'warn' : 'good'
})

const shoulderClass = computed(() => {
  if (!metrics.value?.shoulderChange) return ''
  return metrics.value.shoulderChange > 12 ? 'warn' : 'good'
})

// Head shift formatted for display (no units on number)
const headShiftDisplay = computed(() => {
  if (metrics.value?.headShift == null) return '—'
  return metrics.value.headShift.toFixed(3)
})

const shoulderDisplay = computed(() => {
  if (metrics.value?.shoulderChange == null) return '—'
  return `${metrics.value.shoulderChange.toFixed(1)}`
})

// Duration of current bad posture in seconds
const badDuration = ref(0)
let badDurationInterval = null

// ── Camera actions ────────────────────────────────────────
async function startCamera() {
  errorMessage.value = ''

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access requires HTTPS or localhost.')
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: cameraFacing.value },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      }
    })

    video.value.srcObject = stream
    await video.value.play()
    cameraActive.value = true
  } catch (error) {
    stream?.getTracks().forEach(t => t.stop())
    stream = null
    errorMessage.value = error.name === 'NotAllowedError'
      ? 'Camera permission denied. Allow camera access in browser settings.'
      : error.message || 'Unable to open camera.'
  }
}

function stopAI() {
  aiActive.value = false

  if (animationId !== null) cancelAnimationFrame(animationId)
  animationId = null

  clearCanvas()
  monitor.reset()

  postureState.value   = 'idle'
  postureMessage.value = 'Start monitoring to begin.'
  metrics.value        = null
  visibleLandmarks.value = 0
  inferenceMs.value    = 0
  calibProgress.value  = 0
  isCalibrated.value   = false
  badDuration.value    = 0
  clearInterval(badDurationInterval)
  badDurationInterval  = null
}

function stopCamera() {
  stopAI()
  stream?.getTracks().forEach(t => t.stop())
  stream = null
  if (video.value) video.value.srcObject = null
  cameraActive.value = false
}

async function switchCamera() {
  const wasRunning = aiActive.value
  const wasCamera  = cameraActive.value
  stopCamera()
  cameraFacing.value = cameraFacing.value === 'user' ? 'environment' : 'user'
  if (wasCamera) {
    await startCamera()
    if (wasRunning && cameraActive.value) await startAI()
  }
}

async function startAI() {
  errorMessage.value = ''
  aiInitializing.value = true

  if (!cameraActive.value) {
    await startCamera()
    if (!cameraActive.value) {
      aiInitializing.value = false
      return
    }
  }

  try {
    postureState.value   = 'idle'
    postureMessage.value = 'AI INITIALIZING…'

    await initializePoseDetector()
    detectorReady = true

    monitor.reset()
    aiActive.value    = true
    lastVideoTime     = -1
    aiInitializing.value = false

    postureState.value   = 'not-calibrated'
    postureMessage.value = 'Sit upright and press CALIBRATE to set your baseline.'

    animationId = requestAnimationFrame(processFrame)
  } catch (error) {
    aiActive.value       = false
    aiInitializing.value = false
    postureState.value   = 'idle'
    errorMessage.value   = `Could not load pose detector: ${error.message}`
  }
}

function startCalibration() {
  if (!aiActive.value) return
  monitor.startCalibration(performance.now())
  postureState.value   = 'calibrating'
  postureMessage.value = 'Hold your natural upright position…'
  metrics.value        = null
  calibProgress.value  = 0
  isCalibrated.value   = false
}

// ── Canvas helpers ────────────────────────────────────────
function clearCanvas() {
  const ctx = canvas.value?.getContext('2d')
  if (ctx) ctx.clearRect(0, 0, canvas.value.width, canvas.value.height)
}

function drawPose(landmarks) {
  const el  = canvas.value
  const ctx = el?.getContext('2d')
  if (!ctx || !video.value) return

  const w = video.value.videoWidth
  const h = video.value.videoHeight
  if (!w || !h) return

  if (el.width !== w || el.height !== h) {
    el.width  = w
    el.height = h
  }

  ctx.clearRect(0, 0, w, h)

  const good    = landmarks.filter(p => p.visibility > 0.5)
  visibleLandmarks.value = good.length

  const visible = i => landmarks[i] && (landmarks[i].visibility ?? 0) > 0.5

  // Choose skeleton color by state
  const isWarning = postureState.value === 'warning'
  const lineColor = isWarning ? '#ef4444' : '#39ff8a'
  const dotColor  = isWarning ? '#fca5a5' : '#ffffff'

  ctx.lineWidth   = Math.max(2, w / 350)
  ctx.strokeStyle = lineColor
  ctx.fillStyle   = dotColor

  // Draw limb connections
  for (const [a, b] of connections) {
    if (!visible(a) || !visible(b)) continue
    ctx.beginPath()
    ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h)
    ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h)
    ctx.stroke()
  }

  // Draw joint dots
  const dotR = Math.max(3, w / 160)
  for (const point of good) {
    ctx.beginPath()
    ctx.arc(point.x * w, point.y * h, dotR, 0, Math.PI * 2)
    ctx.fill()
  }
}

// ── Main frame loop ───────────────────────────────────────
function processFrame() {
  if (!aiActive.value || !video.value) return

  if (
    video.value.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.value.currentTime !== lastVideoTime
  ) {
    lastVideoTime = video.value.currentTime
    const t0 = performance.now()

    try {
      const result = detectPose(video.value)
      inferenceMs.value = Math.round(performance.now() - t0)

      if (result?.detected) {
        drawPose(result.landmarks)

        const r = monitor.update(result.landmarks, performance.now())

        postureState.value   = r.state
        postureMessage.value = r.message
        metrics.value        = r.metrics

        // Calibration progress
        if (r.state === 'calibrating' && r.message.includes('%')) {
          const m = r.message.match(/(\d+)%/)
          calibProgress.value = m ? parseInt(m[1]) : calibProgress.value
        }

        if (r.state === 'ready') {
          isCalibrated.value   = true
          calibProgress.value  = 100
          postureMessage.value = 'Calibration complete — monitoring posture.'
        }

        // Bad duration tracking
        if (r.state === 'warning') {
          if (!badDurationInterval) {
            badDuration.value = 0
            badDurationInterval = setInterval(() => { badDuration.value++ }, 1000)
          }
          // Vibration every 30 s
          const now = performance.now()
          if (now - lastVibrationAt >= 30000) {
            navigator.vibrate?.([180, 100, 180])
            lastVibrationAt = now
          }
        } else {
          if (badDurationInterval) {
            clearInterval(badDurationInterval)
            badDurationInterval = null
            badDuration.value   = 0
          }
        }
      } else {
        clearCanvas()
        visibleLandmarks.value = 0

        const r = monitor.update(null, performance.now())
        postureState.value   = r.state
        postureMessage.value = r.message
        metrics.value        = null
      }
    } catch (error) {
      stopAI()
      errorMessage.value = `Pose detection error: ${error.message}`
    }
  }

  if (aiActive.value) {
    animationId = requestAnimationFrame(processFrame)
  }
}

// ── Cleanup ───────────────────────────────────────────────
onBeforeUnmount(() => {
  stopCamera()
  clearInterval(badDurationInterval)
  if (detectorReady) {
    closePoseDetector()
    detectorReady = false
  }
})
</script>

<template>
  <main class="app" role="main">

    <!-- ══ Topbar ══════════════════════════════════════════ -->
    <header class="topbar" role="banner">
      <div class="logo" aria-hidden="true">P</div>
      <div class="brand">
        <strong>PostureSense AI</strong>
        <span class="brand-sub">Real-Time Posture Monitor</span>
      </div>
      <div class="topbar-right">
        <div class="privacy-badge" aria-label="Private — data stays on device">
          <div class="privacy-dot"></div>
          PRIVATE
        </div>
      </div>
    </header>

    <!-- ══ Dashboard grid ═════════════════════════════════ -->
    <div class="dashboard">

      <!-- ── Left: Camera panel ─────────────────────────── -->
      <section class="camera-panel" aria-label="Camera and pose detection">

        <!-- Panel header -->
        <div class="panel-header">
          <div>
            <div class="section-label">Live Monitor</div>
            <div class="panel-title">Camera &amp; Pose Detection</div>
          </div>
          <div
            class="cam-status"
            :class="{ active: cameraActive }"
            role="status"
            :aria-label="cameraActive ? 'Camera connected' : 'Camera offline'"
          >
            <div class="cam-status-dot"></div>
            {{ cameraActive ? 'CAMERA ON' : 'CAMERA OFF' }}
          </div>
        </div>

        <!-- Camera frame -->
        <div class="camera-frame" :class="{ 'cam-active': cameraActive }">
          <video
            ref="video"
            autoplay
            muted
            playsinline
            :class="{ mirror: cameraFacing === 'user' }"
            aria-label="Live camera preview"
          ></video>

          <canvas
            v-show="aiActive"
            ref="canvas"
            class="pose-canvas"
            :class="{ mirror: cameraFacing === 'user' }"
            aria-hidden="true"
          ></canvas>

          <!-- Empty state -->
          <div v-if="!cameraActive" class="cam-empty" aria-live="polite">
            <div class="cam-icon" aria-hidden="true">⌁</div>
            <h3>No Camera Feed</h3>
            <p>Press START MONITORING below. Position your head and both shoulders in frame.</p>
          </div>

          <!-- Framing guide (camera on, AI not started or calibrating) -->
          <div
            v-if="cameraActive && (!aiActive || postureState === 'calibrating' || postureState === 'not-calibrated')"
            class="frame-guide"
            aria-hidden="true"
          >
            <span class="frame-guide-label">KEEP HEAD &amp; SHOULDERS IN FRAME</span>
          </div>

          <!-- AI active badge -->
          <div v-if="aiActive" class="ai-badge" role="status" aria-label="AI pose detection active">
            <div class="ai-badge-dot" aria-hidden="true"></div>
            POSE DETECTED
          </div>

          <!-- AI initializing badge -->
          <div v-if="aiInitializing && !aiActive" class="ai-badge" role="status">
            <div class="ai-badge-dot" aria-hidden="true"></div>
            AI INITIALIZING
          </div>

          <!-- Inference latency -->
          <div v-if="aiActive" class="latency-badge" aria-label="Inference latency">
            <span>{{ inferenceMs }}</span> ms
          </div>
        </div>

        <!-- Controls -->
        <div class="controls" role="group" aria-label="Camera controls">
          <!-- START / STOP MONITORING (primary action) -->
          <button
            v-if="!aiActive"
            id="btn-start-monitoring"
            class="btn btn-primary"
            :disabled="aiInitializing"
            @click="startAI"
            aria-label="Start AI monitoring"
          >
            <span class="btn-icon">▶</span>
            {{ aiInitializing ? 'INITIALIZING…' : 'START MONITORING' }}
          </button>
          <button
            v-else
            id="btn-stop-monitoring"
            class="btn btn-danger"
            @click="stopAI"
            aria-label="Stop AI monitoring"
          >
            <span class="btn-icon">■</span>
            STOP MONITORING
          </button>

          <!-- CAMERA TOGGLE (only shown when AI is off) -->
          <button
            v-if="!aiActive && cameraActive"
            id="btn-stop-camera"
            class="btn btn-ghost"
            @click="stopCamera"
            aria-label="Turn off camera"
          >
            CAMERA OFF
          </button>

          <!-- FLIP CAMERA -->
          <button
            id="btn-flip-camera"
            class="btn btn-ghost"
            @click="switchCamera"
            aria-label="Switch front/rear camera"
          >
            <span class="btn-icon">⇄</span>
            FLIP
          </button>
        </div>

        <!-- Error banner -->
        <div v-if="errorMessage" class="error-banner" role="alert" aria-live="assertive">
          <span class="error-icon" aria-hidden="true">⚠</span>
          {{ errorMessage }}
        </div>

        <!-- Privacy note -->
        <div class="privacy-note">
          <span aria-hidden="true">🔒</span>
          Inference runs entirely in your browser — no video is uploaded.
        </div>

      </section>

      <!-- ── Right: Telemetry + Calibration ─────────────── -->
      <aside class="right-panel" aria-label="Posture status and telemetry">

        <!-- Status card -->
        <div class="status-card" :class="stateClass" aria-live="polite">
          <div class="section-label">Posture Status</div>
          <div class="status-state-row">
            <div class="status-icon-block" aria-hidden="true">{{ statusIcon }}</div>
            <div>
              <div class="status-label">
                {{ postureState.toUpperCase().replace('-', ' ') }}
              </div>
              <div class="status-message">{{ postureMessage }}</div>
            </div>
          </div>

          <!-- Calibration progress bar -->
          <div v-if="postureState === 'calibrating'" class="calib-bar-wrap" role="progressbar" :aria-valuenow="calibProgress" aria-valuemin="0" aria-valuemax="100">
            <div class="calib-bar" :style="{ width: calibProgress + '%' }"></div>
          </div>
        </div>

        <!-- Telemetry card -->
        <div class="telemetry-card">
          <div class="section-label">Telemetry</div>

          <div class="telemetry-row">
            <!-- Head displacement -->
            <div class="telem-item">
              <div class="telem-label">Head Shift</div>
              <div class="telem-value" :class="headShiftClass">
                {{ headShiftDisplay }}
              </div>
              <div class="telem-sub">relative to baseline</div>
            </div>

            <!-- Landmarks -->
            <div class="telem-item">
              <div class="telem-label">Landmarks</div>
              <div class="telem-value" :class="aiActive && visibleLandmarks > 0 ? 'good' : ''">
                {{ aiActive ? visibleLandmarks : '—' }}
              </div>
              <div class="telem-sub">visible joints</div>
            </div>
          </div>

          <div class="telemetry-row">
            <!-- Shoulder tilt -->
            <div class="telem-item">
              <div class="telem-label">Shoulder Δ</div>
              <div class="telem-value" :class="shoulderClass">
                {{ shoulderDisplay }}<span v-if="metrics?.shoulderChange != null" class="telem-unit">°</span>
              </div>
              <div class="telem-sub">tilt from baseline</div>
            </div>

            <!-- Warning duration -->
            <div class="telem-item">
              <div class="telem-label">Bad Posture</div>
              <div class="telem-value" :class="badDuration > 0 ? 'warn' : ''">
                {{ badDuration > 0 ? badDuration : '—' }}<span v-if="badDuration > 0" class="telem-unit">s</span>
              </div>
              <div class="telem-sub">sustained duration</div>
            </div>
          </div>

          <!-- Deviation details when warning -->
          <div v-if="postureState === 'warning' && metrics" class="deviation-row">
            <div
              class="deviation-item"
              :class="{ active: (metrics.headShift ?? 0) > 0.16 }"
            >
              <span class="dev-icon" aria-hidden="true">⟷</span>
              Head position
              <span class="dev-val">{{ metrics.headShift?.toFixed(3) ?? '—' }}</span>
            </div>
            <div
              class="deviation-item"
              :class="{ active: (metrics.shoulderChange ?? 0) > 12 }"
            >
              <span class="dev-icon" aria-hidden="true">↗</span>
              Shoulder tilt
              <span class="dev-val">{{ metrics.shoulderChange?.toFixed(1) ?? '—' }}°</span>
            </div>
            <div class="deviation-item" style="font-size:10px; color: #fde68a; border-color: var(--amber-dim);">
              ↩ Sit upright and relax your shoulders to recover.
            </div>
          </div>
        </div>

        <!-- Calibration panel -->
        <div class="calib-panel">
          <div class="section-label">Calibration</div>
          <div class="calib-title">Set Your Posture Baseline</div>
          <p class="calib-desc">
            Sit comfortably upright. Keep your head and both shoulders visible in the camera. Press Calibrate — the AI will record your natural position over 10 seconds.
          </p>

          <div
            class="calib-status-line"
            :class="{ calibrated: isCalibrated }"
            aria-live="polite"
          >
            <div class="dot"></div>
            {{ isCalibrated ? 'BASELINE SET' : 'NOT CALIBRATED' }}
          </div>

          <button
            id="btn-calibrate"
            class="btn btn-calibrate"
            :disabled="!aiActive || postureState === 'calibrating'"
            @click="startCalibration"
            :aria-label="isCalibrated ? 'Recalibrate posture baseline' : 'Calibrate posture baseline'"
          >
            <span class="btn-icon">◎</span>
            {{ isCalibrated ? 'RECALIBRATE' : 'CALIBRATE' }}
          </button>
        </div>

      </aside>
    </div>

    <!-- ══ Footer ══════════════════════════════════════════ -->
    <footer class="app-footer" role="contentinfo">
      <span class="footer-brand">POSTURESENSE AI</span>
      <span class="footer-note">Private by design · All inference is local</span>
    </footer>

  </main>
</template>
