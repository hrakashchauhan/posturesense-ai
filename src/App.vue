<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { initializePoseDetector, detectPose, closePoseDetector } from './poseDetector.js'
import { PostureMonitor } from './postureLogic.js'

const video = ref(null)
const canvas = ref(null)
const cameraActive = ref(false)
const cameraFacing = ref('user')
const aiActive = ref(false)
const aiInitializing = ref(false)
const errorMessage = ref('')
const postureState = ref('idle')
const postureMessage = ref('Start the camera, then set your sitting reference.')
const bodyParts = ref([])
const calibProgress = ref(0)
const trackingConfidence = ref(0)
const referenceVersion = ref(0)
const calibrationPaused = ref(false)

const monitor = new PostureMonitor()
monitor.enableAutomaticView()
let stream = null
let animationId = null
let lastVideoTime = -1
let lastInferenceAt = 0
let cameraRequestId = 0
let aiStartRequestId = 0
let detectorReady = false
const INFERENCE_INTERVAL_MS = 1000 / 15
const CAMERA_REQUEST_TIMEOUT_MS = 15000
const connections = [
  [0, 7], [0, 8], [7, 11], [8, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 29],
  [29, 31], [28, 30], [30, 32]
]

const isCalibrated = computed(() => {
  referenceVersion.value
  postureState.value
  return !monitor.referenceFree && monitor.hasReference()
})
const isInCalibration = computed(() => postureState.value === 'calibrating')
const statusTitle = computed(() => ({
  idle: 'Ready to start camera',
  'not-calibrated': 'Set your reference',
  calibrating: 'Finding your reference',
  'calibration-review': 'Reference needs another try',
  'reference-free': 'Monitoring without reference',
  ready: 'Reference saved',
  'on-track': 'ON TRACK',
  checking: 'CHECKING',
  adjust: 'ADJUST',
  'view-needed': 'VIEW NEEDED'
}[postureState.value] ?? 'PostureSense'))

const progressPercent = computed(() => Math.min(100, calibProgress.value))
const referenceBadge = computed(() => {
  if (postureState.value === 'calibration-review') return 'REFERENCE NEEDS RETRY'
  if (postureState.value === 'reference-free') return 'VISIBILITY ONLY'
  if (isInCalibration.value) return `SETTING · ${progressPercent.value}%`
  if (calibrationPaused.value) return `PAUSED · ${progressPercent.value}%`
  if (isCalibrated.value) return 'REFERENCE SET'
  return 'ABOUT 4 SECONDS'
})
const referenceStepHelp = computed(() => {
  if (postureState.value === 'calibration-review') return 'The sample was unsteady. Retry while sitting comfortably.'
  if (postureState.value === 'reference-free') return 'Camera tracking is on. Set a reference whenever you want posture comparisons.'
  if (isInCalibration.value) return 'Stay comfortable; small movement is okay. Progress pauses if tracking is unclear.'
  if (calibrationPaused.value) return `Progress is saved at ${progressPercent.value}%. Start the camera to continue.`
  if (isCalibrated.value) return 'Saved in this tab session. PostureSense is using this reference now.'
  if (aiActive.value) return 'Tap Set Reference to begin a four-second check.'
  return 'Start the camera, then tap Set Reference.'
})
async function startCamera() {
  errorMessage.value = ''
  const requestId = ++cameraRequestId

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access needs HTTPS or localhost.')
    }

    const cameraRequest = navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: cameraFacing.value },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    })
    // Some browsers leave getUserMedia pending indefinitely when a permission
    // prompt is hidden. Bound the wait and stop any stream granted after timeout.
    cameraRequest.then(lateStream => {
      if (requestId !== cameraRequestId || !video.value) {
        lateStream.getTracks().forEach(track => track.stop())
      }
    }).catch(() => {})
    let timeoutId
    const nextStream = await Promise.race([
      cameraRequest,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const timeout = new Error('Camera permission is taking too long. Check the browser prompt or site settings, then try again.')
          timeout.name = 'CameraTimeoutError'
          reject(timeout)
        }, CAMERA_REQUEST_TIMEOUT_MS)
      })
    ]).finally(() => clearTimeout(timeoutId))

    if (requestId !== cameraRequestId || !video.value) {
      nextStream.getTracks().forEach(track => track.stop())
      return false
    }

    stream = nextStream
    video.value.srcObject = nextStream
    await video.value.play()
    if (requestId !== cameraRequestId) return false

    cameraActive.value = true
    nextStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (stream !== nextStream) return
      stopCamera()
      errorMessage.value = 'The camera stopped. Start it again to continue.'
    }, { once: true })
    return true
  } catch (error) {
    if (requestId !== cameraRequestId) return false
    cameraRequestId++
    stream?.getTracks().forEach(track => track.stop())
    stream = null
    if (video.value) video.value.srcObject = null
    cameraActive.value = false
    errorMessage.value = error.name === 'NotAllowedError'
      ? 'Camera permission was blocked. Allow access in your browser settings.'
      : error.message || 'Could not start the camera.'
    return false
  }
}

