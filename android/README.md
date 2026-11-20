# NibrasGPT Android test APK

This Android project wraps the existing NibrasGPT web application at https://rahmankhanrm1-cloud.github.io/datacore-ai/ in a WebView with HTTPS-only navigation, file selection, external links, and Android downloads.

## Build
Run `gradle -p android :app:assembleDebug` with Android SDK API 35, JDK 17 and Gradle 8.10.2. The automated workflow uploads an installable **debug test APK**, with a temporary build/debug signing certificate.

## Limitations
- **Internet required:** web content is not bundled. This build does not promise offline operation.
- Google Identity Services can restrict login from embedded Android WebView. Email/password login should be used for this test if Google sign-in is denied; implementing compliant external-browser Google auth requires separate app/server work.
- Browser-specific features (e.g. JavaScript blob-file downloads or native APIs) may require dedicated bridges and additional testing.
- This is a **test APK**, not a Play Store release. Do not use its generated debug signing key for future upgrades. Production releases must have a securely stored, stable release signing key.
- Existing GitHub Pages site, Worker, API credentials and production services are left unchanged.
- The app does not embed or expose NVIDIA/Cloudflare secrets.
