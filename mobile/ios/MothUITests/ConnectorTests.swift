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
        let network = reveal(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Network'")).firstMatch, in: app)
        choose(app.buttons["preprod"], fromMenu: network)
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

/// How long a fresh install may show "Starting Moth…". Usually 12-35 s on CI, but the first launch
/// after the simulator boots has taken over 90 s.
let firstScreenTimeout: TimeInterval = 180

/// Gets past onboarding or the lock screen; Face ID prompts are matched by scripts/ui-test.sh.
func unlockOrCreate(_ app: XCUIApplication) {
    let create = app.buttons["Create a new wallet"]
    let unlock = app.buttons["Unlock"]
    let home = app.navigationBars["Moth"]
    let deadline = Date().addingTimeInterval(firstScreenTimeout)
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

/// Opens `menu` and taps `item` in it. An item can't be hit while its menu is still opening,
/// and in CI a redraw behind the menu has closed it before the tap, so wait until the item has
/// settled in place and reopen the menu if it never does. Then tap the middle of where it sits:
/// on CI, XCTest can fail to find a hit point on an iOS 26 menu item that has been open and still
/// for seconds, and a coordinate tap doesn't ask it for one.
/// On a busy CI runner the menu has opened after the wait, over its own button, and tapping that
/// button again then fails the test; so reopen only when the item is gone and the button is clear.
func choose(_ item: XCUIElement, fromMenu menu: XCUIElement, attempts: Int = 3) {
    for attempt in 0..<attempts {
        if attempt == 0 || (!item.exists && menu.isHittable) { menu.tap() }
        if item.waitForSettledFrame(timeout: 10) {
            let frame = item.frame
            XCUIApplication().coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap()
            // The menu closes once the item is chosen; if it is still open, the tap missed.
            if item.waitForNonExistence(timeout: 3) { return }
        }
    }
    XCTFail("\(item) never settled after opening \(menu) \(attempts) times")
}

/// Taps `button` until `result` appears. On CI a tap on a list row has been lost while the list
/// redrew for sync progress; tap again only if nothing opened and the button is still clear.
func tap(_ button: XCUIElement, until result: XCUIElement, attempts: Int = 3) {
    for attempt in 0..<attempts {
        if attempt == 0 || (!result.exists && button.isHittable) { button.tap() }
        if result.waitForExistence(timeout: 5) { return }
    }
    XCTFail("\(result) never appeared after tapping \(button) \(attempts) times")
}

extension XCUIElement {
    func waitForEnabled(timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "exists == true AND enabled == true")
        return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: self)], timeout: timeout) == .completed
    }

    /// Waits until the element has a real frame that is the same on two real readings in a row,
    /// which a menu item has once its menu has finished opening. An open iOS 26 menu can report
    /// an infinite frame between real ones, so those readings are skipped, not counted as a move.
    /// Not `hittable`: asking that of an item whose menu is still opening fails the test.
    func waitForSettledFrame(timeout: TimeInterval) -> Bool {
        var last: CGRect?
        let settled = NSPredicate { object, _ in
            guard let element = object as? XCUIElement, element.exists else { last = nil; return false }
            let frame = element.frame
            guard frame.minX.isFinite, frame.minY.isFinite, !frame.isEmpty else { return false }
            defer { last = frame }
            return frame == last
        }
        return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: settled, object: self)], timeout: timeout) == .completed
    }
}
