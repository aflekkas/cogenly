// @effect-diagnostics globalTimers:off -- The permission timeout is a plain timer owned by one capture.
import { DICTATION_SAMPLE_RATE, downsample, encodePcm16, speechLevel } from "./dictationAudio";

// About 85 ms at 48 kHz: short enough that text follows the voice closely.
const CAPTURE_BUFFER_FRAMES = 4096;
// About 21 ms at 48 kHz: one animation frame's worth of signal for the level meter.
const LEVEL_WINDOW_FRAMES = 1024;
// A permission prompt nobody answers would otherwise hold the voice session forever.
const OPEN_MICROPHONE_TIMEOUT_MS = 15_000;

function openMicrophone(): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("Opening the microphone timed out."));
    }, OPEN_MICROPHONE_TIMEOUT_MS);
    navigator.mediaDevices
      .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(
        (stream) => {
          clearTimeout(timer);
          // A stream that arrives after the timeout belongs to no one; close it.
          if (settled) for (const track of stream.getTracks()) track.stop();
          else resolve(stream);
          settled = true;
        },
        (error: unknown) => {
          clearTimeout(timer);
          settled = true;
          reject(error);
        },
      );
  });
}

export interface DictationCaptureHandlers {
  /** PCM16 mono 16 kHz bytes, about a dozen chunks a second. */
  readonly onAudio: (pcm: Uint8Array) => void;
  /** The input went away mid-capture, such as an unplugged headset. */
  readonly onInterrupted: (message: string) => void;
}

/** The microphone side of live dictation. */
export interface DictationMicrophone {
  /** Opens the microphone and streams it. Rejects with the getUserMedia error when refused. */
  start(handlers: DictationCaptureHandlers): Promise<void>;
  /** Stops streaming and closes the microphone, which clears the macOS mic indicator. */
  stop(): Promise<void>;
  /** Current input level in [0, 1] while capturing, 0 otherwise. Cheap enough to call every frame. */
  readLevel(): number;
}

/**
 * Captures the microphone with Web Audio and streams it as PCM16 for the speech
 * helper. Chromium's MediaRecorder only produces WebM/Opus, which the helper
 * cannot read.
 */
export class BrowserDictationMicrophone implements DictationMicrophone {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelSamples: Float32Array<ArrayBuffer> | null = null;

  async start(handlers: DictationCaptureHandlers): Promise<void> {
    await this.stop();
    const stream = await openMicrophone();
    this.stream = stream;
    const context = new AudioContext();
    this.context = context;
    if (context.state === "suspended") await context.resume();
    const source = context.createMediaStreamSource(stream);
    this.source = source;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (this.stream === stream) handlers.onInterrupted("The microphone was disconnected.");
      });
    }
    // ScriptProcessor needs no worklet module, which a CSP or a file:// origin can refuse.
    const processor = context.createScriptProcessor(CAPTURE_BUFFER_FRAMES, 1, 1);
    processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      handlers.onAudio(encodePcm16(downsample(samples, context.sampleRate, DICTATION_SAMPLE_RATE)));
    };
    source.connect(processor);
    // A processor only runs while connected to the destination; it outputs silence.
    processor.connect(context.destination);
    this.processor = processor;
    // The meter taps the same source; an analyser keeps its latest window unwired.
    const analyser = context.createAnalyser();
    analyser.fftSize = LEVEL_WINDOW_FRAMES;
    source.connect(analyser);
    this.analyser = analyser;
    this.levelSamples = new Float32Array(LEVEL_WINDOW_FRAMES);
  }

  async stop(): Promise<void> {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
    }
    this.processor = null;
    this.analyser = null;
    this.levelSamples = null;
    this.source?.disconnect();
    this.source = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close();
  }

  readLevel(): number {
    if (!this.analyser || !this.levelSamples) return 0;
    this.analyser.getFloatTimeDomainData(this.levelSamples);
    return speechLevel(this.levelSamples);
  }
}