async function startMonitoring() {
  if (aiInitializing.value || aiActive.value) return
  const requestId = ++aiStartRequestId
  errorMessage.value = ''
  aiInitializing.value = true

  if (!cameraActive.value && !await startCamera()) {
    aiInitializing.value = false
    return
  }

  try {
    await initializePoseDetector()
    if (requestId !== aiStartRequestId || !cameraActive.value) return
    detectorReady = true
    aiActive.value = true
    aiInitializing.value = false
    calibrationPaused.value = false
    lastVideoTime = -1
    lastInferenceAt = 0
    postureState.value = monitor.calibrationReview
      ? 'calibration-review'
      : monitor.calibrating
      ? 'calibrating'
      : monitor.referenceFree ? 'reference-free'
      : monitor.hasReference() ? 'on-track' : 'not-calibrated'
    postureMessage.value = monitor.calibrating
      ? 'Calibration will continue when your head and shoulders are visible.'
      : monitor.referenceFree
        ? 'Tracking body visibility only. Set a reference any time to compare posture changes.'
      : monitor.hasReference()
        ? 'Using your saved sitting reference.'
        : 'Keep your head, shoulders, and hips in view to set a reference.'
    animationId = requestAnimationFrame(processFrame)
  } catch (error) {
    if (requestId !== aiStartRequestId) return
    aiActive.value = false
    aiInitializing.value = false
    postureState.value = 'idle'
    errorMessage.value = `Could not load posture tracking: ${error.message}`
  }
}

function startCalibration() {
  if (!aiActive.value) return
  calibrationPaused.value = false
  monitor.startCalibration()
  postureState.value = 'calibrating'
  postureMessage.value = 'Keep your head and shoulders in view. Small movements are fine.'
  calibProgress.value = 0
}

function retryCalibration() {
  if (!aiActive.value) return
  calibrationPaused.value = false
  monitor.retryCalibration()
  postureState.value = 'calibrating'
  postureMessage.value = 'Retrying. Keep your head and shoulders in view.'
  calibProgress.value = 0
}

function continueWithoutReference() {
  if (!aiActive.value) return
  calibrationPaused.value = false
  monitor.continueWithoutReference()
  postureState.value = 'reference-free'
  postureMessage.value = 'Tracking body visibility only. Set a reference any time to compare posture changes.'
  calibProgress.value = 0
}

function clearCanvas() {
  const context = canvas.value?.getContext('2d')
  if (context && canvas.value) context.clearRect(0, 0, canvas.value.width, canvas.value.height)
}

function drawPose(landmarks) {
  const element = canvas.value
  const context = element?.getContext('2d')
  if (!context || !video.value) return
  const width = video.value.videoWidth
  const height = video.value.videoHeight
  if (!width || !height) return
  if (element.width !== width || element.height !== height) {
    element.width = width
    element.height = height
  }

  context.clearRect(0, 0, width, height)
  const visible = index => landmarks[index] && (landmarks[index].visibility ?? 0) >= 0.5
  const joints = landmarks.filter(point => (point.visibility ?? 0) >= 0.5)
  const stateColor = postureState.value === 'adjust' ? '#d64c3f'
    : postureState.value === 'checking' ? '#e3a629' : '#38d79a'
  context.lineWidth = Math.max(2, width / 360)
  context.strokeStyle = stateColor
  context.fillStyle = '#fff8e8'
  for (const [a, b] of connections) {
    if (!visible(a) || !visible(b)) continue
    context.beginPath()
    context.moveTo(landmarks[a].x * width, landmarks[a].y * height)
    context.lineTo(landmarks[b].x * width, landmarks[b].y * height)
    context.stroke()
  }
  for (const point of joints) {
    context.beginPath()
    context.arc(point.x * width, point.y * height, Math.max(3, width / 180), 0, Math.PI * 2)
    context.fill()
  }
}

