const CALIBRATION_MS = 4000
const MIN_CALIBRATION_SAMPLES = 20
const WARNING_HOLD_MS = 1800
const RECOVERY_HOLD_MS = 1200
const VISIBILITY_THRESHOLD = 0.55
const VIEWS = new Set(['front', 'side'])

const REGION_LABELS = {
  headNeck: 'HEAD & NECK',
  shoulders: 'SHOULDERS',
  torsoHips: 'TORSO / HIPS',
  legs: 'KNEES / ANKLES'
}

export class PostureMonitor {
  constructor() {
    this.view = 'front'
    this.automaticView = false
    this.baselines = { front: null, side: null }
    this.drafts = { front: null, side: null }
    this.referenceFree = false
    this.resetTracking()
  }

  resetTracking() {
    this.history = []
    this.badSince = null
    this.goodSince = null
    this.warning = false
    this.pendingRegion = null
    this.activeWarningRegion = null
  }

  reset() {
    this.view = 'front'
    this.automaticView = false
    this.baselines = { front: null, side: null }
    this.drafts = { front: null, side: null }
    this.referenceFree = false
    this.calibrating = false
    this.calibrationReview = false
    this.resetTracking()
  }

  setView(view) {
    if (!VIEWS.has(view)) throw new Error(`Unsupported camera view: ${view}`)
    if (view === this.view) return
    this.view = view
    this.automaticView = false
    this.calibrationReview = Boolean(this.drafts[view]?.review)
    this.calibrating = Boolean(this.drafts[view] && !this.drafts[view].review)
    this.resetTracking()
  }

  enableAutomaticView() {
    this.automaticView = true
  }

