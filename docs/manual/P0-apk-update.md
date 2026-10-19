# Android preview update compatibility

## MANUAL STEPS FOR YOU

1. Download the APK from the newly submitted Expo build after Expo reports it complete. Wait until the full download finishes before opening it.
2. Install it as an update over the existing preview app. Keep the existing app and its wallet data; do not uninstall or clear storage.
3. If Android still rejects it, connect the phone by USB with USB debugging allowed and run `adb install -r <full-path-to-downloaded-apk>`. Save the exact `INSTALL_FAILED_*` message so the device-specific rejection can be diagnosed without deleting wallet data.

## Changes and evidence

- App version is now 1.0.1. EAS remote version codes automatically increment for development, preview, and production; signing credentials explicitly use the existing remote configuration.
- The previous preview APK (efd9f945) and reported recent APK (3f4dcb16) both pass Android apksigner verification and zipalign checks with 16 KB native-library alignment.
- Both artifacts have package com.offlinepay.app, minimum SDK 24, target SDK 36, version code 1, and signing certificate SHA-256 951fd32d407192b88063f4ecfed6e743bad9df57828d09a40cffd2ea444d3427.
- Repeated version codes are corrected, but the phone's exact installation failure has not been reproduced. Equal version codes alone do not prove the cause of an Android installation rejection. A fresh higher-version build is submitted with cleared cloud cache and the existing signing key.
- Mobile typecheck, lint, and all 34 offline-flow tests pass. The replacement APK and physical installation are unverified at submission time. No build monitoring is requested.
