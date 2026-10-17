source 'https://cdn.cocoapods.org/'

platform :ios, '15.0'
use_frameworks!

target 'Linovia' do
  pod 'IronSourceSDK'
  pod 'IronSourceUnityAdsAdapter'
end

post_install do |installer|
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
      config.build_settings['ENABLE_BITCODE'] = 'NO'
    end
  end
end
