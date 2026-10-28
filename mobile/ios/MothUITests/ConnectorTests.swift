import XCTest

/// Connects moth's mock DApp (served by scripts/ui-test.sh) through the in-app browser.
final class ConnectorTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testConnectAndReadAddresses() {
        let app = XCUIApplication()
        app.launch()
        unlockOrCreate(app)

        // Switch only once the first sync is done, as AccountsTests does by the time it switches.
        // While the sync runs, its progress redraws Settings many times a second, and in CI the
        // network menu then closed on the tap without selecting preprod.
        XCTAssertTrue(app.staticTexts["Synced"].waitForExistence(timeout: 300), "first sync on preview done")

        // The mock DApp requests preprod, and new wallets start on preview.
        app.tabBars.buttons["Settings"].tap()
        reveal(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Network'")).firstMatch, in: app).tap()
        app.buttons["preprod"].tapCentre()
        app.tabBars.buttons["Wallet"].tap()
        // The header is a List section header, which iOS shows in capitals ("MAIN · PREPROD").
        let onPreprod = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] '· preprod'")).firstMatch
        XCTAssertTrue(onPreprod.waitForExistence(timeout: 60), "account moved to preprod")

        app.tabBars.buttons["Browser"].tap()
        let address = app.textFields["DApp address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText("http://127.0.0.1:5174/\n")

        let web = app.webViews["dapp"]
        let connect = web.buttons["Connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 30), "mock DApp loaded and found Moth")
        connect.tap()

        // The approval sheet is native; its Connect button is in its navigation bar.
        let approve = app.navigationBars["Connect"].buttons["Connect"]
        XCTAssertTrue(approve.waitForExistence(timeout: 30), "connect approval")
        let origin = NSPredicate(format: "label CONTAINS 'http://127.0.0.1:5174'")
        XCTAssertTrue(app.staticTexts.matching(origin).firstMatch.exists, "approval names the requesting origin")
        approve.tap()

        let addresses = web.buttons["All addresses"]
        XCTAssertTrue(addresses.waitForEnabled(timeout: 30), "connected")
        addresses.tap()
        let result = web.staticTexts.matching(NSPredicate(format: "label CONTAINS 'mn_addr_preprod1'")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 30), "DApp received the unshielded address")

        app.tabBars.buttons["Settings"].tap()
        // Forms only create rows on screen, so scroll down to Connected sites.
        let site = reveal(app.staticTexts.matching(origin).firstMatch, in: app)
        XCTAssertTrue(site.waitForExistence(timeout: 10), "site listed as connected")
    }
}

/// Gets past onboarding or the lock screen; Face ID prompts are matched by scripts/ui-test.sh.
func unlockOrCreate(_ app: XCUIApplication) {
    let create = app.buttons["Create a new wallet"]
    let unlock = app.buttons["Unlock"]
    let home = app.navigationBars["Moth"]
    let deadline = Date().addingTimeInterval(60)
    while Date() < deadline, !create.exists, !unlock.exists, !home.exists { _ = home.waitForExistence(timeout: 1) }
    if create.exists {
        create.tap()
        XCTAssertTrue(app.staticTexts["Your recovery phrase"].waitForExistence(timeout: 60))
        app.switches.firstMatch.switches.firstMatch.tap()
        app.buttons["Continue"].tap()
    }
    XCTAssertTrue(home.waitForExistence(timeout: 120), "unlocked")
}

/// Scrolls until `element` exists; forms only create rows that are on screen.
@discardableResult
func reveal(_ element: XCUIElement, in app: XCUIApplication, up: Bool = true) -> XCUIElement {
    for _ in 0..<8 where !element.exists { up ? app.swipeUp() : app.swipeDown() }
    return element
}

extension XCUIElement {
    /// Taps a control XCUITest finds but cannot always hit: a menu item while its menu is still
    /// opening has no frame yet ({inf, inf}), and a menu in a Form row can report no hit point.
    /// Waits for a real frame, lets the menu settle, then taps the centre of the frame.
    func tapCentre(timeout: TimeInterval = 10) {
        let placed = NSPredicate { object, _ in
            guard let element = object as? XCUIElement, element.exists else { return false }
            let f = element.frame
            return f.minX.isFinite && f.minY.isFinite && f.width > 0 && f.height > 0
        }
        let found = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: placed, object: self)], timeout: timeout) == .completed
        XCTAssertTrue(found, "\(self) never got a frame to tap")
        Thread.sleep(forTimeInterval: 0.5)
        coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    func waitForEnabled(timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "exists == true AND enabled == true")
        return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: self)], timeout: timeout) == .completed
    }
}
