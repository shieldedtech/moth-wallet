import XCTest

/// Turns on both security options and checks the wallet still opens and actions still run.
final class SecurityTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testFaceIDOptions() {
        let app = XCUIApplication()
        app.launch()
        unlockOrCreate(app)

        app.tabBars.buttons["Settings"].tap()
        let perTransaction = app.switches["Face ID for every transaction"]
        XCTAssertTrue(perTransaction.waitForExistence(timeout: 10))
        perTransaction.switches.firstMatch.tap()

        XCTAssertTrue(setFaceIDOnly(true, in: app), "Face ID only is on")

        // The keys still open after a relaunch, with Face ID.
        app.terminate()
        app.launch()
        XCTAssertTrue(app.navigationBars["Moth"].waitForExistence(timeout: 120), "unlocked with Face ID only")

        // A gated action asks for Face ID, then runs.
        app.buttons["Generate DUST from NIGHT"].tap()
        let register = app.buttons["Register NIGHT for DUST"]
        XCTAssertTrue(register.waitForEnabled(timeout: 180), "synced")
        register.tap()
        XCTAssertTrue(app.staticTexts["This account has no NIGHT to register."].waitForExistence(timeout: 60), "ran after Face ID")
        app.alerts.buttons["OK"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Turning it off puts the passcode fallback back.
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(setFaceIDOnly(false, in: app), "Face ID only is off")
    }

    /// Flips "Face ID only" and waits for it to take. Re-protecting the keys asks for Face ID once,
    /// which the script matches. An attempt can still end without the change, and is retried:
    /// - the simulator rejects the match anyway (alert "Authentication failure.", no Face ID sheet);
    /// - iOS cancels the prompt itself, which the app treats like the user dismissing it, so the
    ///   toggle just stays where it was, with no alert;
    /// - the tap is lost in a redraw, so the confirmation for turning it on never appears.
    /// A change that never takes still fails, after three attempts.
    private func setFaceIDOnly(_ on: Bool, in app: XCUIApplication) -> Bool {
        let toggle = app.switches["Face ID only, no passcode"]
        let want = on ? "1" : "0"
        let rejected = app.alerts.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Authentication failure'")).firstMatch
        let accept = app.buttons["I've written down every phrase — turn on"]
        for _ in 0..<3 {
            // The toggle is disabled while the wallet is busy, which includes starting sync after
            // unlock; on CI that has taken over a minute, and a tap on it then does nothing.
            XCTAssertTrue(toggle.waitForEnabled(timeout: firstScreenTimeout), "Face ID only can be changed")
            if toggle.value as? String == want { return true }
            toggle.switches.firstMatch.tap()
            if on {
                guard accept.waitForExistence(timeout: 5) else { continue }
                accept.tap()
            }
            let deadline = Date().addingTimeInterval(30)
            while Date() < deadline, toggle.value as? String != want, !rejected.exists {
                _ = rejected.waitForExistence(timeout: 1)
            }
            if toggle.value as? String == want { return true }
            if rejected.exists { app.alerts.buttons["OK"].tap() }
        }
        return toggle.value as? String == want
    }
}
