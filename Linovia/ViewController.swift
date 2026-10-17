import UIKit
import WebKit
import AppTrackingTransparency
import AdSupport
import AVFoundation
import StoreKit

class ViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {

    private var webView: WKWebView!

    override var prefersStatusBarHidden: Bool {
        return true
    }

    override var prefersHomeIndicatorAutoHidden: Bool {
        return true
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.063, green: 0.102, blue: 0.086, alpha: 1.0)

        setupAudioSession()
        setupWebView()
        setupAdCallbacks()
        loadGame()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if let banner = UnifiedAdManager.shared.bannerAdView {
            view.bringSubviewToFront(banner)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        requestTrackingAndInitAds()
    }

    // MARK: - Audio Session
    private func setupAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default, options: [.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("AudioSession setup error: \(error.localizedDescription)")
        }
    }

    // MARK: - WebView Setup (100% Fullscreen, Edge-to-Edge)
    private func setupWebView() {
        let contentController = WKUserContentController()

        // Inject JS bridge polyfill before any document script executes
        let bridgeScriptSource = """
        window.AndroidBridge = {
            showInterstitial: function() {
                if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.adBridge) {
                    window.webkit.messageHandlers.adBridge.postMessage({action: 'showInterstitial'});
                }
            },
            showRewarded: function(rewardType) {
                if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.adBridge) {
                    window.webkit.messageHandlers.adBridge.postMessage({action: 'showRewarded', rewardType: rewardType || 'default'});
                }
            },
            showBanner: function() {
                if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.adBridge) {
                    window.webkit.messageHandlers.adBridge.postMessage({action: 'showBanner'});
                }
            },
            hideBanner: function() {
                if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.adBridge) {
                    window.webkit.messageHandlers.adBridge.postMessage({action: 'hideBanner'});
                }
            },
            rateApp: function() {
                if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.adBridge) {
                    window.webkit.messageHandlers.adBridge.postMessage({action: 'rateApp'});
                }
            },
            isInterstitialReady: function() { return true; },
            isRewardedReady: function() { return true; }
        };
        window.addEventListener('error', function(e) {
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.adBridge) {
                window.webkit.messageHandlers.adBridge.postMessage({action: 'logError', message: (e.message || '') + ' at ' + (e.filename || '') + ':' + (e.lineno || '')});
            }
        });
        """

        let userScript = WKUserScript(source: bridgeScriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        contentController.addUserScript(userScript)
        contentController.add(self, name: "adBridge")

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.setValue(true, forKey: "allowUniversalAccessFromFileURLs")
        if #available(iOS 14.0, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = true
        }

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.063, green: 0.102, blue: 0.086, alpha: 1.0)
        webView.scrollView.backgroundColor = UIColor(red: 0.063, green: 0.102, blue: 0.086, alpha: 1.0)
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        let bannerContainer = UIView()
        bannerContainer.translatesAutoresizingMaskIntoConstraints = false
        bannerContainer.backgroundColor = UIColor(red: 0.027, green: 0.055, blue: 0.043, alpha: 1.0)
        view.addSubview(bannerContainer)

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: bannerContainer.topAnchor),

            bannerContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bannerContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bannerContainer.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            bannerContainer.heightAnchor.constraint(equalToConstant: 50)
        ])
    }

    // MARK: - Ad Callbacks
    private func setupAdCallbacks() {
        UnifiedAdManager.shared.onInterstitialClosed = { [weak self] in
            DispatchQueue.main.async {
                self?.webView.evaluateJavaScript("if (window.onAdClosed) { window.onAdClosed('interstitial'); }", completionHandler: nil)
            }
        }

        UnifiedAdManager.shared.onRewardedCompleted = { [weak self] success, rewardType in
            DispatchQueue.main.async {
                let js = "if (window.onUnityAdRewarded) { window.onUnityAdRewarded(\(success), '\(rewardType)'); }"
                self?.webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }

    // MARK: - Game Loading
    private func loadGame() {
        if let wwwURL = Bundle.main.url(forResource: "www", withExtension: nil) {
            let indexURL = wwwURL.appendingPathComponent("index.html")
            webView.loadFileURL(indexURL, allowingReadAccessTo: wwwURL)
        } else if let indexURL = Bundle.main.url(forResource: "index", withExtension: "html") {
            let parentDir = indexURL.deletingLastPathComponent()
            webView.loadFileURL(indexURL, allowingReadAccessTo: parentDir)
        } else {
            print("ERROR: Could not locate game www/index.html in main bundle!")
        }
    }

    // MARK: - ATT Permission & Ads Initialization
    private func requestTrackingAndInitAds() {
        if #available(iOS 14, *) {
            ATTrackingManager.requestTrackingAuthorization { [weak self] status in
                DispatchQueue.main.async {
                    self?.initAds()
                }
            }
        } else {
            initAds()
        }
    }

    private func initAds() {
        UnifiedAdManager.shared.initAds(viewController: self)
    }

    // MARK: - WKScriptMessageHandler
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "adBridge", let body = message.body as? [String: Any], let action = body["action"] as? String else {
            return
        }

        switch action {
        case "showInterstitial":
            UnifiedAdManager.shared.showInterstitial(from: self)
        case "showRewarded":
            let rewardType = body["rewardType"] as? String ?? "default"
            UnifiedAdManager.shared.showRewarded(from: self, rewardType: rewardType)
        case "showBanner":
            UnifiedAdManager.shared.showBanner()
        case "hideBanner":
            UnifiedAdManager.shared.hideBanner()
        case "logError":
            let msg = body["message"] as? String ?? ""
            print("[JS ERROR] \(msg)")
        case "rateApp":
            DispatchQueue.main.async {
                if #available(iOS 14.0, *), let windowScene = self.view.window?.windowScene {
                    SKStoreReviewController.requestReview(in: windowScene)
                } else if let url = URL(string: "https://apps.apple.com/app/com.linovia?action=write-review") {
                    UIApplication.shared.open(url, options: [:], completionHandler: nil)
                }
            }
        default:
            break
        }
    }

    // MARK: - WKNavigationDelegate
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("Linovia web view finished loading.")
    }
}
