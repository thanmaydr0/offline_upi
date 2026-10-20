package expo.modules.offlinelink

import com.journeyapps.barcodescanner.CaptureActivity

/** ZXing's camera/decoder and UI are bundled in our APK. No Play Services API. */
class OfflineCaptureActivity : CaptureActivity()
