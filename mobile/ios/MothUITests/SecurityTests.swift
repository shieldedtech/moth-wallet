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
    /// which the script matches, but the simulator now and then rejects the match anyway (alert
    /// "Authentication failure.", no Face ID sheet shown), so one rejection is retried.
    private func setFaceIDOnly(_ on: Bool, in app: XCUIApplication) -> Bool {
        let toggle = app.switches["Face ID only, no passcode"]
        let rejected = app.alerts.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Authentication failure'")).firstMatch
        for _ in 0..<2 {
            // The toggle is disabled while the wallet is busy, which includes starting sync after
            // unlock; on CI that has taken over 10 s, and a tap on it then does nothing.
            XCTAssertTrue(toggle.waitForEnabled(timeout: 60), "Face ID only can be changed")
            toggle.switches.firstMatch.tap()
            if on {
                let accept = app.buttons["I've written down every phrase — turn on"]
                XCTAssertTrue(accept.waitForExistence(timeout: 5), "implications shown before turning on")
                accept.tap()
            }
            let deadline = Date().addingTimeInterval(30)
            while Date() < deadline, toggle.value as? String != (on ? "1" : "0"), !rejected.exists {
                _ = rejected.waitForExistence(timeout: 1)
            }
            if toggle.value as? String == (on ? "1" : "0") { return true }
            guard rejected.exists else { return false }
            app.alerts.buttons["OK"].tap()
        }
        return false
    }
}