function updateFromResult(result) {
  if (result.state === 'ready') referenceVersion.value++
  postureState.value = result.state
  postureMessage.value = result.message
  bodyParts.value = result.bodyParts
  calibProgress.value = result.calibrationProgress ?? calibProgress.value
  trackingConfidence.value = result.confidence ?? 0

}

function processFrame() {
  if (!aiActive.value || !video.value) return
  const now = performance.now()
  if (
    video.value.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.value.currentTime !== lastVideoTime &&
    now - lastInferenceAt >= INFERENCE_INTERVAL_MS
  ) {
    lastVideoTime = video.value.currentTime
    lastInferenceAt = now
    try {
      const result = detectPose(video.value)
      if (result?.detected) {
        drawPose(result.landmarks)
        updateFromResult(monitor.update(result.landmarks, performance.now()))
      } else {
        clearCanvas()
        updateFromResult(monitor.update(null, performance.now()))
      }
    } catch (error) {
      stopMonitoring()
      errorMessage.value = `Posture tracking stopped: ${error.message}`
    }
  }
  if (aiActive.value) animationId = requestAnimationFrame(processFrame)
}

function stopMonitoring() {
  aiStartRequestId++
  aiActive.value = false
  aiInitializing.value = false
  calibrationPaused.value = monitor.calibrating
  if (animationId !== null) cancelAnimationFrame(animationId)
  animationId = null
  clearCanvas()
  postureState.value = 'idle'
  postureMessage.value = 'Start the camera to continue.'
}

function stopCamera() {
  cameraRequestId++
  stopMonitoring()
  stream?.getTracks().forEach(track => track.stop())
  stream = null
  if (video.value) video.value.srcObject = null
  cameraActive.value = false
}

async function switchCamera() {
  const wasRunning = aiActive.value
  const wasCameraActive = cameraActive.value
  stopCamera()
  cameraFacing.value = cameraFacing.value === 'user' ? 'environment' : 'user'
  if (wasCameraActive && await startCamera() && wasRunning) await startMonitoring()
}

onBeforeUnmount(() => {
  stopCamera()
  if (detectorReady) {
    closePoseDetector()
    detectorReady = false
  }
})
</script>

