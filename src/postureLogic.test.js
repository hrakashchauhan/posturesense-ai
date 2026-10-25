import assert from 'node:assert/strict'
import test from 'node:test'
import { PostureMonitor } from './postureLogic.js'

function point(x, y, z = 0, visibility = 1) {
  return { x, y, z, visibility }
}

function frontPose(options = {}) {
  const {
    noseX = 0.5, noseY = 0.2, noseZ = 0,
    leftShoulderY = 0.3, rightShoulderY = 0.3,
    shoulderShift = 0, noseShift = 0,
    leftHipY = 0.55, rightHipY = 0.55,
    rightKneeY = 0.72, rightAnkleY = 0.9,
    hide = []
  } = options
  const landmarks = Array.from({ length: 33 }, () => point(0.5, 0.5, 0, 0))
  landmarks[0] = point(noseX + noseShift, noseY, noseZ)
  landmarks[7] = point(0.48 + noseShift, 0.18)
  landmarks[8] = point(0.52 + noseShift, 0.18)
  landmarks[11] = point(0.4 + shoulderShift, leftShoulderY)
  landmarks[12] = point(0.6 + shoulderShift, rightShoulderY)
  landmarks[23] = point(0.43, leftHipY)
  landmarks[24] = point(0.57, rightHipY)
  landmarks[25] = point(0.43, 0.72)
  landmarks[26] = point(0.57, rightKneeY)
  landmarks[27] = point(0.43, 0.9)
  landmarks[28] = point(0.57, rightAnkleY)
  for (const index of hide) landmarks[index].visibility = 0.1
  return landmarks
}

function sidePose(options = {}) {
  const {
    noseX = 0.58, earX = 0.49, shoulderX = 0.48,
    hipX = 0.49, kneeX = 0.62, kneeY = 0.53, ankleX = 0.66,
    ankleY = 0.83, hide = []
  } = options
  const landmarks = Array.from({ length: 33 }, () => point(0.5, 0.5, 0, 0.15))
  landmarks[0] = point(noseX, 0.15)
  landmarks[8] = point(earX, 0.2)
  landmarks[12] = point(shoulderX, 0.25)
  landmarks[24] = point(hipX, 0.52)
  landmarks[26] = point(kneeX, kneeY)
  landmarks[28] = point(ankleX, ankleY)
  for (const index of hide) landmarks[index].visibility = 0.1
  return landmarks
}

function calibrate(monitor, view = 'front') {
  monitor.setView(view)
  monitor.startCalibration(0)
  let result
  for (let step = 0; step <= 150; step++) {
    const now = step * 100
    result = monitor.update(view === 'front' ? frontPose() : sidePose(), now)
    if (result.state === 'ready') return now
  }
  assert.fail(`Calibration did not finish: ${result?.state} ${result?.message}`)
}

function sustained(monitor, frame, start, durationSteps = 45) {
  let result
  for (let step = 1; step <= durationSteps; step++) {
    result = monitor.update(frame, start + step * 100)
  }
  return result
}

test('front calibration saves a stable full-body reference', () => {
  const monitor = new PostureMonitor()
  const now = calibrate(monitor)
  assert.equal(monitor.hasReference('front'), true)
  assert.equal(monitor.hasReference('side'), false)
  assert.equal(monitor.update(frontPose(), now + 100).state, 'on-track')
})

test('automatic angle selection removes the need to choose front or side', () => {
  const front = new PostureMonitor()
  front.enableAutomaticView()
  front.update(frontPose({ hide: [23, 24, 25, 26, 27, 28] }), 0)
  assert.equal(front.view, 'front')
  const side = new PostureMonitor()
  side.enableAutomaticView()
  side.update(sidePose(), 0)
  assert.equal(side.view, 'side')
  side.startCalibration(0)
  let result
  for (let step = 0; step <= 60; step++) {
    result = side.update(sidePose(), step * 100)
    if (result.state === 'ready') break
  }
  assert.equal(result.state, 'ready')
  assert.equal(side.hasReference('side'), true)
})

