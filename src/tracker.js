const INFERENCE_INTERVAL_MS = 1000 / 30;
const LOST_FACE_DELAY_MS = 450;

function abortError() {
  return new DOMException('Tracking was stopped.', 'AbortError');
}

function withCancellation(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', cancel);
    });
  });
}

function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function cameraErrorMessage(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera access was blocked. Allow camera access in your browser, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found. Connect a webcam, then try again.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera could not start. Close other apps using it, then try again.';
    case 'OverconstrainedError':
      return 'This camera could not use the requested video settings. Try another camera.';
    case 'SecurityError':
      return 'Camera access requires localhost or a secure HTTPS connection.';
    default:
      return error?.message || 'Face tracking could not start. Try again.';
  }
}

function midpoint(a, b) {
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * On-device webcam tracking. Samples retain the camera's unmirrored coordinates;
 * mirroring the preview is a separate presentation concern.
 */
export class FaceTracker {
  constructor({ video, onState = () => {}, onSample = () => {} }) {
    if (!video) throw new Error('FaceTracker requires a video element.');
    this.video = video;
    this.onState = onState;
    this.onSample = onSample;
    this.running = false;
    this._generation = 0;
    this._startPromise = null;
    this._modelPromise = null;
    this._landmarker = null;
    this._stream = null;
    this._controller = null;
    this._frame = 0;
    this._lastInference = -Infinity;
    this._lastVideoTime = -1;
    this._lastFaceTime = -Infinity;
    this._status = '';
    this._message = '';
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
  }

  /** Resolves true when running, or false after cancellation / a reported error. */
  async start() {
    if (this.running) return true;
    if (this._startPromise) return this._startPromise;
    const generation = ++this._generation;
    const controller = new AbortController();
    this._controller = controller;
    const pending = this._begin(generation, controller.signal);
    this._startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this._startPromise === pending) this._startPromise = null;
    }
  }

  stop() {
    ++this._generation;
    this.running = false;
    this._controller?.abort();
    this._controller = null;
    this._startPromise = null;
    cancelAnimationFrame(this._frame);
    this._frame = 0;
    this._releaseStream(this._stream);
    this._setState('stopped', 'Camera is off.');
  }

  async _begin(generation, signal) {
    let stream = null;
    const current = () => generation === this._generation && !signal.aborted;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access requires localhost or a secure HTTPS connection in a supported browser.');
      }
      this._setState('loading', 'Allow camera access to start face tracking.');
      // A browser permission prompt cannot be cancelled programmatically. If a
      // stopped request is granted later, release that stream immediately.
      const cameraRequest = navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 30 },
        },
      }).then((openedStream) => {
        if (!current()) {
          stopTracks(openedStream);
          throw abortError();
        }
        return openedStream;
      });
      stream = await withCancellation(cameraRequest, signal);
      if (!current()) throw abortError();
      this._stream = stream;
      this.video.srcObject = stream;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (current() && this._stream === stream) {
            this.stop();
            this._setState('error', 'The camera disconnected. Reconnect it, then start tracking again.');
          }
        }, { once: true });
      }
      await withCancellation(this.video.play(), signal);
      if (!current()) throw abortError();
      this._setState('loading', 'Loading the face tracker on this device…');
      this._landmarker = await withCancellation(this._loadLandmarker(), signal);
      if (!current()) throw abortError();
      this._lastInference = -Infinity;
      this._lastVideoTime = -1;
      this._lastFaceTime = -Infinity;
      this.running = true;
      this._setState('searching', 'Looking for your face. Face the camera in good light.');
      this._frame = requestAnimationFrame((timestamp) => this._tick(timestamp, generation));
      return true;
    } catch (error) {
      this._releaseStream(stream);
      if (!current()) return false;
      this.running = false;
      this._setState('error', cameraErrorMessage(error));
      return false;
    }
  }

  async _loadLandmarker() {
    if (!this._modelPromise) {
      this._modelPromise = (async () => {
        const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
        const vision = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}wasm`);
        const options = {
          baseOptions: { modelAssetPath: `${import.meta.env.BASE_URL}models/face_landmarker.task`, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          minFaceDetectionConfidence: 0.55,
          minFacePresenceConfidence: 0.55,
          minTrackingConfidence: 0.55,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        };
        try {
          return await FaceLandmarker.createFromOptions(vision, options);
        } catch {
          // Software inference supports browsers / devices without a usable GPU.
          options.baseOptions.delegate = 'CPU';
          try {
            return await FaceLandmarker.createFromOptions(vision, options);
          } catch (error) {
            throw new Error('The local face-tracking model could not load. Reload the page and try again.', { cause: error });
          }
        }
      })().catch((error) => {
        this._modelPromise = null;
        throw error;
      });
    }
    return this._modelPromise;
  }

  _tick(timestamp, generation) {
    if (!this.running || generation !== this._generation) return;
    try {
      const video = this.video;
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0
          && timestamp - this._lastInference >= INFERENCE_INTERVAL_MS
          && video.currentTime !== this._lastVideoTime) {
        this._lastInference = timestamp;
        this._lastVideoTime = video.currentTime;
        const results = this._landmarker.detectForVideo(video, timestamp);
        const landmarks = results.faceLandmarks?.[0];
        const left = landmarks?.[468] ?? midpoint(landmarks?.[33], landmarks?.[133]);
        const right = landmarks?.[473] ?? midpoint(landmarks?.[362], landmarks?.[263]);
        if (left && right) {
          const width = video.videoWidth;
          const height = video.videoHeight;
          // x and y landmarks are normalized by different image dimensions.
          // Measure in pixels before normalizing distance by the image width.
          const eyeDistance = Math.hypot((left.x - right.x) * width, (left.y - right.y) * height) / width;
          const sample = {
            centerX: (left.x + right.x) / 2,
            centerY: (left.y + right.y) / 2,
            eyeDistance,
            aspect: width / height,
            timestamp,
          };
          if (Object.values(sample).every(Number.isFinite) && eyeDistance > 0.005) {
            this._lastFaceTime = timestamp;
            this._setState('tracking', 'Face tracked. Move your head to look around.');
            this.onSample(sample);
          }
        }
      }
      if (timestamp - this._lastFaceTime > LOST_FACE_DELAY_MS) {
        this._setState('searching', 'Looking for your face. Face the camera in good light.');
      }
    } catch (error) {
      this.stop();
      this._setState('error', `Face tracking stopped. ${cameraErrorMessage(error)}`);
      return;
    }
    if (this.running && generation === this._generation) {
      this._frame = requestAnimationFrame((nextTimestamp) => this._tick(nextTimestamp, generation));
    }
  }

  _releaseStream(stream) {
    if (!stream) return;
    stopTracks(stream);
    if (this.video.srcObject === stream) {
      this.video.pause();
      this.video.srcObject = null;
    }
    if (this._stream === stream) this._stream = null;
  }

  _setState(status, message) {
    if (status === this._status && message === this._message) return;
    this._status = status;
    this._message = message;
    this.onState({ status, message });
  }
}
