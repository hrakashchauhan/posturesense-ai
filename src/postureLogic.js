
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

export class PostureMonitor {
  constructor() {
    this.reset()
  }

  reset() {
    this.samples = []
    this.baseline = null
    this.history = []
    this.badSince = null
    this.goodSince = null
    this.lastWarning = 0
    this.warning = false
    this.calibrating = false
    this.calibrationStarted = 0
  }

  startCalibration(now = performance.now()) {
    this.samples = []
    this.baseline = null
    this.history = []
    this.badSince = null
    this.goodSince = null
    this.warning = false
    this.calibrating = true
    this.calibrationStarted = now
  }

  measure(landmarks) {
    const visible = index => {
      const p = landmarks?.[index]
      return p && (p.visibility ?? 0) >= 0.65 ? p : null
    }

    const nose = visible(0)
    const leftShoulder = visible(11)
    const rightShoulder = visible(12)

    if (!nose || !leftShoulder || !rightShoulder) return null

    const shoulderWidth = Math.hypot(
      rightShoulder.x - leftShoulder.x,
      rightShoulder.y - leftShoulder.y
    )

    if (shoulderWidth < 0.08) return null

    const shoulderX = (leftShoulder.x + rightShoulder.x) / 2
    const shoulderY = (leftShoulder.y + rightShoulder.y) / 2

    return {
      headX: (nose.x - shoulderX) / shoulderWidth,
      headY: (shoulderY - nose.y) / shoulderWidth,
      shoulderTilt: Math.atan2(
        rightShoulder.y - leftShoulder.y,
        rightShoulder.x - leftShoulder.x
      ) * 180 / Math.PI,
      shoulderWidth
    }
  }

  update(landmarks, now = performance.now()) {
    const metrics = this.measure(landmarks)

    if (!metrics) {
      this.history = []
      this.badSince = null
      this.goodSince = null

      return {
        state: 'unavailable',
        message: 'Unable to assess — show your head and both shoulders',
        warning: false,
        metrics: null
      }
    }

    if (this.calibrating) {
      this.samples.push(metrics)

      if (now - this.calibrationStarted < 10000) {
        return {
          state: 'calibrating',
          message: `Calibrating your normal posture… ${Math.min(
            100,
            Math.round((now - this.calibrationStarted) / 10000 * 100)
          )}%`,
          warning: false,
          metrics
        }
      }

      if (this.samples.length < 20) {
        this.startCalibration(now)
        return {
          state: 'calibrating',
          message: 'Not enough reliable frames — hold still and try again',
          warning: false,
          metrics
        }
      }

      this.baseline = {
        headX: this.median(this.samples.map(s => s.headX)),
        headY: this.median(this.samples.map(s => s.headY)),
        shoulderTilt: this.median(this.samples.map(s => s.shoulderTilt))
      }

      this.calibrating = false
      this.samples = []
      this.history = []
      this.badSince = null
      this.goodSince = null
      this.warning = false

      return {
        state: 'ready',
        message: 'Calibration complete — monitoring posture',
        warning: false,
        metrics
      }
    }

    if (!this.baseline) {
      return {
        state: 'not-calibrated',
        message: 'Calibrate your comfortable upright posture to begin',
        warning: false,
        metrics
      }
    }

    this.history.push({ now, metrics })
    this.history = this.history.filter(item => now - item.now <= 1200)

    const smoothed = {
      headX: this.median(this.history.map(item => item.metrics.headX)),
      headY: this.median(this.history.map(item => item.metrics.headY)),
      shoulderTilt: this.median(this.history.map(item => item.metrics.shoulderTilt))
    }

    const headShift = Math.hypot(
      smoothed.headX - this.baseline.headX,
      smoothed.headY - this.baseline.headY
    )

    const shoulderChange = Math.abs(
      smoothed.shoulderTilt - this.baseline.shoulderTilt
    )

    // Initial thresholds for testing, not medical or ergonomic standards.
    const deviated = headShift > 0.16 || shoulderChange > 12

    if (deviated) {
      this.goodSince = null
      if (this.badSince === null) this.badSince = now

      if (now - this.badSince >= 2000) {
        this.warning = true
      }
    } else {
      this.badSince = null
      if (this.goodSince === null) this.goodSince = now

      if (now - this.goodSince >= 1000) {
        this.warning = false
      }
    }

    return {
      state: this.warning ? 'warning' : 'monitoring',
      message: this.warning
        ? 'Posture changed — sit comfortably and reset your position'
        : 'Monitoring your posture',
      warning: this.warning,
      metrics: {
        ...smoothed,
        headShift: Number(headShift.toFixed(3)),
        shoulderChange: Number(shoulderChange.toFixed(1))
      }
    }
  }

  median(values) {
    if (!values.length) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)

    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2
  }
}
