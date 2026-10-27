import XCTest

/// Walks every path that handles the recovery phrase. scripts/ui-test.sh then searches the system
/// log and the app's files for the phrase and its seed, and fails the run if either holds them.
///
/// The phrase is written to $MOTH_CONTROL/phrase for that scan; the script deletes it afterwards.
/// XCTest echoes the first words it types into the test output, so the wallet is one created for
/// this run and never funded.
final class RecoveryPhraseLeakTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testPhrasePathsForScan() throws {
        let dir = try XCTUnwrap(ProcessInfo.processInfo.environment["MOTH_CONTROL"], "run through scripts/ui-test.sh")
        let app = XCUIApplication()
        app.launch()

        // Create and back up, reading the phrase off the screen. Each word follows its number.
        app.buttons["Create a new wallet"].tap()
        XCTAssertTrue(app.staticTexts["Your recovery phrase"].waitForExistence(timeout: 60), "backup screen")
        let labels = app.staticTexts.allElementsBoundByIndex.map(\.label)
        let words = (1...24).compactMap { n in labels.firstIndex(of: "\(n)").flatMap { $0 + 1 < labels.count ? labels[$0 + 1] : nil } }
        XCTAssertEqual(words.count, 24, "read all 24 words")
        XCTAssertTrue(words.allSatisfy { $0.range(of: "^[a-z]+$", options: .regularExpression) != nil }, "words look like BIP-39 words")
        let phrase = words.joined(separator: " ")
        try phrase.write(to: URL(fileURLWithPath: dir).appendingPathComponent("phrase"), atomically: true, encoding: .utf8)
        app.switches.firstMatch.switches.firstMatch.tap()
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.navigationBars["Moth"].waitForExistence(timeout: 120), "unlocked")

        // Use the seed: sync, then a request that reaches the prover.
        app.buttons["Generate DUST from NIGHT"].tap()
        let register = app.buttons["Register NIGHT for DUST"]
        XCTAssertTrue(register.waitForEnabled(timeout: 180), "synced")
        register.tap()
        XCTAssertTrue(app.staticTexts["This account has no NIGHT to register."].waitForExistence(timeout: 60), "prover answered")
        app.alerts.buttons["OK"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Show the phrase again.
        app.tabBars.buttons["Settings"].tap()
        app.buttons["Show recovery phrase"].tap()
        XCTAssertTrue(app.staticTexts["24"].waitForExistence(timeout: 30), "phrase shown again")
        app.buttons["Done"].tap()

        // Import a phrase that fails its checksum, then the real one. Either may end in an alert
        // (a duplicate, say); what matters is that neither writes the words anywhere.
        var swapped = words
        swapped.swapAt(0, 1)
        for attempt in [swapped.joined(separator: " "), phrase] {
            app.tabBars.buttons["Settings"].tap()
            reveal(app.buttons["Import a recovery phrase"], in: app).tap()
            let editor = app.textViews.firstMatch
            XCTAssertTrue(editor.waitForExistence(timeout: 10), "import sheet")
            editor.tap()
            editor.typeText(attempt)
            app.buttons["Restore"].tap()
            let failed = app.alerts["Something went wrong"]
            if failed.waitForExistence(timeout: 15) { failed.buttons.firstMatch.tap() }
            if app.tabBars.buttons["Wallet"].exists { app.tabBars.buttons["Wallet"].tap() }
            unlockOrCreate(app)
        }

        app.terminate()
        app.launch()
        unlockOrCreate(app)
    }
}
