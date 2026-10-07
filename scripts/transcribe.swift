// SNS-Downloader の文字起こし。macOS 26 の SpeechTranscriber で端末内の音声認識をする。
// 使い方: transcribe <16kHz モノラルの wav> <ロケール、例 ja-JP>
// 字幕の1枚ずつを JSON の1行（{"start":秒,"end":秒,"text":"…"}）で標準出力に書く。
// 元は strickland プラグインの video-minutes skill の transcribe.swift。字幕の時刻を出すために書き換えた。
// 終了コード 1 認識の失敗、2 引数の誤り、3 言語資産が無い
import AVFoundation
import Foundation
import Speech

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

// 字幕1枚の区切り方。文の終わりでは必ず切り、読点では長くなったときだけ切る。
// どこにも句読点が無いまま長くなったら途中で切る
let minSentence = 6
let softLimit = 24
let hardLimit = 40
let sentenceEnd: Set<Character> = ["。", "！", "？", "!", "?", "．"]
let comma: Set<Character> = ["、", "，", ","]

struct Cue: Encodable {
    var start: Double
    var end: Double
    var text: String
}

let args = CommandLine.arguments
guard args.count == 3 else { fail("使い方: transcribe <音声ファイル> <ロケール>", 2) }
let url = URL(fileURLWithPath: args[1])
let locale = Locale(identifier: args[2])
let tag = locale.identifier(.bcp47)

let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
guard installed.contains(tag) else {
    fail("\(tag) の音声認識資産が入っていない。導入済み: \(installed)", 3)
}

let encoder = JSONEncoder()
func emit(_ cue: Cue) {
    let text = cue.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, let data = try? encoder.encode(Cue(start: cue.start, end: max(cue.end, cue.start + 0.3), text: text)) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

do {
    let transcriber = SpeechTranscriber(
        locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let printer = Task {
        for try await result in transcriber.results {
            var current: Cue? = nil
            for run in result.text.runs {
                let piece = String(result.text[run.range].characters)
                guard !piece.isEmpty else { continue }
                // 時刻が取れない区切りや無効な時刻（NaN）は、直前の時刻で埋める。
                // NaN のまま JSON にすると encode が失敗し、その字幕が黙って消える
                let fallback = current?.end ?? (result.range.start.seconds.isFinite ? result.range.start.seconds : 0)
                let rawStart = run.audioTimeRange?.start.seconds ?? fallback
                let start = rawStart.isFinite ? rawStart : fallback
                let rawEnd = run.audioTimeRange?.end.seconds ?? start
                let end = rawEnd.isFinite ? rawEnd : start
                if current == nil {
                    current = Cue(start: start, end: end, text: "")
                }
                current!.text += piece
                current!.end = max(current!.end, end)
                let count = current!.text.count
                let last = piece.trimmingCharacters(in: .whitespaces).last
                let endsSentence = last.map { sentenceEnd.contains($0) } ?? false
                let endsClause = last.map { comma.contains($0) } ?? false
                if (endsSentence && count >= minSentence) || (endsClause && count >= softLimit) || count >= hardLimit {
                    emit(current!)
                    current = nil
                }
            }
            if let rest = current { emit(rest) }
        }
    }
    let file = try AVAudioFile(forReading: url)
    // 長さ 0 の音声を渡すと SpeechAnalyzer は終わらなくなる。何も出さずに終える
    if file.length == 0 { exit(0) }
    if let last = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: last)
    } else {
        await analyzer.cancelAndFinishNow()
    }
    try await printer.value
} catch {
    fail("文字起こしに失敗した: \(error)", 1)
}
