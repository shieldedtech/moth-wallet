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
        // Sync starts on unlock, with a spinner until it finishes; kill the app while it runs.
        XCTAssertTrue(app.activityIndicators.firstMatch.waitForExistence(timeout: 30), "sync in progress")
        app.terminate()

        app.launch()
        unlockOrCreate(app)
        app.buttons["Generate DUST from NIGHT"].tap()
        XCTAssertTrue(app.buttons["Register NIGHT for DUST"].waitForEnabled(timeout: 180), "synced after relaunch")
    }
}
