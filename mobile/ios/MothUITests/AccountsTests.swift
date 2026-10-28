import XCTest

/// Adds a second account, switches between accounts, and moves an account to preprod.
final class AccountsTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testSecondAccountAndNetworkSwitch() {
        let app = XCUIApplication()
        app.launch()
        unlockOrCreate(app)

        app.tabBars.buttons["Settings"].tap()
        app.buttons["New account"].tap()
        XCTAssertTrue(app.staticTexts["Your recovery phrase"].waitForExistence(timeout: 60), "second account's phrase")
        app.switches.firstMatch.switches.firstMatch.tap()
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.navigationBars["Moth"].waitForExistence(timeout: 120), "second account unlocked")
        XCTAssertTrue(header(app, "account-2").waitForExistence(timeout: 10), "second account is active")

        app.tabBars.buttons["Settings"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Main'")).firstMatch.tap()
        // Switching locks, then the locked screen asks for Face ID, which the script matches.
        XCTAssertTrue(header(app, "Main ·").waitForExistence(timeout: 120), "main account unlocked and active")

        // Rename the active account from its options menu; the wallet header follows.
        app.tabBars.buttons["Settings"].tap()
        // XCUITest computes no hit point for a Menu inside a Form row (it reports the button as
        // not hittable although it is on screen), so tap the centre of its frame instead.
        let options = app.buttons["Main options"]
        XCTAssertTrue(options.waitForExistence(timeout: 10), "account options menu")
        options.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["Rename"].waitForExistence(timeout: 5), "options menu opened")
        app.buttons["Rename"].tap()
        let name = app.alerts.textFields.firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + "Savings")
        app.alerts.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["Savings options"].waitForExistence(timeout: 10), "renamed in Settings")
        app.tabBars.buttons["Wallet"].tap()
        XCTAssertTrue(header(app, "Savings ·").waitForExistence(timeout: 10), "renamed in the wallet header")

        app.tabBars.buttons["Settings"].tap()
        reveal(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Network'")).firstMatch, in: app).tap()
        app.buttons["preprod"].tap()
        app.tabBars.buttons["Wallet"].tap()
        XCTAssertTrue(header(app, "· preprod").waitForExistence(timeout: 60), "account moved to preprod")
    }

    /// The wallet header is a List section header, which iOS shows in capitals, so match any case.
    private func header(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
    }
}
