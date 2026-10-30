// swift-tools-version: 5.9
// The floating ring. Build with ./build.sh (needs Xcode for VoiceRingKit's Metal shader).
import PackageDescription
import Foundation

let plist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "codex-voice-ring",
    platforms: [.macOS(.v14)],
    dependencies: [
        // VoiceRingKit (MIT): https://libraries.dev/voice-ring
        .package(url: "https://github.com/Jakubantalik/Libraries.dev", branch: "main"),
    ],
    targets: [
        .executableTarget(
            name: "codex-voice-ring",
            dependencies: [.product(name: "VoiceRingKit", package: "Libraries.dev")],
            path: "Sources",
            // Embedded so macOS shows the mic prompt for a bare binary.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist])]
        ),
    ]
)
