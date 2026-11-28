import { desktopPlatform } from '../../../internal/lib/desktop-detect';
import { levelFromRms, microphoneProblem, pickRecordingType, type MicrophoneProblem } from './dictation-state';

/** The microphone refused, with the reason a person can act on. */
export class MicrophoneError extends Error {
  constructor(readonly problem: MicrophoneProblem) {
    super(`microphone ${problem}`);
    this.name = 'MicrophoneError';
  }
}

// Speech, not music: the browser's own echo and noise handling, one channel.
const MICROPHONE: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};
/** 32 kb/s Opus or AAC: ten minutes is about 2.4 MB, well under the 25 MB clip cap. */
const BITS_PER_SECOND = 32_000;

/**
 * One dictation's microphone: `MediaRecorder` for the clip, an `AnalyserNode`
 * for the live level. `stop` resolves the clip; `cancel` drops it. Either one
 * releases the microphone, so the browser's recording indicator goes out.
 */
export class DictationRecorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private chunks: Blob[] = [];
  private readonly samples = new Float32Array(1024);
  private released = false;

  static supported(): boolean {
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return false;
    }
    // A macOS desktop build without the microphone entitlement never gets a
    // microphone: macOS refuses it without a prompt. Such a build does not
    // announce `microphone` on its bridge (apps/desktop-electron/src/preload.js).
    if (desktopPlatform() === 'macos') {
      return (window as { kortixDesktop?: { microphone?: boolean } }).kortixDesktop?.microphone === true;
    }
    return true;
  }

  /** Asks for the microphone and starts recording. Throws `MicrophoneError`. */
  async start(): Promise<void> {
    if (!DictationRecorder.supported()) throw new MicrophoneError('unsupported');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(MICROPHONE);
    } catch (error) {
      throw new MicrophoneError(microphoneProblem(error));
    }
    if (this.released) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    const type = pickRecordingType((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, {
      ...(type ? { mimeType: type } : {}),
      audioBitsPerSecond: BITS_PER_SECOND,
    });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder = recorder;
    // A slice a second: a long take is never held as one buffer only.
    recorder.start(1000);
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      if (context.state === 'suspended') void context.resume().catch(() => {});
      this.context = context;
      this.analyser = analyser;
    } catch {
      // No meter is not a failure: the clip still records.
    }
  }

  /** The microphone level now, 0..1. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    return levelFromRms(Math.sqrt(sum / this.samples.length));
  }

  /** Ends the take and resolves the clip (empty when nothing was recorded). */
  stop(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      this.release();
      return Promise.resolve(new Blob(this.chunks, { type: recorder?.mimeType || 'audio/webm' }));
    }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const clip = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
        this.release();
        resolve(clip);
      };
      recorder.stop();
    });
  }

  /** Drops the take and releases the microphone. */
  cancel(): void {
    this.chunks = [];
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.release();
  }

  private release(): void {
    this.released = true;
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
    this.stream = undefined;
    this.context = undefined;
    this.analyser = undefined;
  }
}
