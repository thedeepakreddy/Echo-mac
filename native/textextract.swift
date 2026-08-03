// textextract — pull plain text out of documents Jarvis needs to index.
//
//   textextract <path>   -> JSON: {"text": "...", "pages": n}
//
// PDFs are the reason this exists. macOS ships `textutil`, which handles rtf,
// doc, docx and html, but not PDF — and there is no command-line PDF text
// extractor in a stock install. PDFKit is right there in the OS, so this is a
// thin wrapper around it rather than a new dependency to bundle and sign.
//
// Output is JSON so a partial read or a stderr warning cannot be mistaken for
// document content.

import Foundation
import PDFKit

func jsonString(_ s: String) -> String {
    var out = "\""
    for c in s.unicodeScalars {
        switch c {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\t": out += "\\t"
        case "\r": out += "\\r"
        default:
            if c.value < 0x20 { out += String(format: "\\u%04x", c.value) }
            else { out.unicodeScalars.append(c) }
        }
    }
    return out + "\""
}

func fail(_ reason: String) -> Never {
    print("{\"error\":\(jsonString(reason)),\"text\":\"\"}")
    exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let path = args.first else { fail("usage: textextract <path>") }

let url = URL(fileURLWithPath: path)
guard FileManager.default.fileExists(atPath: path) else { fail("no-such-file") }

let ext = url.pathExtension.lowercased()

if ext == "pdf" {
    guard let doc = PDFDocument(url: url) else { fail("cannot-open-pdf") }

    // A scanned PDF is a stack of images with no text layer at all. Reporting
    // that distinctly matters: an empty string looks like an extraction bug,
    // whereas "no text layer" tells the caller to send it through OCR instead.
    var parts: [String] = []
    for i in 0..<doc.pageCount {
        if let page = doc.page(at: i), let s = page.string { parts.append(s) }
    }
    let text = parts.joined(separator: "\n\n")
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        print("{\"error\":\"no-text-layer\",\"pages\":\(doc.pageCount),\"text\":\"\"}")
        exit(0)
    }
    print("{\"pages\":\(doc.pageCount),\"text\":\(jsonString(text))}")
    exit(0)
}

// Everything else: let NSAttributedString read it. This covers rtf, rtfd, doc,
// docx, odt, html and webarchive through the same document-reading machinery
// textutil uses, without shelling out to it.
if ["rtf", "rtfd", "doc", "docx", "odt", "html", "htm", "webarchive"].contains(ext) {
    if let attributed = try? NSAttributedString(
        url: url,
        options: [.documentType: NSAttributedString.DocumentType.plain],
        documentAttributes: nil
    ) {
        print("{\"text\":\(jsonString(attributed.string))}")
        exit(0)
    }
    fail("cannot-read-document")
}

// Plain text and source files.
if let data = try? String(contentsOf: url, encoding: .utf8) {
    print("{\"text\":\(jsonString(data))}")
    exit(0)
}
fail("not-utf8-text")
