import XCTest

/// Receive to DUST, the address book in Send, batch recipients and auto-lock, without funds.
final class FeaturesTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testReceiveDustContactsBatchAndAutoLock() {
        let app = XCUIApplication()
        app.launch()
        unlockOrCreate(app)

        // Receive: the DUST tab shows this account's DUST address.
        app.buttons["Receive"].tap()
        app.buttons["DUST"].tap()
        let dust = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'mn_dust'")).firstMatch
        XCTAssertTrue(dust.waitForExistence(timeout: 10), "DUST address shown")
        let unshielded = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'mn_addr'")).firstMatch
        app.buttons["Cardano"].tap()
        let cardano = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'addr_test1q'")).firstMatch
        XCTAssertTrue(cardano.waitForExistence(timeout: 60), "Cardano base address derived")
        app.buttons["Unshielded"].tap()
        XCTAssertTrue(unshielded.waitForExistence(timeout: 10))
        let ownAddress = unshielded.label
        app.buttons["Done"].tap()

        // Send covers Cardano too.
        app.buttons["Send"].tap()
        app.buttons["Cardano"].tap()
        XCTAssertTrue(app.textFields["ADA"].waitForExistence(timeout: 10), "Cardano send form")
        XCTAssertTrue(app.textFields["cNIGHT"].exists)
        app.buttons["Cancel"].tap()

        // Address book: save our own address as a contact.
        app.tabBars.buttons["Settings"].tap()
        reveal(app.buttons["Address book"], in: app).tap()
        app.buttons["Add contact"].tap()
        app.textFields["Name"].tap()
        app.textFields["Name"].typeText("Me")
        app.textFields["Address"].tap()
        app.textFields["Address"].typeText(ownAddress)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Me"].waitForExistence(timeout: 5), "contact saved")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Auto-lock is configurable.
        XCTAssertTrue(reveal(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Auto-lock'")).firstMatch, in: app).exists)

        // Send: pick the contact, then add a second recipient line.
        app.tabBars.buttons["Wallet"].tap()
        let send = app.buttons["Send"]
        XCTAssertTrue(send.waitForEnabled(timeout: 180), "synced")
        send.tap()
        app.buttons["Choose a contact"].firstMatch.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Me'")).firstMatch.tap()
        let filled = app.textFields.matching(NSPredicate(format: "value == %@", ownAddress)).firstMatch
        XCTAssertTrue(filled.waitForExistence(timeout: 5), "contact filled the recipient")
        app.buttons["Add recipient"].tap()
        XCTAssertTrue(app.staticTexts["RECIPIENT 2"].waitForExistence(timeout: 5) || app.staticTexts["Recipient 2"].exists, "second line")
        app.buttons["Cancel"].tap()
    }
}
