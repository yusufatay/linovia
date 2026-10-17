import UIKit
import IronSource

final class UnifiedAdManager: NSObject {
    static let shared = UnifiedAdManager()

    var onInterstitialClosed: (() -> Void)?
    var onRewardedCompleted: ((Bool, String) -> Void)?

    private var interstitialAd: LPMInterstitialAd?
    private var rewardedAd: LPMRewardedAd?
    public var bannerAdView: LPMBannerAdView?

    private var isInitialized = false
    private var pendingRewardType = "default"
    private var rewardEarned = false

    private weak var pendingRewardedViewController: UIViewController?
    private var isWaitingForRewardedLoad = false
    private var rewardedLoadTimeoutWorkItem: DispatchWorkItem?

    private weak var presentingViewController: UIViewController?

    private var isBannerLoading = false
    private var isBannerLoaded = false
    private var isBannerRequested = false
    private var bannerRetryWorkItem: DispatchWorkItem?

    private var interstitialDelegate: InterstitialDelegateHandler?
    private var rewardedDelegate: RewardedDelegateHandler?
    private var bannerDelegate: BannerDelegateHandler?

    private override init() {
        super.init()
    }

    func initAds(viewController: UIViewController) {
        self.presentingViewController = viewController
        self.isBannerRequested = true

        initialize { [weak self] in
            guard let self = self else { return }
            self.loadBanner()
        }
    }

