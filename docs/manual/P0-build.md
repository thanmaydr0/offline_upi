# Android APK build — 2026-10-18

Source commit: `390961c85caef595fe4efc57e69b7af2089898a1` (unsigned Git commit, pushed to main).

The local Gradle build was stopped at the user's request to conserve RAM.
An EAS cloud Android build was submitted with the existing `preview` profile
and existing remote Android signing credentials. The APK is signed for installation;
"unsigned" was applied to the Git commit.

Build: https://expo.dev/accounts/thanmaydr0/projects/offline-pay/builds/ab350e38-b400-471d-a8eb-4ef5907e63e3

The user requested no monitoring after submission. Completion is not verified.

## MANUAL STEPS FOR YOU

1. Open the build link above. Once Expo reports success, download and install the APK on your Android phone.
2. In OfflinePay Settings, configure a backend URL reachable from the phone.

## Validation

- Repository typecheck and mobile lint passed.
- Shared: 10 tests passed; contracts: 20 tests passed.
- Backend: 33 tests passed when run independently.
- Mobile API/sync: 26 tests passed; offline flows: 34 tests passed using their existing Jest configs.
- The default mobile test command fails to parse TypeScript because aggregate Jest configuration is missing.
