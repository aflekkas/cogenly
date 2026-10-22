// @effect-diagnostics globalTimers:off -- The recording limit is a plain timer owned by one recorder.
import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";

import { DICTATION_SAMPLE_RATE, downsample, encodeWav, speechLevel } from "./dictationAudio";

const CAPTURE_BUFFER_FRAMES = 4096;
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

/**
 * Captures the microphone as PCM with Web Audio and finishes as an in-memory WAV,
 * addressed by a `dictation:` URI the transcriber reads back. Chromium's
 * MediaRecorder only produces WebM/Opus, which AVAudioFile cannot open.
 */
export class BrowserVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;

  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRecordingId = 0;
  private readonly recordings = new Map<string, Uint8Array>();
  private readonly levelListeners = new Set<(level: number) => void>();

  constructor(private readonly onStatus: (status: VoiceRecorderStatus) => void) {}

  /** Opens the microphone. Rejects with the getUserMedia error when access is refused. */
  async configure(): Promise<void> {
    if (this.stream) return;
    const stream = await openMicrophone();
    this.stream = stream;
    const context = new AudioContext();
    this.context = context;
    this.source = context.createMediaStreamSource(stream);
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (this.processor) {
          this.onStatus({
            isFinished: false,
            hasError: true,
            error: "The microphone was disconnected.",
            url: null,
          });
        }
      });
    }
  }

  /** Closes the microphone, which also clears the macOS mic indicator. */
  async release(): Promise<void> {
    this.detachProcessor();
    this.source?.disconnect();
    this.source = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close();
  }

  async prepareToRecordAsync(): Promise<void> {
    if (!this.context || !this.source) throw new Error("The microphone is not open.");
    if (this.context.state === "suspended") await this.context.resume();
    this.chunks = [];
    this.uri = null;
  }

  record({ forDuration }: { readonly forDuration: number }): void {
    const context = this.context;
    const source = this.source;
    if (!context || !source) return;
    // ScriptProcessor needs no worklet module, which a CSP or a file:// origin can
    // refuse; at 4096 frames it wakes about a dozen times a second.
    const processor = context.createScriptProcessor(CAPTURE_BUFFER_FRAMES, 1, 1);
    processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      this.chunks.push(downsample(samples, context.sampleRate, DICTATION_SAMPLE_RATE).slice());
      const level = speechLevel(samples);
      for (const listener of this.levelListeners) listener(level);
    };
    source.connect(processor);
    // A processor only runs while connected to the destination; it outputs silence.
    processor.connect(context.destination);
    this.processor = processor;
    this.limitTimer = setTimeout(() => {
      this.finish();
      this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri });
    }, forDuration * 1000);
  }

  async stop(): Promise<void> {
    this.finish();
  }

  readRecording(uri: string): Uint8Array | null {
    return this.recordings.get(uri) ?? null;
  }

  deleteRecording(uri: string): void {
    this.recordings.delete(uri);
  }

  /** Live input level in [0, 1] while recording, about a dozen times a second. */
  subscribeLevel(listener: (level: number) => void): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  private finish(): void {
    if (!this.processor) return;
    this.detachProcessor();
    this.nextRecordingId += 1;
    const uri = `dictation:${this.nextRecordingId}`;
    this.recordings.set(uri, encodeWav(this.chunks, DICTATION_SAMPLE_RATE));
    this.chunks = [];
    this.uri = uri;
    for (const listener of this.levelListeners) listener(0);
  }

  private detachProcessor(): void {
    if (this.limitTimer !== null) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    if (!this.processor) return;
    this.processor.onaudioprocess = null;
    this.processor.disconnect();
    this.processor = null;
  }
}
