// On-device speech-to-text for Cogenly's composer dictation.
//
//   cogenly-speech status                            -> {"available":true}
//   cogenly-speech prepare [--locale <id>]          -> {"locale":"en_US"}
//   cogenly-speech transcribe [--locale <id>] <file> -> {"text":"..."}
//
// Every command prints exactly one JSON object on stdout. Failures print
// {"error":{"code":"...","message":"..."}} and exit 1. Codes match
// VoiceTranscriptionErrorCode in packages/client-runtime/src/voice-input.
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
  let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
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

    static func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
      SpeechTranscriber(
        locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
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
      fail(HelperError(code: "usage", message: "usage: cogenly-speech prepare|transcribe"))
    }
    let requested = Locale(identifier: parsed.locale ?? Locale.current.identifier)
    do {
      emit(try await run(command, parsed.positionals, requested))
      exit(0)
    } catch let error as HelperError {
      fail(error)
    } catch {
      fail(HelperError(code: "transcription-failed", message: error.localizedDescription))
    }
  }
}