    func initialize(completion: (() -> Void)? = nil) {
        guard !isInitialized else {
            completion?()
            return
        }

        let initRequest = LPMInitRequestBuilder(appKey: AdConfig.appKey).build()
        LevelPlay.initWith(initRequest) { [weak self] config, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let error = error {
                    print("[ADS] LevelPlay init error: \(error.localizedDescription)")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                        self.initialize(completion: completion)
                    }
                } else {
                    print("[ADS] LevelPlay successfully initialized!")
                    self.isInitialized = true
                    self.setupAds()
                    if self.isBannerRequested {
                        self.loadBanner()
                    }
                    completion?()
                }
            }
        }
    }

    private func setupAds() {
        loadInterstitial()
        loadRewarded()
    }

    // MARK: - Interstitial Ad
    func loadInterstitial() {
        guard isInitialized else { return }
        if interstitialAd == nil {
            let handler = InterstitialDelegateHandler(manager: self)
            interstitialDelegate = handler
            let ad = LPMInterstitialAd(adUnitId: AdConfig.interstitialId)
            ad.setDelegate(handler)
            interstitialAd = ad
        }
        interstitialAd?.loadAd()
    }

    func isInterstitialReady() -> Bool {
        return interstitialAd?.isAdReady() ?? false
    }

    func showInterstitial(from viewController: UIViewController) {
        guard let ad = interstitialAd, ad.isAdReady() else {
            print("[ADS] Interstitial not ready, requesting load...")
            loadInterstitial()
            onInterstitialClosed?()
            return
        }
        ad.showAd(viewController: viewController, placementName: nil)
    }

    // MARK: - Rewarded Ad
    func loadRewarded() {
        guard isInitialized else { return }
        if rewardedAd == nil {
            let handler = RewardedDelegateHandler(manager: self)
            rewardedDelegate = handler
            let ad = LPMRewardedAd(adUnitId: AdConfig.rewardedId)
            ad.setDelegate(handler)
            rewardedAd = ad
        }
        rewardedAd?.loadAd()
    }

    func isRewardedReady() -> Bool {
        return rewardedAd?.isAdReady() ?? false
    }

    func showRewarded(from viewController: UIViewController, rewardType: String) {
        self.pendingRewardType = rewardType
        self.rewardEarned = false

        // If ad is ready right now, show immediately
        if let ad = rewardedAd, ad.isAdReady() {
            print("[ADS] Rewarded ad is ready, showing immediately.")
            self.isWaitingForRewardedLoad = false
            self.pendingRewardedViewController = nil
            self.rewardedLoadTimeoutWorkItem?.cancel()
            ad.showAd(viewController: viewController, placementName: nil)
            return
        }

        // If ad is still loading, queue the request and wait up to 5 seconds
        print("[ADS] Rewarded ad not ready yet, queuing request and waiting for load...")
        self.pendingRewardedViewController = viewController
        self.isWaitingForRewardedLoad = true
        loadRewarded()

        rewardedLoadTimeoutWorkItem?.cancel()
        let timeoutWork = DispatchWorkItem { [weak self] in
            guard let self = self, self.isWaitingForRewardedLoad else { return }
            print("[ADS] Rewarded ad wait timed out after 5 seconds.")
            self.isWaitingForRewardedLoad = false
            self.pendingRewardedViewController = nil
            self.onRewardedCompleted?(false, self.pendingRewardType)
        }
        self.rewardedLoadTimeoutWorkItem = timeoutWork
        DispatchQueue.main.asyncAfter(deadline: .now() + 5.0, execute: timeoutWork)
    }

    // MARK: - Banner Ad (Direct View Mounting without Wrapper Containers)
    func loadBanner() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let vc = self.presentingViewController else {
                print("[ADS] Banner deferred: presentingViewController is nil")
                self.isBannerRequested = true
                return
            }
            guard self.isInitialized else {
                print("[ADS] Banner deferred: LevelPlay not yet initialized")
                self.isBannerRequested = true
                return
            }

            if self.isBannerLoading {
                print("[ADS] Banner already loading, skipping duplicate request.")
                return
            }

            if self.isBannerLoaded, let banner = self.bannerAdView {
                banner.isHidden = false
                vc.view.bringSubviewToFront(banner)
                return
            }

            self.isBannerLoading = true
            self.cancelBannerRetry()

            if self.bannerAdView == nil {
                let bannerSize = LPMAdSize.banner()
                let config = LPMBannerAdViewConfigBuilder()
                    .set(adSize: bannerSize)
                    .build()

                let handler = BannerDelegateHandler(manager: self)
                self.bannerDelegate = handler
                let bannerView = LPMBannerAdView(adUnitId: AdConfig.bannerId, config: config)
                bannerView.setDelegate(handler)
                bannerView.backgroundColor = .clear
                self.bannerAdView = bannerView

                bannerView.translatesAutoresizingMaskIntoConstraints = false
                vc.view.addSubview(bannerView)
                vc.view.bringSubviewToFront(bannerView)

                NSLayoutConstraint.activate([
                    bannerView.centerXAnchor.constraint(equalTo: vc.view.centerXAnchor),
                    bannerView.bottomAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.bottomAnchor),
                    bannerView.widthAnchor.constraint(equalToConstant: 320),
                    bannerView.heightAnchor.constraint(equalToConstant: 50)
                ])
            } else if let banner = self.bannerAdView {
                banner.isHidden = false
                vc.view.bringSubviewToFront(banner)
            }

            print("[ADS] Requesting LevelPlay Banner load for adUnitId: \(AdConfig.bannerId)...")
            self.bannerAdView?.loadAd(with: vc)
        }
    }

    func showBanner() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let banner = self.bannerAdView, let vc = self.presentingViewController {
                banner.isHidden = false
                vc.view.bringSubviewToFront(banner)
                if !self.isBannerLoaded && !self.isBannerLoading {
                    self.loadBanner()
                }
            } else {
                self.loadBanner()
            }
        }
    }

    func hideBanner() {
        DispatchQueue.main.async { [weak self] in
            self?.bannerAdView?.isHidden = true
        }
    }

    // MARK: - Internal Handlers called by Delegates
    fileprivate func handleInterstitialClosed() {
        onInterstitialClosed?()
        loadInterstitial()
    }

    fileprivate func handleRewardedLoaded() {
        if isWaitingForRewardedLoad, let vc = pendingRewardedViewController, let ad = rewardedAd, ad.isAdReady() {
            print("[ADS] Queued rewarded ad finished loading! Showing automatically now...")
            isWaitingForRewardedLoad = false
            pendingRewardedViewController = nil
            rewardedLoadTimeoutWorkItem?.cancel()
            ad.showAd(viewController: vc, placementName: nil)
        }
    }

    fileprivate func handleRewardedFailed() {
        if isWaitingForRewardedLoad {
            print("[ADS] Rewarded ad failed while user was waiting.")
            isWaitingForRewardedLoad = false
            pendingRewardedViewController = nil
            rewardedLoadTimeoutWorkItem?.cancel()
            onRewardedCompleted?(false, pendingRewardType)
        }
    }

    fileprivate func handleRewardedClosed() {
        isWaitingForRewardedLoad = false
        pendingRewardedViewController = nil
        rewardedLoadTimeoutWorkItem?.cancel()
        onRewardedCompleted?(rewardEarned, pendingRewardType)
        loadRewarded()
    }

    fileprivate func handleRewardEarned() {
        rewardEarned = true
    }

    fileprivate func handleBannerLoaded() {
        isBannerLoading = false
        isBannerLoaded = true
        cancelBannerRetry()
        print("[ADS] Banner loaded successfully!")
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let banner = self.bannerAdView, let vc = self.presentingViewController else { return }
            banner.isHidden = false
            vc.view.bringSubviewToFront(banner)
        }
    }

    fileprivate func handleBannerFailed() {
        isBannerLoading = false
        print("[ADS] Banner failed to load. Scheduling retry in 15 seconds...")
        if !isBannerLoaded {
            scheduleBannerRetry(delay: 15.0)
        }
    }

    private func scheduleBannerRetry(delay: TimeInterval) {
        cancelBannerRetry()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, !self.isBannerLoaded, self.isInitialized else { return }
            self.loadBanner()
        }
        bannerRetryWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func cancelBannerRetry() {
        bannerRetryWorkItem?.cancel()
        bannerRetryWorkItem = nil
    }
}