test('four-second calibration works with upper-body framing and reports tracking confidence', () => {
  const monitor = new PostureMonitor()
  monitor.startCalibration(0)
  let result
  for (let step = 0; step <= 60; step++) {
    result = monitor.update(frontPose({ hide: [23, 24, 25, 26, 27, 28] }), step * 100)
    if (result.state === 'ready') break
  }
  assert.equal(result.state, 'ready')
  assert.ok(result.calibrationProgress === 100)
  assert.ok(result.confidence >= 90)
  assert.equal(result.bodyParts.find(part => part.id === 'torsoHips').state, 'not-in-view')
  assert.equal(result.bodyParts.find(part => part.id === 'legs').state, 'not-in-view')
})

test('side view has its own independent reference', () => {
  const monitor = new PostureMonitor()
  calibrate(monitor, 'front')
  monitor.setView('side')
  assert.equal(monitor.update(sidePose(), 9000).state, 'not-calibrated')
  calibrate(monitor, 'side')
  monitor.setView('front')
  assert.equal(monitor.update(frontPose(), 18000).state, 'on-track')
  monitor.setView('side')
  assert.equal(monitor.update(sidePose(), 18100).state, 'on-track')
})

test('small front-view movement remains on track', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor)
  let result
  for (let step = 1; step <= 50; step++) {
    result = monitor.update(frontPose({ noseX: 0.512 }), start + step * 100)
  }
  assert.equal(result.state, 'on-track')
})

test('brief movement is shown as checking and does not become an alert', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor)
  const check = sustained(monitor, frontPose({ noseX: 0.56 }), start, 12)
  assert.equal(check.state, 'checking')
  const recovered = sustained(monitor, frontPose(), start + 1200, 28)
  assert.equal(recovered.state, 'on-track')
})

test('sustained head movement identifies head and neck with an action', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor)
  const result = sustained(monitor, frontPose({ noseX: 0.56 }), start)
  assert.equal(result.state, 'adjust')
  assert.match(result.message, /HEAD & NECK/i)
  assert.match(result.message, /center/i)
  assert.ok(result.confidence >= 90)
  assert.equal(result.bodyParts.find(part => part.id === 'headNeck').state, 'adjust')
})

test('front shoulder tilt names the shoulders', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor)
  const result = sustained(monitor, frontPose({ leftShoulderY: 0.26, rightShoulderY: 0.34 }), start)
  assert.equal(result.state, 'adjust')
  assert.match(result.message, /SHOULDERS/i)
  assert.equal(result.bodyParts.find(part => part.id === 'shoulders').state, 'adjust')
})

test('front trunk shift names torso and hips', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor)
  const result = sustained(monitor, frontPose({ shoulderShift: 0.06, noseShift: 0.06 }), start)
  assert.equal(result.state, 'adjust')
  assert.match(result.message, /TORSO \/ HIPS/i)
  assert.equal(result.bodyParts.find(part => part.id === 'torsoHips').state, 'adjust')
})

test('front pelvic tilt identifies the torso and hip region', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor)
  const result = sustained(monitor, frontPose({ leftHipY: 0.51, rightHipY: 0.59 }), start)
  assert.equal(result.state, 'adjust')
  assert.match(result.message, /TORSO \/ HIPS/i)
})

test('front leg asymmetry identifies knees and ankles', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor)
  const result = sustained(monitor, frontPose({ rightKneeY: 0.78, rightAnkleY: 0.96 }), start)
  assert.equal(result.state, 'adjust')
  assert.match(result.message, /KNEES \/ ANKLES/i)
  assert.equal(result.bodyParts.find(part => part.id === 'legs').state, 'adjust')
})

test('side head-forward movement identifies head and neck', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor, 'side')
  const result = sustained(monitor, sidePose({ noseX: 0.68, earX: 0.57 }), start)
  assert.equal(result.state, 'adjust')
  assert.match(result.message, /HEAD & NECK/i)
})

