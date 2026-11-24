import XCTest

/// Chooses how scripts/ui-test.sh answers the simulator's Face ID prompts from now on.
///
/// The script polls a control file every 2 seconds and sends a matching or a non-matching face.
/// It resets the answer to a match before each class, not before each test, so a test that depends
/// on the answer sets it first. Returns once the new answer has been sent, so no earlier answer
/// still on its way can reach a prompt opened after this.
enum FaceID {
    enum Answer: String {
        case match, nomatch
    }

    static func answer(_ answer: Answer) {
        guard let dir = ProcessInfo.processInfo.environment["MOTH_CONTROL"] else {
            XCTFail("MOTH_CONTROL is not set; run the UI tests through scripts/ui-test.sh")
            return
        }
        let control = URL(fileURLWithPath: dir)
        let sent = control.appendingPathComponent("faceid.sent")
        try? FileManager.default.removeItem(at: sent)
        XCTAssertNoThrow(try answer.rawValue.write(to: control.appendingPathComponent("faceid"), atomically: true, encoding: .utf8))
        // A post that read the old answer before the write may still finish after it, and then
        // records the old answer; wait for one that sent the new one.
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline {
            let last = try? String(contentsOf: sent, encoding: .utf8)
            if last?.trimmingCharacters(in: .whitespacesAndNewlines) == answer.rawValue { return }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTFail("scripts/ui-test.sh did not send the \(answer.rawValue) answer within 60 seconds")
    }
}

/// The system UI that hosts Face ID failures and the passcode fallback.
let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

extension FaceID {
    /// The alert a non-matching face brings up. Its title follows the simulator's locale ("Face Not
    /// Recognised" in en_GB, "Face Not Recognized" in en_US), so it is matched by the shared stem.
    static var notRecognisedAlert: XCUIElement {
        springboard.alerts.matching(NSPredicate(format: "label BEGINSWITH 'Face Not Recogni'")).firstMatch
    }

    /// Cancels the failure alert. The alert is found while it is still appearing, and a tap then is
    /// lost and leaves the prompt open, so tap again until it has closed.
    static func cancelFailure(attempts: Int = 3) {
        let alert = notRecognisedAlert
        for _ in 0..<attempts {
            // It may have closed just after the last wait gave up.
            guard alert.exists else { return }
            alert.buttons["Cancel"].firstMatch.tap()
            if alert.waitForNonExistence(timeout: 5) { return }
        }
        XCTFail("the Face ID failure alert stayed open after \(attempts) taps on Cancel")
    }
}
