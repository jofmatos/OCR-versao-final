import AppKit
import Foundation
import ImageIO
import Network
import Vision

let port: UInt16 = 17861
let site = "https://jofmatos.github.io/OCR-versao-final/"
let origins = Set(["https://jofmatos.github.io", "http://127.0.0.1:8080", "http://127.0.0.1:8081", "http://localhost:8080"])
let maximumBody = 24 * 1024 * 1024
let queue = DispatchQueue(label: "lume.mac.vision")

struct LocalError: Error { let message: String }

func recognize(_ image: CGImage, language: String) throws -> [String: Any] {
    guard image.width > 0, image.height > 0, image.width <= 14000, image.height <= 14000,
          image.width * image.height <= 20000000 else {
        throw LocalError(message: "A imagem excede o limite de resolução do OCR local.")
    }
    let request = VNRecognizeTextRequest()
    request.revision = VNRecognizeTextRequestRevision3
    request.recognitionLevel = .accurate
    // Preserve observed text rather than applying dictionary word corrections.
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.002
    let supported = try request.supportedRecognitionLanguages()
    let mapping = ["por": "pt-BR", "eng": "en-US", "spa": "es-ES"]
    let codes = language.split(separator: "+").map(String.init)
    guard !codes.isEmpty, codes.allSatisfy({ mapping[$0] != nil }) else {
        throw LocalError(message: "Idioma de OCR inválido.")
    }
    let wanted = codes.compactMap { mapping[$0] }
    guard wanted.allSatisfy({ supported.contains($0) }) else {
        throw LocalError(message: "Atualize o macOS: este sistema não oferece todos os idiomas selecionados.")
    }
    request.recognitionLanguages = wanted
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let candidates = (request.results ?? []).compactMap { $0.topCandidates(1).first }
    let text = candidates.map(\.string).joined(separator: "\n")
    let confidence: Any
    if candidates.isEmpty { confidence = NSNull() }
    else { confidence = Double(candidates.reduce(Float(0)) { $0 + $1.confidence }) / Double(candidates.count) * 100 }
    return ["text": text, "confidence": confidence, "engine": "apple-vision"]
}

func recognizePayload(_ body: Data) throws -> [String: Any] {
    guard let payload = try JSONSerialization.jsonObject(with: body) as? [String: Any],
          let encoded = payload["image"] as? String,
          let data = Data(base64Encoded: encoded),
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
          let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
          let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
          width > 0, height > 0, width <= 14000, height <= 14000, width * height <= 20000000,
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw LocalError(message: "A imagem enviada ao OCR local é inválida ou grande demais.")
    }
    return try recognize(image, language: payload["language"] as? String ?? "por+eng")
}

final class HTTPConnection {
    let connection: NWConnection
    var buffer = Data()
    var finished = false

    init(_ connection: NWConnection) {
        self.connection = connection
        connection.start(queue: queue)
        receive()
    }

    func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
            if let data = data { self.buffer.append(data) }
            if self.buffer.count > maximumBody + 16384 {
                self.respond(413, ["error": "A imagem excede o limite de tamanho."]); return
            }
            if self.handle() { return }
            if complete || error != nil { self.close(); return }
            self.receive()
        }
    }

    func handle() -> Bool {
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            if buffer.count > 16384 { respond(400, ["error": "Cabeçalho inválido."]); return true }
            return false
        }
        let lines = String(decoding: buffer[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        guard parts.count == 3 else { respond(400, ["error": "Requisição inválida."]); return true }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[String(line[..<colon]).lowercased()] = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        }
        let origin = headers["origin"]
        guard origin == nil || origins.contains(origin!) else { respond(403, ["error": "Site não autorizado."]); return true }
        let method = String(parts[0]), path = String(parts[1])
        if method == "OPTIONS", origin != nil, ["/health", "/recognize"].contains(path) {
            respond(204, [:], origin: origin); return true
        }
        if method == "GET", path == "/health" {
            respond(200, ["engine": "apple-vision", "version": 1, "status": "ready"], origin: origin); return true
        }
        guard method == "POST", path == "/recognize" else { respond(404, ["error": "Operação desconhecida."], origin: origin); return true }
        guard origin != nil else { respond(403, ["error": "A origem do site é obrigatória."]); return true }
        guard headers["transfer-encoding"] == nil,
              headers["content-type"]?.hasPrefix("application/json") == true,
              let length = Int(headers["content-length"] ?? ""), length > 0, length <= maximumBody else {
            respond(400, ["error": "Corpo da requisição inválido."], origin: origin); return true
        }
        guard buffer.count >= end.upperBound + length else { return false }
        let body = Data(buffer[end.upperBound..<(end.upperBound + length)])
        do {
            let result = try autoreleasepool { try recognizePayload(body) }
            respond(200, result, origin: origin)
        } catch {
            let message = (error as? LocalError)?.message ?? "Não foi possível reconhecer esta página no Mac."
            respond(400, ["error": message], origin: origin)
        }
        return true
    }

    func respond(_ status: Int, _ value: [String: Any], origin: String? = nil) {
        guard !finished else { return }
        finished = true
        let body = status == 204 ? Data() : (try? JSONSerialization.data(withJSONObject: value)) ?? Data()
        var header = "HTTP/1.1 \(status) Response\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\n"
        if let origin = origin, origins.contains(origin) {
            header += "Access-Control-Allow-Origin: \(origin)\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\n"
        }
        var response = Data((header + "\r\n").utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { _ in self.close() })
    }

    func close() { buffer.removeAll(); connection.cancel() }
}

