import XCTest

/// Surviving a kill in the middle of the first sync. A class of its own, so it runs on a fresh
/// install: a wallet that has synced before restores from its cache and is done almost at once.
final class SyncInterruptTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testKilledMidSyncRecovers() {
        let app = XCUIApplication()
        app.launch()
        unlockOrCreate(app)
        // Sync starts on unlock. Registering is disabled until it finishes, so kill the app while
        // it still is.
        app.buttons["Generate DUST from NIGHT"].tap()
        let register = app.buttons["Register NIGHT for DUST"]
        XCTAssertTrue(register.waitForExistence(timeout: 30))
        XCTAssertFalse(register.isEnabled, "killed before the first sync finished")
        app.terminate()

        app.launch()
        unlockOrCreate(app)
        app.buttons["Generate DUST from NIGHT"].tap()
        XCTAssertTrue(register.waitForEnabled(timeout: 180), "synced after relaunch")
    }
}
