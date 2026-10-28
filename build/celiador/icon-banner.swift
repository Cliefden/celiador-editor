// Stamps a coloured banner with white text across the bottom of PNG icons, in
// place, so dev and test builds are told apart on the home screen / Dock —
// red with the commit for dev, green with the release tag for test, as
// Celindor's scripts/ios-icon-banner.sh does with ImageMagick. This one needs
// nothing but the Swift toolchain, so it runs on Xcode Cloud and the Mac runner.
//
//   swift icon-banner.swift [--keep-alpha] <#rrggbb> <text> <icon.png>...
//
// The banner is the bottom 22% of the icon; the text is sized to fit 84% of the
// width and 62% of the band, bold, centred. Output is opaque (iOS icons must
// be) unless --keep-alpha is given (macOS .iconset PNGs have transparent
// corners that must stay transparent).
//
// The same file lives in celiador-ios/scripts and celiador-editor/build/celiador.
import AppKit
import Foundation

func fail(_ message: String) -> Never {
	FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
	exit(1)
}

var args = Array(CommandLine.arguments.dropFirst())
var keepAlpha = false
if args.first == "--keep-alpha" {
	keepAlpha = true
	args.removeFirst()
}
guard args.count >= 3 else { fail("usage: icon-banner.swift [--keep-alpha] <#rrggbb> <text> <icon.png>...") }
let colourArg = args[0]
let text = args[1]
let files = args.dropFirst(2)

let hex = colourArg.hasPrefix("#") ? String(colourArg.dropFirst()) : colourArg
guard hex.count == 6, let rgb = UInt32(hex, radix: 16) else { fail("colour must be #rrggbb, got \(colourArg)") }
let colour = NSColor(
	red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255,
	blue: CGFloat(rgb & 0xff) / 255, alpha: 1)

for file in files {
	let url = URL(fileURLWithPath: file)
	guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
	      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("cannot read \(file)") }
	let width = image.width, height = image.height
	let alphaInfo: CGImageAlphaInfo = keepAlpha ? .premultipliedLast : .noneSkipLast
	guard let ctx = CGContext(
		data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
		space: CGColorSpace(name: CGColorSpace.sRGB)!,
		bitmapInfo: alphaInfo.rawValue) else { fail("cannot create a bitmap for \(file)") }
	if !keepAlpha {
		ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
		ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
	}
	ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

	// With alpha kept, the band is clipped to the icon's own shape (its
	// non-transparent pixels), so rounded corners stay rounded.
	let band = CGFloat(height) * 0.22
	ctx.saveGState()
	if keepAlpha {
		ctx.clip(to: CGRect(x: 0, y: 0, width: width, height: height), mask: image)
	}
	ctx.setFillColor(colour.cgColor)
	ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: band))

	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
	// Largest bold size whose rendered text fits the box.
	let maxWidth = CGFloat(width) * 0.84, maxHeight = band * 0.62
	var size = band
	var attributed: NSAttributedString
	var bounds: CGRect
	repeat {
		let font = NSFont.systemFont(ofSize: size, weight: .bold)
		attributed = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor.white])
		bounds = attributed.boundingRect(with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude), options: [.usesLineFragmentOrigin])
		size *= 0.92
	} while (bounds.width > maxWidth || bounds.height > maxHeight) && size > 1
	let origin = CGPoint(x: (CGFloat(width) - bounds.width) / 2 - bounds.minX, y: (band - bounds.height) / 2 - bounds.minY)
	attributed.draw(at: origin)
	NSGraphicsContext.restoreGraphicsState()
	ctx.restoreGState()

	guard let output = ctx.makeImage(),
	      let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { fail("cannot write \(file)") }
	CGImageDestinationAddImage(destination, output, nil)
	guard CGImageDestinationFinalize(destination) else { fail("cannot finalize \(file)") }
}
print("stamped \(files.count) icon(s): \(text) on \(colourArg)")
