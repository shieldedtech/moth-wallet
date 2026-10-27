import XCTest

/// Rejecting a DApp, and disconnecting one, must reach the page as an error and grant nothing.
final class ConnectorRejectTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testRejectConnectSigningAndDisconnect() {
        let app = XCUIApplication()
        app.launch()
        unlockOrCreate(app)

        // The mock DApp requests preprod, and new wallets start on preview.
        app.tabBars.buttons["Settings"].tap()
        reveal(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Network'")).firstMatch, in: app).tap()
        app.buttons["preprod"].tap()
        app.tabBars.buttons["Wallet"].tap()
        let onPreprod = app.staticTexts.matching(NSPredicate(format: "label CONTAINS '· preprod'")).firstMatch
        XCTAssertTrue(onPreprod.waitForExistence(timeout: 60), "account moved to preprod")

        app.tabBars.buttons["Browser"].tap()
        let address = app.textFields["DApp address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText("http://127.0.0.1:5174/\n")
        let web = app.webViews["dapp"]
        let connect = web.buttons["Connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 30), "mock DApp loaded and found Moth")

        // Reject the connection: the page gets the rejection and no site is granted.
        connect.tap()
        let sheet = app.navigationBars["Connect"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 30), "connect approval")
        sheet.buttons["Reject"].tap()
        XCTAssertTrue(pageSays(web, "User rejected the connection request").waitForExistence(timeout: 30), "DApp told of the rejection")
        XCTAssertFalse(web.buttons["All addresses"].isEnabled, "still disconnected")
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(reveal(app.staticTexts["No DApps are connected."], in: app).waitForExistence(timeout: 10), "nothing granted")

        // Connect, then reject a signing request.
        app.tabBars.buttons["Browser"].tap()
        connect.tap()
        XCTAssertTrue(sheet.waitForExistence(timeout: 30))
        sheet.buttons["Connect"].tap()
        let addresses = web.buttons["All addresses"]
        XCTAssertTrue(addresses.waitForEnabled(timeout: 30), "connected")

        // The signing form is in a collapsed section.
        let section = web.buttons.matching(NSPredicate(format: "label BEGINSWITH '04 · SIGNING'")).firstMatch
        for _ in 0..<10 where !(section.exists && section.isHittable) { web.swipeUp() }
        section.tap()
        let sign = web.buttons.matching(NSPredicate(format: "label CONTAINS 'Request signature'")).firstMatch
        for _ in 0..<10 where !(sign.exists && sign.isHittable) { web.swipeUp() }
        sign.tap()
        let reject = app.buttons["Reject"]
        XCTAssertTrue(reject.waitForExistence(timeout: 30), "signing approval")
        reject.tap()
        XCTAssertTrue(pageSays(web, "User rejected the signing request").waitForExistence(timeout: 30), "DApp told of the rejection")

        // Disconnect from Settings: the page's next call is refused.
        app.tabBars.buttons["Settings"].tap()
        let site = reveal(app.staticTexts["http://127.0.0.1:5174"], in: app)
        XCTAssertTrue(site.waitForExistence(timeout: 10), "site listed as connected")
        site.swipeLeft()
        app.buttons["Disconnect"].tap()
        XCTAssertTrue(app.staticTexts["No DApps are connected."].waitForExistence(timeout: 10), "site removed")

        app.tabBars.buttons["Browser"].tap()
        for _ in 0..<10 where !addresses.isHittable { web.swipeDown() }
        addresses.tap()
        XCTAssertTrue(pageSays(web, "is not authorized").waitForExistence(timeout: 30), "call refused after disconnect")
    }

    private func pageSays(_ web: XCUIElement, _ text: String) -> XCUIElement {
        web.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }
}
