import UIKit
import Capacitor
import WebKit
import ObjectiveC

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        BivaOfflineRetry.install()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

/// A lost connection must open the saved business, not the first-run page.
enum BivaOfflineRetry {
    private static var installed = false
    private static var retries = 0

    static func install() {
        if installed { return }
        installed = true
        swap(NSSelectorFromString("webView:didFailProvisionalNavigation:withError:"), #selector(WebViewDelegationHandler.biva_didFailProvisional(_:_:_:)))
        swap(NSSelectorFromString("webView:didFailNavigation:withError:"), #selector(WebViewDelegationHandler.biva_didFail(_:_:_:)))
    }

    private static func swap(_ original: Selector, _ replacement: Selector) {
        guard
            let first = class_getInstanceMethod(WebViewDelegationHandler.self, original),
            let second = class_getInstanceMethod(WebViewDelegationHandler.self, replacement)
        else { return }
        method_exchangeImplementations(first, second)
    }

    static func keepSavedApp(_ webView: WKWebView, error: Error) -> Bool {
        let ns = error as NSError
        let offline = ns.domain == NSURLErrorDomain && [
            NSURLErrorNotConnectedToInternet,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorTimedOut,
            NSURLErrorCannotFindHost,
            NSURLErrorCannotConnectToHost,
            NSURLErrorDNSLookupFailed,
            NSURLErrorInternationalRoamingOff,
            NSURLErrorDataNotAllowed,
        ].contains(ns.code)
        guard offline else { return false }
        let failing = (ns.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url
        guard let failing, failing.host == "biva-dev-app.onrender.com" else { return false }
        if retries >= 2 { return false }
        retries += 1
        var request = URLRequest(url: failing)
        request.cachePolicy = .returnCacheDataElseLoad
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
            webView.evaluateJavaScript("document.body ? document.body.innerText.length : 0") { value, _ in
                let length = value as? Int ?? 0
                if length > 40 { return }
                webView.load(request)
            }
        }
        return true
    }
}

extension WebViewDelegationHandler {
    @objc func biva_didFailProvisional(_ webView: WKWebView, _ navigation: WKNavigation!, _ error: Error) {
        if BivaOfflineRetry.keepSavedApp(webView, error: error) { return }
        biva_didFailProvisional(webView, navigation, error)
    }

    @objc func biva_didFail(_ webView: WKWebView, _ navigation: WKNavigation!, _ error: Error) {
        if BivaOfflineRetry.keepSavedApp(webView, error: error) { return }
        biva_didFail(webView, navigation, error)
    }
}