  detectView(landmarks) {
    const leftShoulder = this.point(landmarks, 11)
    const rightShoulder = this.point(landmarks, 12)
    const nose = this.point(landmarks, 0)
    const leftHip = this.point(landmarks, 23)
    const rightHip = this.point(landmarks, 24)
    if (leftShoulder && rightShoulder) {
      const shoulderWidth = Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y)
      const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2
      if (nose && Math.abs(shoulderMidY - nose.y) > 0.04) {
        const headScale = shoulderWidth / Math.abs(shoulderMidY - nose.y)
        return headScale < 0.7 ? 'side' : 'front'
      }
    }
    if (leftShoulder && rightShoulder && leftHip && rightHip) {
      const shoulderWidth = Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y)
      const torsoLength = Math.abs((leftShoulder.y + rightShoulder.y - leftHip.y - rightHip.y) / 2)
      if (torsoLength > 0.04) return shoulderWidth / torsoLength < 0.55 ? 'side' : 'front'
    }
    return 'side'
  }

  hasReference(view = this.view) {
    return Boolean(this.baselines[view])
  }

  getCalibrationProgress(view = this.view) {
    const draft = this.drafts[view]
    if (!draft) return 0
    return Math.min(100, Math.floor(draft.validMs / CALIBRATION_MS * 100))
  }

  startCalibration(now = performance.now()) {
    this.automaticView = false
    this.referenceFree = false
    this.drafts[this.view] = {
      samples: [],
      validMs: 0,
      lastValidAt: null,
      anchor: null,
      startedAt: now
    }
    this.calibrating = true
    this.calibrationReview = false
    this.resetTracking()
  }

  retryCalibration(now = performance.now()) {
    this.startCalibration(now)
  }

  cancelCalibration() {
    this.calibrating = false
    this.calibrationReview = false
    this.resetTracking()
  }

  continueWithoutReference() {
    this.calibrating = false
    this.calibrationReview = false
    this.referenceFree = true
    this.resetTracking()
  }

  point(landmarks, index) {
    const point = landmarks?.[index]
    return point && (point.visibility ?? 0) >= VISIBILITY_THRESHOLD ? point : null
  }

  average(points) {
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      z: points.reduce((sum, point) => sum + (point.z ?? 0), 0) / points.length
    }
  }

  angleAt(a, vertex, b) {
    const va = [a.x - vertex.x, a.y - vertex.y]
    const vb = [b.x - vertex.x, b.y - vertex.y]
    const denominator = Math.hypot(...va) * Math.hypot(...vb)
    if (!denominator) return null
    const cosine = Math.max(-1, Math.min(1, (va[0] * vb[0] + va[1] * vb[1]) / denominator))
    return Math.acos(cosine) * 180 / Math.PI
  }

  measureFront(landmarks) {
    const nose = this.point(landmarks, 0)
    const leftShoulder = this.point(landmarks, 11)
    const rightShoulder = this.point(landmarks, 12)
    const leftHip = this.point(landmarks, 23)
    const rightHip = this.point(landmarks, 24)
    const leftKnee = this.point(landmarks, 25)
    const rightKnee = this.point(landmarks, 26)
    const leftAnkle = this.point(landmarks, 27)
    const rightAnkle = this.point(landmarks, 28)
    const headVisible = Boolean(nose && leftShoulder && rightShoulder)
    const shouldersVisible = Boolean(leftShoulder && rightShoulder)
    const torsoVisible = Boolean(shouldersVisible && leftHip && rightHip)
    const legsVisible = Boolean(leftHip && rightHip && leftKnee && rightKnee && leftAnkle && rightAnkle)
    const shoulderMid = shouldersVisible ? this.average([leftShoulder, rightShoulder]) : null
    const hipMid = leftHip && rightHip ? this.average([leftHip, rightHip]) : null
    const shoulderWidth = shouldersVisible ? Math.hypot(
      rightShoulder.x - leftShoulder.x,
      rightShoulder.y - leftShoulder.y
    ) : null
    const hipWidth = hipMid ? Math.hypot(rightHip.x - leftHip.x, rightHip.y - leftHip.y) : null

    return {
      view: 'front',
      valid: headVisible && shouldersVisible && torsoVisible && legsVisible && shoulderWidth >= 0.08,
      confidence: this.landmarkConfidence(landmarks, [0, 11, 12, ...(leftHip && rightHip ? [23, 24] : []), ...(legsVisible ? [25, 26, 27, 28] : [])]),
      visible: { headNeck: headVisible, shoulders: shouldersVisible, torsoHips: torsoVisible, legs: legsVisible },
      features: {
        headNeck: headVisible && shoulderWidth >= 0.08 ? {
          x: (nose.x - shoulderMid.x) / shoulderWidth,
          y: (shoulderMid.y - nose.y) / shoulderWidth,
          depth: ((nose.z ?? 0) - shoulderMid.z) / shoulderWidth
        } : null,
        shoulders: shouldersVisible ? {
          tilt: Math.atan2(rightShoulder.y - leftShoulder.y, rightShoulder.x - leftShoulder.x) * 180 / Math.PI
        } : null,
        torsoHips: torsoVisible && shoulderWidth >= 0.08 ? {
          shift: (shoulderMid.x - hipMid.x) / shoulderWidth,
          hipTilt: Math.atan2(rightHip.y - leftHip.y, rightHip.x - leftHip.x) * 180 / Math.PI
        } : null,
        legs: legsVisible && hipWidth >= 0.06 ? {
          kneeLevel: (rightKnee.y - leftKnee.y) / hipWidth,
          ankleLevel: (rightAnkle.y - leftAnkle.y) / hipWidth
        } : null
      }
    }
  }

  measureSide(landmarks) {
    const nose = this.point(landmarks, 0)
    const candidates = [
      { side: 'left', ear: this.point(landmarks, 7), shoulder: this.point(landmarks, 11), hip: this.point(landmarks, 23), knee: this.point(landmarks, 25), ankle: this.point(landmarks, 27) },
      { side: 'right', ear: this.point(landmarks, 8), shoulder: this.point(landmarks, 12), hip: this.point(landmarks, 24), knee: this.point(landmarks, 26), ankle: this.point(landmarks, 28) }
    ]
    const candidate = candidates.sort((a, b) =>
      [b.ear, b.shoulder, b.hip, b.knee, b.ankle].filter(Boolean).length -
      [a.ear, a.shoulder, a.hip, a.knee, a.ankle].filter(Boolean).length
    )[0]
    const headVisible = Boolean(nose && candidate.ear && candidate.shoulder)
    const torsoVisible = Boolean(candidate.shoulder && candidate.hip)
    const hipsVisible = Boolean(torsoVisible && candidate.knee)
    const legsVisible = Boolean(hipsVisible && candidate.ankle)
    const torsoLength = torsoVisible ? Math.hypot(
      candidate.shoulder.x - candidate.hip.x,
      candidate.shoulder.y - candidate.hip.y
    ) : 0
    const facing = nose && candidate.ear && Math.abs(nose.x - candidate.ear.x) > 0.008
      ? Math.sign(nose.x - candidate.ear.x)
      : 1

    return {
      view: 'side',
      valid: headVisible && torsoVisible && hipsVisible && legsVisible && torsoLength >= 0.08,
      confidence: this.landmarkConfidence(landmarks, [0, candidate.side === 'left' ? 7 : 8, candidate.side === 'left' ? 11 : 12, candidate.side === 'left' ? 23 : 24, ...(candidate.knee && candidate.ankle ? [candidate.side === 'left' ? 25 : 26, candidate.side === 'left' ? 27 : 28] : [])]),
      visible: { headNeck: headVisible, shoulders: torsoVisible, torsoHips: hipsVisible, legs: legsVisible },
      features: {
        headNeck: headVisible && torsoLength >= 0.08 ? {
          forward: ((candidate.ear.x - candidate.shoulder.x) * facing) / torsoLength,
          drop: (candidate.ear.y - candidate.shoulder.y) / torsoLength
        } : null,
        shoulders: torsoVisible && torsoLength >= 0.08 ? {
          upperBack: ((candidate.shoulder.x - candidate.hip.x) * facing) / torsoLength
        } : null,
        torsoHips: hipsVisible ? {
          hipKnee: this.angleAt(candidate.shoulder, candidate.hip, candidate.knee)
        } : null,
        legs: legsVisible ? {
          kneeAnkle: this.angleAt(candidate.hip, candidate.knee, candidate.ankle)
        } : null
      }
    }
  }

  landmarkConfidence(landmarks, indices) {
    const visibilities = indices.map(index => Math.max(0, Math.min(1, landmarks?.[index]?.visibility ?? 0)))
    return visibilities.length ? Math.round(visibilities.reduce((sum, value) => sum + value, 0) / visibilities.length * 100) : 0
  }

  measure(landmarks) {
    if (this.automaticView && landmarks) {
      const detectedView = this.detectView(landmarks)
      if (detectedView !== this.view) {
        this.view = detectedView
        this.resetTracking()
      }
    }
    return this.view === 'front'
      ? this.measureFront(landmarks)
      : this.measureSide(landmarks)
  }

  allVisible(measurement) {
    return Boolean(measurement.visible.headNeck && measurement.visible.shoulders &&
      measurement.features.headNeck && measurement.features.shoulders)
  }

  missingMessage(measurement) {
    const missing = Object.entries(measurement.visible)
      .filter(([, visible]) => !visible)
      .map(([region]) => REGION_LABELS[region])
    return missing.length
      ? `Move back until ${missing.join(', ').toLowerCase()} are in view.`
      : 'Center your body so PostureSense can see your head and shoulders clearly.'
  }

  calibrationDriftMessage(draft, measurement) {
    if (!draft.anchor) return null
    const now = measurement.features
    const anchor = draft.anchor
    if (this.view === 'front') {
      if (Math.hypot(now.headNeck.x - anchor.headNeck.x, now.headNeck.y - anchor.headNeck.y) > 0.28) return 'Center your head over your shoulders.'
      if (Math.abs(now.shoulders.tilt - anchor.shoulders.tilt) > 22) return 'Relax and level your shoulders.'
      if (now.torsoHips && anchor.torsoHips && Math.abs(now.torsoHips.shift - anchor.torsoHips.shift) > 0.25) return 'Settle your torso evenly over your hips.'
      if (now.torsoHips && anchor.torsoHips && Math.abs(now.torsoHips.hipTilt - anchor.torsoHips.hipTilt) > 25) return 'Settle your hips comfortably in the chair.'
      if (now.legs && anchor.legs && (Math.abs(now.legs.kneeLevel - anchor.legs.kneeLevel) > 0.35 || Math.abs(now.legs.ankleLevel - anchor.legs.ankleLevel) > 0.35)) return 'Bring your legs and feet back into a relaxed position.'
      return null
    }
    if (Math.abs(now.headNeck.forward - anchor.headNeck.forward) > 0.25) return 'Bring your head gently back above your shoulders.'
    if (Math.abs(now.shoulders.upperBack - anchor.shoulders.upperBack) > 0.25) return 'Settle your shoulders above your hips.'
    if (now.torsoHips && anchor.torsoHips && Math.abs(now.torsoHips.hipKnee - anchor.torsoHips.hipKnee) > 30) return 'Sit back into the chair and let your hips settle.'
    if (now.legs && anchor.legs && Math.abs(now.legs.kneeAnkle - anchor.legs.kneeAnkle) > 35) return 'Let your lower legs and feet rest comfortably.'
    return null
  }

  calibrationUpdate(measurement, now) {
    const draft = this.drafts[this.view]
    if (!draft) return this.result('not-calibrated', 'Choose your view, start the camera, then set your reference.', null)

    if (!this.allVisible(measurement)) {
      draft.lastValidAt = null
      return this.result('calibrating', this.missingMessage(measurement), measurement, draft.validMs)
    }

    const driftMessage = this.calibrationDriftMessage(draft, measurement)
    if (driftMessage) {
      draft.lastValidAt = null
      return this.result('calibrating', `${driftMessage} Calibration progress is saved.`, measurement, draft.validMs)
    }

    if (!draft.anchor) draft.anchor = structuredClone(measurement.features)

    if (draft.lastValidAt !== null) {
      const elapsed = now - draft.lastValidAt
      if (elapsed > 0 && elapsed <= 500) draft.validMs += Math.min(elapsed, 250)
    }
    draft.lastValidAt = now
    draft.samples.push(measurement.features)

    const progress = Math.min(99, Math.floor(draft.validMs / CALIBRATION_MS * 100))
    if (draft.validMs < CALIBRATION_MS || draft.samples.length < MIN_CALIBRATION_SAMPLES) {
      return this.result('calibrating', 'Hold your relaxed position; small movements are fine.', measurement, draft.validMs)
    }

    const baseline = this.medianFeatures(draft.samples)
    if (!this.samplesAreSteady(draft.samples, baseline)) {
      this.calibrating = false
      this.calibrationReview = true
      draft.review = true
      return this.result('calibration-review', 'Your reference was too changeable to save.', measurement, CALIBRATION_MS, {
        reason: 'Choose Retry to collect a steadier reference. Your previous saved reference is unchanged.'
      })
    }

    this.baselines[this.view] = baseline
    this.drafts[this.view] = null
    this.calibrating = false
    this.calibrationReview = false
    this.resetTracking()
    return this.result('ready', 'Reference saved. PostureSense is now checking your position.', measurement, CALIBRATION_MS)
  }

  medianFeatures(samples) {
    const baseline = {}
    const regions = Object.keys(samples[0]).filter(region => samples.every(sample => sample[region]))
    for (const region of regions) {
      baseline[region] = {}
      const keys = Object.keys(samples[0][region]).filter(key => samples.every(sample => Number.isFinite(sample[region][key])))
      for (const key of keys) {
        baseline[region][key] = this.median(samples.map(sample => sample[region][key]))
      }
    }
    return baseline
  }

  samplesAreSteady(samples, baseline) {
    const limits = this.view === 'front'
      ? { headNeck: { x: 0.16, y: 0.16, depth: 0.28 }, shoulders: { tilt: 15 }, torsoHips: { shift: 0.16, hipTilt: 15 }, legs: { kneeLevel: 0.22, ankleLevel: 0.22 } }
      : { headNeck: { forward: 0.18, drop: 0.18 }, shoulders: { upperBack: 0.18 }, torsoHips: { hipKnee: 20 }, legs: { kneeAnkle: 22 } }
    for (const [region, values] of Object.entries(baseline)) {
      for (const key of Object.keys(values)) {
        const maximum = limits[region]?.[key]
        if (!maximum) continue
        const sorted = samples.map(sample => sample[region][key]).sort((a, b) => a - b)
        if (this.quantile(sorted, 0.9) - this.quantile(sorted, 0.1) > maximum) return false
      }
    }
    return Boolean(baseline)
  }

  update(landmarks, now = performance.now()) {
    const measurement = landmarks ? this.measure(landmarks) : null
    if (this.calibrationReview) {
      const draft = this.drafts[this.view]
      return this.result('calibration-review', 'Your reference was too changeable to save.', measurement, draft?.validMs ?? CALIBRATION_MS, {
        reason: 'Choose Retry to collect a steadier reference. Your previous saved reference is unchanged.'
      })
    }
    if (this.calibrating) {
      if (!measurement) return this.result('calibrating', 'Move into view; your progress is saved.', null, this.drafts[this.view]?.validMs ?? 0)
      return this.calibrationUpdate(measurement, now)
    }

    if (!measurement || !this.allVisible(measurement)) {
      this.history = []
      this.badSince = null
      this.goodSince = null
      this.warning = false
      return this.result('view-needed', measurement ? this.missingMessage(measurement) : 'Move into view so PostureSense can see your body.', measurement, 0)
    }

    if (this.referenceFree) return this.result('reference-free', 'Tracking body visibility only. Set a reference any time to compare posture changes.', measurement, 0, {
      reason: 'Posture comparisons are unavailable until you set a personal reference.'
    })

    const baseline = this.baselines[this.view]
    if (!baseline) return this.result('not-calibrated', 'Set your sitting reference to begin.', measurement, 0)

    this.history.push({ now, features: measurement.features })
    this.history = this.history.filter(item => now - item.now <= 700)
    const current = this.medianFeatures(this.history.map(item => item.features))
    const deviations = this.deviations(current, baseline)
    const thresholds = this.thresholds()
    const exceeded = Object.entries(deviations).filter(([region, values]) =>
      Object.entries(values).some(([key, value]) => value > thresholds[region][key])
    ).map(([region]) => region)
    const recovery = Object.entries(deviations).every(([region, values]) =>
      Object.entries(values).every(([key, value]) => value < thresholds[region][key] * 0.68)
    )

    if (exceeded.length) {
      this.goodSince = null
      const strongest = [...exceeded].sort((a, b) =>
        this.severity(b, deviations[b], thresholds[b]) - this.severity(a, deviations[a], thresholds[a])
      )[0]
      if (this.badSince === null) {
        this.badSince = now
        this.pendingRegion = strongest
      } else if (!this.warning) {
        this.pendingRegion = strongest
      }
      if (now - this.badSince >= WARNING_HOLD_MS && !this.warning) {
        this.warning = true
        this.activeWarningRegion = this.pendingRegion
      }
    } else if (recovery) {
      this.badSince = null
      if (this.goodSince === null) this.goodSince = now
      if (now - this.goodSince >= RECOVERY_HOLD_MS) {
        this.warning = false
        this.pendingRegion = null
        this.activeWarningRegion = null
      }
    } else {
      this.goodSince = null
      this.badSince = null
    }

    const activeRegions = this.warning && this.activeWarningRegion
      ? [...new Set([...exceeded, this.activeWarningRegion])]
      : exceeded
    const bodyParts = this.bodyPartStatuses(deviations, thresholds, activeRegions)
    const primaryRegion = this.warning
      ? (this.activeWarningRegion ?? exceeded[0] ?? null)
      : [...exceeded].sort((a, b) => this.severity(b, deviations[b], thresholds[b]) - this.severity(a, deviations[a], thresholds[a]))[0]
    const state = this.warning ? 'adjust' : exceeded.length ? 'checking' : 'on-track'
    return this.result(state, primaryRegion ? this.alertMessage(primaryRegion, current, baseline) : 'Your visible posture is close to your saved reference.', measurement, CALIBRATION_MS, {
      reason: primaryRegion ? 'This change has to stay for a few seconds before PostureSense shows an adjustment reminder.' : 'Small movement is normal. PostureSense compares only the body areas it can see.',
      bodyParts,
      deviations,
      primaryRegion
    })
  }

  deviations(current, baseline) {
    const result = {}
    for (const region of Object.keys(baseline)) {
      if (!current[region]) continue
      result[region] = {}
      for (const key of Object.keys(baseline[region])) {
        if (!Number.isFinite(current[region][key])) continue
        const difference = Math.abs(current[region][key] - baseline[region][key])
        result[region][key] = region === 'shoulders' && key === 'tilt' ? difference : difference
      }
    }
    return result
  }

  thresholds() {
    return this.view === 'front'
      ? { headNeck: { x: 0.22, y: 0.24, depth: 0.35 }, shoulders: { tilt: 17 }, torsoHips: { shift: 0.2, hipTilt: 17 }, legs: { kneeLevel: 0.25, ankleLevel: 0.25 } }
      : { headNeck: { forward: 0.22, drop: 0.22 }, shoulders: { upperBack: 0.2 }, torsoHips: { hipKnee: 22 }, legs: { kneeAnkle: 24 } }
  }

  bodyPartStatuses(deviations, thresholds, exceeded) {
    return Object.entries(REGION_LABELS).map(([region, label]) => {
      const values = deviations[region]
      if (!values) return { id: region, label, state: 'not-in-view', message: 'Move until this area is visible.' }
      const changed = Object.entries(values).some(([key, value]) => value > thresholds[region][key])
      const latched = this.warning && this.activeWarningRegion === region
      return { id: region, label, state: latched ? 'adjust' : changed ? 'checking' : 'on-track' }
    })
  }

  alertMessage(region, current, baseline) {
    if (region === 'headNeck') {
      return this.view === 'side'
        ? 'HEAD & NECK — your head moved forward from its reference. Gently bring it back above your shoulders.'
        : 'HEAD & NECK — your head moved away from its reference. Gently center it over your shoulders.'
    }
    if (region === 'shoulders') {
      if (this.view === 'front') return 'SHOULDERS — one side is higher than your reference. Relax and level your shoulders.'
      return 'SHOULDERS / BACK — your upper body leaned forward. Let your shoulders settle over your hips.'
    }
    if (region === 'torsoHips') {
      if (this.view === 'front') return 'TORSO / HIPS — your upper body shifted sideways. Settle evenly over your hips.'
      return 'HIPS — your seated hip and thigh angle changed. Shift back to a comfortable seat position.'
    }
    return this.view === 'front'
      ? 'KNEES / ANKLES — your legs shifted unevenly from the reference. Let both feet rest comfortably.'
      : 'KNEES / ANKLES — your lower-leg position changed. Reset your feet comfortably.'
  }

  severity(region, values, limits) {
    return Math.max(...Object.entries(values).map(([key, value]) => value / limits[key]))
  }

  result(state, message, measurement, validMs = 0, extra = {}) {
    const visible = measurement?.visible ?? { headNeck: false, shoulders: false, torsoHips: false, legs: false }
    const bodyParts = extra.bodyParts ?? Object.entries(REGION_LABELS).map(([id, label]) => ({
      id,
      label,
      state: visible[id] ? 'waiting' : 'not-in-view',
      message: visible[id] ? 'Waiting for a saved reference.' : 'Not in view'
    }))
    return {
      state,
      message,
      reason: extra.reason ?? '',
      warning: state === 'adjust',
      view: this.view,
      visible,
      bodyParts,
      primaryRegion: extra.primaryRegion ?? null,
      calibrationProgress: this.calibrating || state === 'calibration-review'
        ? Math.min(100, Math.floor(validMs / CALIBRATION_MS * 100))
        : state === 'ready' || this.hasReference() ? 100 : 0,
      metrics: extra.deviations ?? null,
      confidence: measurement?.confidence ?? 0
    }
  }

  median(values) {
    if (!values.length) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }

  quantile(sortedValues, quantile) {
    const index = (sortedValues.length - 1) * quantile
    const lower = Math.floor(index)
    const fraction = index - lower
    return sortedValues[lower] + (sortedValues[Math.min(lower + 1, sortedValues.length - 1)] - sortedValues[lower]) * fraction
  }
}
