// Face rectangles for each image path, as normalized x,y,w,h (top-left origin).
// Uses the macOS Vision framework — no model download, no Python.
import Foundation
import Vision
import AppKit

let request = VNDetectFaceRectanglesRequest()

for path in CommandLine.arguments.dropFirst() {
    guard let image = NSImage(contentsOfFile: path),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("\(path)\t")
        continue
    }
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([request])
    let boxes: [String] = (request.results ?? []).map { observation in
        let b = observation.boundingBox // origin bottom-left
        let x = b.origin.x
        let y = 1.0 - b.origin.y - b.size.height
        return String(format: "%.4f,%.4f,%.4f,%.4f", x, y, b.size.width, b.size.height)
    }
    print("\(path)\t\(boxes.joined(separator: ";"))")
}