// MARK: - Dedicated Interstitial Delegate Handler
private class InterstitialDelegateHandler: NSObject, LPMInterstitialAdDelegate {
    private weak var manager: UnifiedAdManager?

    init(manager: UnifiedAdManager) {
        self.manager = manager
        super.init()
    }

    func didLoadAd(with adInfo: LPMAdInfo) {
        print("[ADS] Interstitial loaded successfully")
    }

    func didFailToLoadAd(withAdUnitId adUnitId: String, error: Error) {
        print("[ADS] Interstitial load failed: \(error.localizedDescription)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.manager?.loadInterstitial()
        }
    }

    func didDisplayAd(with adInfo: LPMAdInfo) {
        print("[ADS] Interstitial displayed")
    }

    func didFailToDisplayAd(with adInfo: LPMAdInfo, error: Error) {
        print("[ADS] Interstitial display failed: \(error.localizedDescription)")
        manager?.handleInterstitialClosed()
    }

    func didClickAd(with adInfo: LPMAdInfo) {}

    func didCloseAd(with adInfo: LPMAdInfo) {
        print("[ADS] Interstitial closed")
        manager?.handleInterstitialClosed()
    }

    func didChangeAdInfo(with adInfo: LPMAdInfo) {}
}

// MARK: - Dedicated Rewarded Delegate Handler
private class RewardedDelegateHandler: NSObject, LPMRewardedAdDelegate {
    private weak var manager: UnifiedAdManager?

    init(manager: UnifiedAdManager) {
        self.manager = manager
        super.init()
    }

    func didLoadAd(with adInfo: LPMAdInfo) {
        print("[ADS] Rewarded loaded successfully")
        manager?.handleRewardedLoaded()
    }

    func didFailToLoadAd(withAdUnitId adUnitId: String, error: Error) {
        print("[ADS] Rewarded load failed: \(error.localizedDescription)")
        manager?.handleRewardedFailed()
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.manager?.loadRewarded()
        }
    }

    func didDisplayAd(with adInfo: LPMAdInfo) {
        print("[ADS] Rewarded displayed")
    }

    func didFailToDisplayAd(with adInfo: LPMAdInfo, error: Error) {
        print("[ADS] Rewarded display failed: \(error.localizedDescription)")
        manager?.handleRewardedClosed()
    }

    func didClickAd(with adInfo: LPMAdInfo) {}

    func didCloseAd(with adInfo: LPMAdInfo) {
        print("[ADS] Rewarded closed")
        manager?.handleRewardedClosed()
    }

    func didRewardAd(with adInfo: LPMAdInfo, reward: LPMReward) {
        print("[ADS] User rewarded: \(reward)")
        manager?.handleRewardEarned()
    }

    func didChangeAdInfo(with adInfo: LPMAdInfo) {}
}

// MARK: - Dedicated Banner Delegate Handler
private class BannerDelegateHandler: NSObject, LPMBannerAdViewDelegate {
    private weak var manager: UnifiedAdManager?

    init(manager: UnifiedAdManager) {
        self.manager = manager
        super.init()
    }

    func didLoadAd(with adInfo: LPMAdInfo) {
        print("[ADS] Banner loaded successfully: \(adInfo)")
        manager?.handleBannerLoaded()
    }

    func didFailToLoadAd(withAdUnitId adUnitId: String, error: Error) {
        print("[ADS] Banner load failed: \(error.localizedDescription)")
        manager?.handleBannerFailed()
    }

    func didClickAd(with adInfo: LPMAdInfo) {
        print("[ADS] Banner clicked")
    }

    func didDisplayAd(with adInfo: LPMAdInfo) {
        print("[ADS] Banner displayed")
    }

    func didFailToDisplayAd(with adInfo: LPMAdInfo, error: Error) {
        print("[ADS] Banner display failed: \(error.localizedDescription)")
    }

    func didExpandAd(with adInfo: LPMAdInfo) {}
    func didCollapseAd(with adInfo: LPMAdInfo) {}
    func didLeaveApp(with adInfo: LPMAdInfo) {}
    func didChangeAdInfo(with adInfo: LPMAdInfo) {}
}
