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

        // Registering DUST reaches the prover before anything else; an empty wallet then has
        // nothing to register, so this message proves the prover answered.
        app.buttons["Generate DUST from NIGHT"].tap()
        let register = app.buttons["Register NIGHT for DUST"]
        XCTAssertTrue(register.waitForEnabled(timeout: 180), "synced")
        register.tap()
        let nothing = app.staticTexts["This account has no NIGHT to register."]
        XCTAssertTrue(nothing.waitForExistence(timeout: 60), "prover reachable, nothing to register")
        app.alerts.buttons["OK"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        app.buttons["Receive"].tap()
        let address = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'mn_addr_preview1'")).firstMatch
        XCTAssertTrue(address.waitForExistence(timeout: 10), "unshielded receive address")
        app.buttons["Done"].tap()

        app.tabBars.buttons["Settings"].tap()
        app.buttons["Show recovery phrase"].tap()
        XCTAssertTrue(app.navigationBars["Recovery phrase"].waitForExistence(timeout: 30), "phrase shown after Face ID")
        XCTAssertTrue(app.staticTexts["24"].waitForExistence(timeout: 10), "all 24 words listed")
        app.buttons["Done"].tap()
        app.tabBars.buttons["Wallet"].tap()

        app.buttons["Lock"].tap()
        XCTAssertTrue(app.staticTexts["Moth is locked"].waitForExistence(timeout: 30), "locked screen")

        // The wallet is stored in the engine's IndexedDB, which must survive a relaunch.
        app.terminate()
        app.launch()
        XCTAssertTrue(app.navigationBars["Moth"].waitForExistence(timeout: 120), "existing wallet unlocked after relaunch")
    }
}