func startServer() throws -> NWListener {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
    let listener = try NWListener(using: parameters)
    listener.newConnectionHandler = { _ = HTTPConnection($0) }
    listener.stateUpdateHandler = { state in
        if case .failed(let error) = state {
            fputs("Não foi possível iniciar o OCR local: \(error.localizedDescription)\n", stderr)
            if CommandLine.arguments.contains("--server-only") { exit(1) }
            DispatchQueue.main.async {
                let alert = NSAlert(); alert.messageText = "Não foi possível iniciar o OCR local"
                alert.informativeText = "Confira se o Lume OCR Mac já está aberto. Feche uma das cópias e tente novamente."
                alert.runModal(); NSApplication.shared.terminate(nil)
            }
        }
    }
    listener.start(queue: queue)
    return listener
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var listener: NWListener?
    var statusItem: NSStatusItem?
    func applicationDidFinishLaunching(_ notification: Notification) {
        do { listener = try startServer() } catch { NSApplication.shared.terminate(nil); return }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem?.button?.title = "Lume OCR"
        let menu = NSMenu()
        let status = NSMenuItem(title: "Apple Vision ativo neste Mac", action: nil, keyEquivalent: "")
        menu.addItem(status)
        let open = NSMenuItem(title: "Abrir site", action: #selector(openSite), keyEquivalent: "")
        open.target = self; menu.addItem(open)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Encerrar OCR local", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self; menu.addItem(quit)
        statusItem?.menu = menu
        openSite()
    }
    @objc func openSite() { NSWorkspace.shared.open(URL(string: site)!) }
    @objc func quitApp() { listener?.cancel(); NSApplication.shared.terminate(nil) }
}

func selfTest() throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1500, pixelsHigh: 800, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1500, height: 800).fill()
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 36), .foregroundColor: NSColor.black]
    let lines = ["Conversão de documentos em português.", "Informação, educação e comunicação.", "Uma transcrição deve preservar acentuação.", "Este relatório contém o número 12345."]
    for (index, line) in lines.enumerated() {
        NSAttributedString(string: line, attributes: attributes).draw(at: NSPoint(x: 60, y: CGFloat(650 - index * 90)))
    }
    NSGraphicsContext.restoreGraphicsState()
    let result = try recognize(bitmap.cgImage!, language: "por+eng")
    let text = result["text"] as? String ?? ""
    guard ["português", "acentuação", "12345"].allSatisfy({ text.contains($0) }) else {
        throw LocalError(message: "O teste de OCR nativo falhou: \(text)")
    }
    print("Apple Vision OCR OK: português, acentuação e 12345.")
    if let output = CommandLine.arguments.firstIndex(of: "--fixture"), output + 1 < CommandLine.arguments.count {
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[output + 1]))
    }
}

if CommandLine.arguments.contains("--self-test") {
    do { try selfTest(); exit(0) } catch {
        fputs("\((error as? LocalError)?.message ?? error.localizedDescription)\n", stderr); exit(1)
    }
} else if CommandLine.arguments.contains("--server-only") {
    do { let server = try startServer(); withExtendedLifetime(server) { dispatchMain() } }
    catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
} else {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { application.run() }
}
