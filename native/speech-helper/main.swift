// On-device speech-to-text for Cogenly's composer dictation.
//
//   cogenly-speech status                            -> {"available":true}
//   cogenly-speech prepare [--locale <id>]          -> {"locale":"en_US"}
//   cogenly-speech transcribe [--locale <id>] <file> -> {"text":"..."}
//   cogenly-speech stream [--locale <id>]            -> JSON lines, see below
//
// status, prepare and transcribe print exactly one JSON object on stdout.
// Failures print {"error":{"code":"...","message":"..."}} and exit 1. Codes match
// VoiceTranscriptionErrorCode in packages/client-runtime/src/voice-input.
//
// stream reads raw little-endian PCM16 mono 16 kHz audio from stdin until EOF and
// writes one JSON object per line as it transcribes:
//   {"type":"ready","locale":"en_US"}     the model is loaded and listening
//   {"type":"partial","text":"..."}       volatile text; replaces the previous partial
//   {"type":"final","text":"..."}         a finalized segment; clears the partial
//   {"type":"done"}                       stdin closed and every segment is final
// A failure prints {"type":"error","code":"...","message":"..."} and exits 1.
//
// SpeechAnalyzer + SpeechTranscriber (macOS 26) run fully on device and need no
// Speech Recognition authorization, so this helper never shows a privacy prompt.
// Older systems report "unavailable" and the client hides dictation. Building the
// real engine needs the macOS 26 SDK (Swift 6.2); scripts/build-desktop-artifact.ts
// refuses older compilers.

import AVFoundation
import Foundation
import Speech

struct HelperError: Error {
  let code: String
  let message: String
}

func emit(_ object: [String: Any]) {
  var data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
  data.append(0x0A)
  // One write per line, so lines from the result task and the main task never interleave.
  FileHandle.standardOutput.write(data)
}

func fail(_ error: HelperError) -> Never {
  emit(["error": ["code": error.code, "message": error.message]])
  exit(1)
}

let unavailable = HelperError(
  code: "unavailable", message: "On-device transcription requires macOS 26 or later.")

#if compiler(>=6.2)
  @available(macOS 26.0, *)
  enum Engine {
    static func resolveLocale(_ requested: Locale) async throws -> Locale {
      guard SpeechTranscriber.isAvailable else { throw unavailable }
      guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
        throw HelperError(
          code: "unsupported-locale",
          message: "On-device transcription does not support \(requested.identifier).")
      }
      return locale
    }

    static func makeTranscriber(_ locale: Locale, volatile: Bool = false) -> SpeechTranscriber {
      SpeechTranscriber(
        locale: locale, transcriptionOptions: [],
        reportingOptions: volatile ? [.volatileResults, .fastResults] : [], attributeOptions: [])
    }

    /// Downloads the locale's model the first time; later calls return immediately.
    static func prepare(_ requested: Locale) async throws -> Locale {
      let locale = try await resolveLocale(requested)
      do {
        if let request = try await AssetInventory.assetInstallationRequest(
          supporting: [makeTranscriber(locale)])
        {
          try await request.downloadAndInstall()
        }
      } catch {
        throw HelperError(
          code: "preparation-failed",
          message: "Could not download the speech model: \(error.localizedDescription)")
      }
      return locale
    }

    static func transcribe(_ url: URL, _ requested: Locale) async throws -> String {
      let locale = try await prepare(requested)
      let transcriber = makeTranscriber(locale)
      let file: AVAudioFile
      do {
        file = try AVAudioFile(forReading: url)
      } catch {
        throw HelperError(
          code: "transcription-failed", message: "Could not read the recording: \(error)")
      }
      let analyzer = SpeechAnalyzer(modules: [transcriber])
      let collector = Task {
        var parts: [String] = []
        for try await result in transcriber.results where result.isFinal {
          parts.append(String(result.text.characters))
        }
        return parts.joined()
      }
      do {
        if let end = try await analyzer.analyzeSequence(from: file) {
          try await analyzer.finalizeAndFinish(through: end)
        } else {
          await analyzer.cancelAndFinishNow()
        }
        return try await collector.value
      } catch {
        collector.cancel()
        throw HelperError(
          code: "transcription-failed",
          message: "Transcription failed: \(error.localizedDescription)")
      }
    }

    /// The format the renderer streams: PCM16 mono 16 kHz, interleaved.
    static let streamFormat = AVAudioFormat(
      commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

    /// Transcribes stdin live until EOF, printing partial and final results as JSON lines.
    static func stream(_ requested: Locale) async throws {
      let locale = try await prepare(requested)
      let transcriber = makeTranscriber(locale, volatile: true)
      let analyzer = SpeechAnalyzer(modules: [transcriber])
      let analyzerFormat =
        await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
        ?? streamFormat
      let converter =
        analyzerFormat == streamFormat ? nil : AVAudioConverter(from: streamFormat, to: analyzerFormat)
      converter?.primeMethod = .none

      let (inputs, inputSink) = AsyncStream.makeStream(of: AnalyzerInput.self)
      let collector = Task {
        for try await result in transcriber.results {
          let text = String(result.text.characters)
          emit(["type": result.isFinal ? "final" : "partial", "text": text])
        }
      }
      do {
        try await analyzer.start(inputSequence: inputs)
      } catch {
        collector.cancel()
        throw HelperError(
          code: "transcription-failed",
          message: "Could not start transcription: \(error.localizedDescription)")
      }
      emit(["type": "ready", "locale": locale.identifier])

      // availableData blocks, so stdin is read on its own thread.
      let (chunks, chunkSink) = AsyncStream.makeStream(of: Data.self)
      Thread.detachNewThread {
        while true {
          let data = FileHandle.standardInput.availableData
          if data.isEmpty { break }
          chunkSink.yield(data)
        }
        chunkSink.finish()
      }
      var carry = Data()
      for await data in chunks {
        carry.append(data)
        let usable = carry.count - carry.count % 2
        if usable == 0 { continue }
        let frames = carry.prefix(usable)
        carry = Data(carry.dropFirst(usable))
        if let buffer = try pcmBuffer(frames, converter: converter, to: analyzerFormat) {
          inputSink.yield(AnalyzerInput(buffer: buffer))
        }
      }
      inputSink.finish()

      do {
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        try await collector.value
      } catch {
        collector.cancel()
        throw HelperError(
          code: "transcription-failed",
          message: "Transcription failed: \(error.localizedDescription)")
      }
      emit(["type": "done"])
    }

    /// Wraps PCM16 bytes as a buffer in the analyzer's format.
    static func pcmBuffer(
      _ bytes: Data, converter: AVAudioConverter?, to format: AVAudioFormat
    ) throws -> AVAudioPCMBuffer? {
      let frameCount = AVAudioFrameCount(bytes.count / 2)
      guard
        let input = AVAudioPCMBuffer(pcmFormat: streamFormat, frameCapacity: frameCount),
        let channel = input.int16ChannelData?[0]
      else { return nil }
      bytes.withUnsafeBytes { raw in
        _ = raw.copyBytes(to: UnsafeMutableRawBufferPointer(start: channel, count: bytes.count))
      }
      input.frameLength = frameCount
      guard let converter else { return input }
      let ratio = format.sampleRate / streamFormat.sampleRate
      let capacity = AVAudioFrameCount((Double(frameCount) * ratio).rounded(.up)) + 16
      guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
        return nil
      }
      var supplied = false
      var conversionError: NSError?
      let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
        if supplied {
          inputStatus.pointee = .noDataNow
          return nil
        }
        supplied = true
        inputStatus.pointee = .haveData
        return input
      }
      if status == .error {
        throw HelperError(
          code: "transcription-failed",
          message: "Could not convert audio: \(conversionError?.localizedDescription ?? "unknown")")
      }
      return output.frameLength > 0 ? output : nil
    }
  }
