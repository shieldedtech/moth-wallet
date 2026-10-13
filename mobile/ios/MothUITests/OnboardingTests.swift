import XCTest

/// Creates a wallet on preprod, backs it up, unlocks it and checks its receive address.
///
/// Needs network access, and Face ID enrolled and matching on the simulator, which
/// scripts/ui-test.sh arranges.
final class OnboardingTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testCreateBackUpUnlockReceive() {
        let app = XCUIApplication()
        app.launch()

        let create = app.buttons["Create a new wallet"]
        XCTAssertTrue(create.waitForExistence(timeout: 60), "welcome screen")
        create.tap()

        XCTAssertTrue(app.staticTexts["Your recovery phrase"].waitForExistence(timeout: 60), "backup screen")
        let confirm = app.switches.firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        // A SwiftUI Toggle's tappable area is its inner switch.
        confirm.switches.firstMatch.tap()
        app.buttons["Continue"].tap()

        // Unlocking prompts for Face ID; the script answers it with a match.
        XCTAssertTrue(app.navigationBars["Moth"].waitForExistence(timeout: 120), "home screen after unlock")
        XCTAssertTrue(app.staticTexts["Balances"].exists || app.staticTexts["BALANCES"].exists)

        app.buttons["Receive"].tap()
        let address = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'mn_addr_preprod1'")).firstMatch
        XCTAssertTrue(address.waitForExistence(timeout: 10), "unshielded receive address")
        app.buttons["Done"].tap()

        app.buttons["Lock"].tap()
        XCTAssertTrue(app.staticTexts["Moth is locked"].waitForExistence(timeout: 30), "locked screen")
    }
}
