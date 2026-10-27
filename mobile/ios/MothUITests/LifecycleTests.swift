import XCTest

/// Locking on background and on idle, and surviving a kill in the middle of sync.
final class LifecycleTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testBackgroundLocks() {
        let app = XCUIApplication()
        app.launch()
        unlockOrCreate(app)

        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 3)
        app.activate()
        XCTAssertTrue(app.staticTexts["Moth is locked"].waitForExistence(timeout: 30), "locked after the background")
        XCTAssertFalse(app.navigationBars["Moth"].exists, "wallet not shown")
    }

    /// The idle watcher checks every 20 seconds, so a 1-minute lock lands within about 80 seconds.
    func testAutoLockAfterOneMinute() {
        let app = XCUIApplication()
        app.launch()
        unlockOrCreate(app)

        app.tabBars.buttons["Settings"].tap()
        reveal(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Auto-lock'")).firstMatch, in: app).tap()
        app.buttons["After 1 minute"].tap()
        app.tabBars.buttons["Wallet"].tap()

        let started = Date()
        XCTAssertTrue(app.staticTexts["Moth is locked"].waitForExistence(timeout: 150), "auto-locked when idle")
        XCTAssertGreaterThan(Date().timeIntervalSince(started), 50, "not before the minute was up")
    }

    func testKilledMidSyncRecovers() {
        let app = XCUIApplication()
        app.launch()
        unlockOrCreate(app)
        // Sync starts on unlock; kill the app while it runs.
        Thread.sleep(forTimeInterval: 5)
        app.terminate()

        app.launch()
        unlockOrCreate(app)
        app.buttons["Generate DUST from NIGHT"].tap()
        XCTAssertTrue(app.buttons["Register NIGHT for DUST"].waitForEnabled(timeout: 180), "synced after relaunch")
    }
}