<template>
  <main class="app">
    <header class="topbar">
      <div class="logo" aria-hidden="true">P</div>
      <div class="brand"><strong>PostureSense</strong><span>Simple posture check-ins</span></div>
      <div class="privacy-badge"><span class="privacy-dot"></span>CAMERA STAYS HERE</div>
    </header>

    <div class="workspace">
      <section class="video-column" aria-label="Posture camera view">
        <div class="view-picker" aria-label="Camera framing guidance">
          <span class="step-mark">1</span><div><b>Sit comfortably in view</b><small>Face the camera. PostureSense adapts to your camera angle.</small></div>
          <span class="auto-pill">ANGLE AUTO</span>
        </div>

        <div class="camera-frame" :class="{ active: cameraActive }">
          <video ref="video" autoplay muted playsinline :class="{ mirror: cameraFacing === 'user' }" aria-label="Live camera preview"></video>
          <canvas v-show="aiActive" ref="canvas" class="pose-canvas" :class="{ mirror: cameraFacing === 'user' }" aria-hidden="true"></canvas>
          <div v-if="!cameraActive" class="camera-empty">
            <div class="camera-symbol">◉</div><h1>Sit comfortably</h1>
            <p>Start the camera when you’re ready. Your video stays on this device.</p>
          </div>
          <div v-if="cameraActive && !aiActive" class="camera-hint">FACE THE CAMERA · KEEP YOUR UPPER BODY IN VIEW</div>
          <div v-if="aiActive" class="camera-badge"><span></span>{{ postureState === 'view-needed' ? 'BODY VIEW NEEDED' : 'POSTURE CHECK ON' }}</div>
        </div>

        <div class="camera-actions">
          <button v-if="!aiActive" class="button button-primary" :disabled="aiInitializing" @click="startMonitoring">
            <span class="step-mark">2</span>{{ aiInitializing ? 'OPENING CAMERA…' : calibrationPaused ? 'RESUME CALIBRATION' : cameraActive ? 'RESUME CHECK' : 'START CAMERA' }}
          </button>
          <button v-else class="button button-soft" @click="stopMonitoring">PAUSE CHECK</button>
          <button class="button button-quiet" :disabled="aiInitializing" @click="switchCamera">FLIP CAMERA</button>
        </div>

        <div v-if="errorMessage" class="error-banner" role="alert">{{ errorMessage }}</div>
        <p class="privacy-note">Posture tracking runs in your browser. No video is uploaded or saved.</p>
      </section>

      <aside class="side-rail" aria-label="Three step setup and posture status">
        <section class="step-card" aria-labelledby="step-three-title">
          <div class="rail-title"><span class="eyebrow">THREE QUICK STEPS</span><span class="duration-pill" :class="{ 'reference-set-pill': isCalibrated && !isInCalibration }">{{ referenceBadge }}</span></div>
          <div class="step-row"><span class="step-mark">1</span><div><b>Sit comfortably</b><small>Face the camera; no view setting needed.</small></div></div>
          <div class="step-row"><span class="step-mark">2</span><div><b>Start the camera</b><small>Keep head, shoulders, and hips visible.</small></div></div>
          <div class="step-row step-row-current"><span class="step-mark">3</span><div><b id="step-three-title">{{ isCalibrated ? 'Reference is set' : 'Set your reference' }}</b><small>{{ referenceStepHelp }}</small></div></div>

          <div class="reference-actions">
            <button v-if="postureState !== 'calibration-review'" class="button button-calibrate" :disabled="!aiActive || isInCalibration" @click="startCalibration">
              <span class="step-mark">3</span>{{ isInCalibration ? `SETTING · ${progressPercent}%` : calibrationPaused ? 'CALIBRATION PAUSED' : isCalibrated ? 'RECALIBRATE' : 'SET REFERENCE' }}
            </button>
            <button v-else class="button button-calibrate" :disabled="!aiActive" @click="retryCalibration">RETRY REFERENCE</button>
            <button v-if="!isCalibrated || isInCalibration || postureState === 'calibration-review'" class="button button-skip" :disabled="!aiActive" @click="continueWithoutReference">CONTINUE WITHOUT REFERENCE</button>
            <button v-if="isInCalibration" class="text-button" @click="stopMonitoring">Pause and keep progress</button>
          </div>

          <div v-if="isInCalibration || calibrationPaused || postureState === 'calibration-review'" class="calibration-meter">
            <div class="meter-track"><span :style="{ width: `${progressPercent}%` }"></span></div>
            <div class="meter-caption"><span>{{ postureState === 'calibration-review' ? 'READY TO RETRY' : calibrationPaused ? 'PAUSED · PROGRESS SAVED' : 'STEADY FRAMES COLLECTED' }}</span><b>{{ progressPercent }}%</b></div>
          </div>

          <details class="setup-details">
            <summary>Quick setup tips</summary>
            <p>Sit with feet supported, hips resting back, shoulders relaxed and screen near eye level. Your reference stays in this tab until you reload or close it; no account or backend is needed.</p>
          </details>
        </section>

        <section class="result-card" :class="`result-${postureState}`" aria-live="polite" aria-atomic="true">
          <div class="result-heading"><span class="eyebrow">POSTURE STATUS</span></div>
          <h2>{{ statusTitle }}</h2>
          <p v-if="postureState !== 'adjust'" class="result-message">{{ postureMessage }}</p>
          <div class="confidence-row">
            <span>TRACKING CONFIDENCE <small>visibility quality</small></span>
            <b>{{ aiActive ? `${trackingConfidence}%` : '—' }}</b>
          </div>
          <div class="confidence-track" aria-hidden="true"><span :style="{ width: `${aiActive ? trackingConfidence : 0}%` }"></span></div>
          <div v-if="postureState === 'adjust'" class="action-line"><b>CORRECT THIS</b><span>{{ postureMessage }}</span></div>
          <div class="part-list" aria-label="Body area tracking status">
            <div v-for="part in bodyParts" :key="part.id" class="part-row" :class="`part-${part.state}`">
              <span class="part-indicator" aria-hidden="true"></span>
              <b>{{ part.label }}</b>
              <span>{{ part.state === 'on-track' ? 'ON TRACK' : part.state === 'checking' ? 'CHECKING' : part.state === 'adjust' ? 'ADJUST' : part.state === 'not-in-view' ? 'NOT IN VIEW' : 'WAITING' }}</span>
            </div>
          </div>
          <p class="scope-note">Confidence measures camera visibility, not whether your posture is good or bad. {{ postureState === 'reference-free' ? 'Posture comparisons are off until you set a reference.' : 'Results are guidance against your reference.' }}</p>
        </section>
      </aside>
    </div>
    <footer class="app-footer"><span>POSTURESENSE</span><span>Move often. Find a position that feels good.</span></footer>
  </main>
</template>