test('side upper-back lean identifies shoulders and back', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor, 'side')
  const result = sustained(monitor, sidePose({ noseX: 0.65, earX: 0.56, shoulderX: 0.55 }), start)
  assert.equal(result.state, 'adjust')
  assert.match(result.message, /SHOULDERS \/ BACK/i)
})

test('side seated hip angle change identifies the hips', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor, 'side')
  const result = sustained(monitor, sidePose({ kneeX: 0.49, kneeY: 0.31, ankleX: 0.53, ankleY: 0.61 }), start)
  assert.equal(result.state, 'adjust')
  assert.match(result.message, /HIPS/i)
})

test('side lower-leg change identifies knees and ankles', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor, 'side')
  const result = sustained(monitor, sidePose({ ankleX: 0.86, ankleY: 0.62 }), start)
  assert.equal(result.state, 'adjust')
  assert.match(result.message, /KNEES \/ ANKLES/i)
})

test('warning clears after posture returns to the saved reference', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor)
  const warning = sustained(monitor, frontPose({ noseX: 0.56 }), start)
  assert.equal(warning.state, 'adjust')
  const recovered = sustained(monitor, frontPose(), start + 4500, 30)
  assert.equal(recovered.state, 'on-track')
})

test('missing legs are called out while visible posture remains checked', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor)
  const result = monitor.update(frontPose({ hide: [28] }), start + 100)
  assert.equal(result.state, 'on-track')
  assert.equal(result.bodyParts.find(part => part.id === 'legs').state, 'not-in-view')
})

test('missing core landmarks lower confidence and block an on-track result', () => {
  const monitor = new PostureMonitor()
  const start = calibrate(monitor)
  const result = monitor.update(frontPose({ hide: [12] }), start + 100)
  assert.equal(result.state, 'view-needed')
  assert.ok(result.confidence < 100)
  assert.equal(result.bodyParts.find(part => part.id === 'shoulders').state, 'not-in-view')
})

test('calibration pauses and preserves progress during missing visibility', () => {
  const monitor = new PostureMonitor()
  monitor.startCalibration(0)
  for (let step = 0; step <= 24; step++) monitor.update(frontPose(), step * 100)
  const before = monitor.getCalibrationProgress()
  const lost = monitor.update(frontPose({ hide: [12] }), 2500)
  assert.equal(lost.state, 'calibrating')
  assert.equal(lost.calibrationProgress, before)

  let result
  for (let step = 25; step <= 100; step++) {
    result = monitor.update(frontPose(), step * 100)
    if (result.state === 'ready') break
  }
  assert.equal(result.state, 'ready')
})

test('calibration pauses on a large shift without clearing accumulated time', () => {
  const monitor = new PostureMonitor()
  monitor.startCalibration(0)
  for (let step = 0; step <= 35; step++) monitor.update(frontPose(), step * 100)
  const before = monitor.getCalibrationProgress()
  const paused = monitor.update(frontPose({ noseX: 0.61 }), 3600)
  assert.equal(paused.state, 'calibrating')
  assert.equal(paused.calibrationProgress, before)
  for (let step = 36; step <= 130; step++) {
    const result = monitor.update(frontPose(), step * 100)
    if (result.state === 'ready') break
  }
  assert.equal(monitor.hasReference('front'), true)
})

test('unstable calibration waits for an explicit retry and keeps old reference', () => {
  const monitor = new PostureMonitor()
  calibrate(monitor)
  const oldBaseline = monitor.baselines.front
  monitor.startCalibration(9000)
  let result
  for (let step = 0; step <= 130; step++) {
    result = monitor.update(frontPose({ noseX: step % 2 ? 0.48 : 0.52 }), 9000 + step * 100)
    if (result.state === 'calibration-review') break
  }
  assert.equal(result.state, 'calibration-review')
  assert.equal(monitor.baselines.front, oldBaseline)
  assert.equal(monitor.calibrating, false)
  monitor.retryCalibration(23000)
  assert.equal(monitor.calibrating, true)
  assert.equal(monitor.baselines.front, oldBaseline)
})
