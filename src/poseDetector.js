
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'

let poseLandmarker = null
let initializationPromise = null

export async function initializePoseDetector() {
  if (poseLandmarker) return poseLandmarker
  if (initializationPromise) return initializationPromise

  initializationPromise = (async () => {
    const assetBase = import.meta.env.BASE_URL
    const vision = await FilesetResolver.forVisionTasks(`${assetBase}wasm`)

    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `${assetBase}models/pose_landmarker_lite.task`,
        delegate: 'CPU'
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false
    })

    return poseLandmarker
  })().catch(error => {
    initializationPromise = null
    throw error
  })

  return initializationPromise
}

export function detectPose(videoElement) {
  if (!poseLandmarker) {
    throw new Error('Pose detector has not been initialized.')
  }

  if (
    !videoElement ||
    videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    videoElement.videoWidth === 0
  ) {
    return null
  }

  const result = poseLandmarker.detectForVideo(videoElement, performance.now())
  const landmarks = result.landmarks?.[0]

  if (!landmarks?.length) {
    return { detected: false, landmarks: [] }
  }

  return {
    detected: true,
    landmarks: landmarks.map((point, index) => ({
      index,
      x: point.x,
      y: point.y,
      z: point.z,
      visibility: point.visibility ?? 0
    }))
  }
}

export function closePoseDetector() {
  poseLandmarker?.close()
  poseLandmarker = null
  initializationPromise = null
}
