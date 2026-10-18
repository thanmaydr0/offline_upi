const { withAndroidManifest } = require('expo/config-plugins');

// Preview APKs support the LAN HTTP URL entered in Settings. Production requires HTTPS.
module.exports = function withPreviewNetwork(config) {
  return withAndroidManifest(config, mod => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android application manifest is missing.');
    application.$['android:usesCleartextTraffic'] =
      ['preview', 'development'].includes(process.env.EAS_BUILD_PROFILE) ? 'true' : 'false';
    return mod;
  });
};