#endif

/// Splits `--locale <id>` from positional arguments.
func parse(_ arguments: [String]) -> (positionals: [String], locale: String?) {
  var positionals: [String] = []
  var locale: String?
  var index = 0
  while index < arguments.count {
    if arguments[index] == "--locale", index + 1 < arguments.count {
      locale = arguments[index + 1]
      index += 2
      continue
    }
    positionals.append(arguments[index])
    index += 1
  }
  return (positionals, locale)
}

func run(_ command: String, _ positionals: [String], _ requested: Locale) async throws -> [String:
  Any]
{
  #if compiler(>=6.2)
    guard #available(macOS 26.0, *) else {
      if command == "status" { return ["available": false] }
      throw unavailable
    }
    switch command {
    case "status":
      return ["available": SpeechTranscriber.isAvailable]
    case "prepare":
      return ["locale": try await Engine.prepare(requested).identifier]
    case "stream":
      try await Engine.stream(requested)
      return [:]
    case "transcribe":
      guard positionals.count == 2 else {
        throw HelperError(code: "usage", message: "usage: cogenly-speech transcribe <file>")
      }
      let text = try await Engine.transcribe(URL(fileURLWithPath: positionals[1]), requested)
      return ["text": text.trimmingCharacters(in: .whitespacesAndNewlines)]
    default:
      throw HelperError(code: "usage", message: "Unknown command \(command).")
    }
  #else
    if command == "status" { return ["available": false] }
    throw unavailable
  #endif
}

@main
struct CogenlySpeech {
  static func main() async {
    let parsed = parse(Array(CommandLine.arguments.dropFirst()))
    guard let command = parsed.positionals.first else {
      fail(HelperError(code: "usage", message: "usage: cogenly-speech status|prepare|transcribe|stream"))
    }
    let requested = Locale(identifier: parsed.locale ?? Locale.current.identifier)
    let streaming = command == "stream"
    do {
      let output = try await run(command, parsed.positionals, requested)
      if !streaming { emit(output) }
      exit(0)
    } catch {
      let failure =
        error as? HelperError
        ?? HelperError(code: "transcription-failed", message: error.localizedDescription)
      if streaming {
        emit(["type": "error", "code": failure.code, "message": failure.message])
        exit(1)
      }
      fail(failure)
    }
  }
}
