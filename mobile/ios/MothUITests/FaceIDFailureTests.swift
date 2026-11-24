import XCTest

/// Face ID that fails must leave gated actions unrun and settings unchanged.
///
/// Only checks made with LAContext.evaluatePolicy are covered. The simulator does not enforce the
/// Keychain's access control, so reading the wallet key on unlock never prompts here, and an
/// unlock failure can only be tested on a device.
final class FaceIDFailureTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        // The answer carries over from the previous test in this class.
        FaceID.answer(.match)
    }

    func testGatedActionNeedsAMatch() {
        let app = XCUIApplication()
        app.launch()
        unlockOrCreate(app)

        app.tabBars.buttons["Settings"].tap()
        app.switches["Face ID for every transaction"].switches.firstMatch.tap()
        app.tabBars.buttons["Wallet"].tap()
        app.buttons["Generate DUST from NIGHT"].tap()
        let register = app.buttons["Register NIGHT for DUST"]
        XCTAssertTrue(register.waitForEnabled(timeout: 180), "synced")

        // A face that doesn't match, then Cancel: nothing runs and no error is shown.
        FaceID.answer(.nomatch)
        register.tap()
        let failed = FaceID.notRecognisedAlert
        XCTAssertTrue(failed.waitForExistence(timeout: 30), "Face ID failed")
        FaceID.cancelFailure()
        let ran = app.staticTexts["This account has no NIGHT to register."]
        XCTAssertFalse(ran.waitForExistence(timeout: 10), "registration ran without a match")
        XCTAssertFalse(app.alerts["Something went wrong"].exists, "cancelling is not an error")
        XCTAssertTrue(register.waitForEnabled(timeout: 10), "the action can be tried again")

        // The same action with a match runs.
        FaceID.answer(.match)
        register.tap()
        XCTAssertTrue(ran.waitForExistence(timeout: 60), "ran after a match")
        app.alerts.buttons["OK"].tap()
    }

    func testFaceIDOnlyNotChangedWithoutAMatch() {
        let app = XCUIApplication()
        app.launch()
        unlockOrCreate(app)

        app.tabBars.buttons["Settings"].tap()
        FaceID.answer(.nomatch)
        let faceOnly = app.switches["Face ID only, no passcode"]
        // Disabled while sync starts after unlock, and a tap on it then does nothing.
        XCTAssertTrue(faceOnly.waitForEnabled(timeout: 60), "Face ID only can be changed")
        faceOnly.switches.firstMatch.tap()
        app.buttons["I've written down every phrase — turn on"].tap()
        let failed = FaceID.notRecognisedAlert
        XCTAssertTrue(failed.waitForExistence(timeout: 30), "Face ID failed")
        FaceID.cancelFailure()
        // The switch is disabled until the change has finished; only then is its value final.
        XCTAssertTrue(faceOnly.waitForEnabled(timeout: 30), "the change finished")
        XCTAssertEqual(faceOnly.value as? String, "0", "still off")
    }
}
