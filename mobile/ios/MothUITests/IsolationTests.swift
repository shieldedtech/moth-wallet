import XCTest

/// What a page in Moth's DApp browser can reach beyond the connector API. Uses the probe page in
/// Fixtures/, which scripts/ui-test.sh serves on port 5175.
final class IsolationTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func openProbe(_ app: XCUIApplication) -> XCUIElement {
        app.launch()
        unlockOrCreate(app)
        app.tabBars.buttons["Browser"].tap()
        let address = app.textFields["DApp address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText("http://127.0.0.1:5175/\n")
        let web = app.webViews["dapp"]
        XCTAssertTrue(web.staticTexts["Isolation probe"].waitForExistence(timeout: 30), "probe page loaded")
        return web
    }

    /// Moth's script is injected into the main frame only, and the reply handler refuses any call
    /// from a child frame, so an embedded page can neither see nor use the connector.
    func testChildFrameCannotUseConnector() {
        let app = XCUIApplication()
        let web = openProbe(app)

        let frame = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'frame: injected='")).firstMatch
        XCTAssertTrue(frame.waitForExistence(timeout: 30), "child frame reported")
        XCTAssertTrue(frame.label.contains("injected=undefined"), "no window.midnight in a child frame: \(frame.label)")
        XCTAssertTrue(frame.label.contains("PermissionRejected"), "handler refused the child frame: \(frame.label)")
        XCTAssertFalse(app.navigationBars["Connect"].exists, "no approval sheet for a child frame")
    }

    /// A DApp page must not be able to read Moth's in-app proof server or engine origin. The proof
    /// server listens on 127.0.0.1:6300 while Moth is open. The probe page is served over http on
    /// localhost, the one kind of http page Moth's browser opens; WebKit's mixed-content rules
    /// already stop an https page reaching the prover.
    ///
    /// The proof server's CORS policy is permissive today, so the prover checks are expected to
    /// fail. Once it is narrowed they pass, the expectation itself fails, and it should be removed.
    func testPageCannotReadProverOrEngine() {
        let app = XCUIApplication()
        let web = openProbe(app)

        web.buttons["Probe"].tap()
        let engine = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'engine: '")).firstMatch
        XCTAssertTrue(engine.waitForExistence(timeout: 10))
        // The POST probe runs last.
        let post = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'post: '")).firstMatch
        let done = NSPredicate(format: "NOT label CONTAINS 'not run'")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: done, object: post)], timeout: 30), .completed)
        XCTAssertTrue(engine.label.hasPrefix("engine: blocked"), "engine origin readable from a DApp: \(engine.label)")
        XCTExpectFailure("The proof server allows any origin, so a localhost http page can read and call it")
        // Report each probe, not just the first.
        continueAfterFailure = true
        for name in ["prover", "ready", "post"] {
            let line = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", name + ": ")).firstMatch
            XCTAssertTrue(line.label.hasPrefix(name + ": blocked"), "proof server readable from a DApp: \(line.label)")
        }
    }
}
