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

        app.switches["Face ID only, no passcode"].switches.firstMatch.tap()
        let accept = app.buttons["I've written down every phrase — turn on"]
        XCTAssertTrue(accept.waitForExistence(timeout: 5), "implications shown before turning on")
        accept.tap()
        // Re-protecting the keys asks for Face ID once; the script matches it.
        let faceOnly = app.switches["Face ID only, no passcode"]
        XCTAssertTrue(NSPredicate(format: "value == '1'").evaluate(with: faceOnly) || faceOnly.waitForValue("1", timeout: 30), "Face ID only is on")

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
        app.switches["Face ID only, no passcode"].switches.firstMatch.tap()
        XCTAssertTrue(app.switches["Face ID only, no passcode"].waitForValue("0", timeout: 30), "Face ID only is off")
    }
}

extension XCUIElement {
    func waitForValue(_ value: String, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "value == %@", value)
        return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: self)], timeout: timeout) == .completed
    }
}
