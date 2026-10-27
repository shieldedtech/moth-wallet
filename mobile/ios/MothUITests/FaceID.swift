import XCTest

/// Chooses how scripts/ui-test.sh answers the simulator's Face ID prompts from now on.
///
/// The script polls a control file every 2 seconds and sends a matching face, a non-matching
/// face, or nothing. The default, and the state at the start of every class, is a match.
enum FaceID {
    enum Answer: String {
        case match, nomatch, off
    }

    static func answer(_ answer: Answer) {
        guard let dir = ProcessInfo.processInfo.environment["MOTH_CONTROL"] else {
            XCTFail("MOTH_CONTROL is not set; run the UI tests through scripts/ui-test.sh")
            return
        }
        let file = URL(fileURLWithPath: dir).appendingPathComponent("faceid")
        XCTAssertNoThrow(try answer.rawValue.write(to: file, atomically: true, encoding: .utf8))
        // Let a poll pass, so a prompt shown next gets the new answer.
        Thread.sleep(forTimeInterval: 3)
    }
}

/// The system UI that hosts Face ID failures and the passcode fallback.
let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
