# NibrasGPT Android Super App preview

This APK bundles the reviewed PR #6 UI and AI Flow Studio. It uses HTTPS to connect to the existing NibrasGPT API. No changes to production accounts, D1, R2, credentials or billing are required to build it.

## Testing
- Build with JDK 17, Gradle 8.10.2 and Android SDK API 35: `gradle -p android :app:assembleDebug`.
- The APK's local HTTPS origin is isolated from the old web app's browser storage; sign in again to access the same server-side account and data. Existing browser storage is left untouched.
- Native Google login uses the explicit Sign in with Google Credential Manager option, exchanges the Google ID token with the existing backend, and installs the verified session only inside the bundled app origin. The exact non-secret error class is displayed if Google sign-in fails.
- The Android OAuth client needs the exact package `com.datacore.nibrasgpt` and APK signing SHA-1 registered in the Google project corresponding to the configured web client ID. The build workflow prints the certificate fingerprint. Do not expose a private signing key or API secret.
- This is a debug-signed preview. For a final updateable release, use the existing release signing identity if available, or register a new stable signing key after owner approval. Do not uninstall an existing app to work around signature conflicts before confirming its local data is backed up.
- Production still runs Worker v6.0. The bundled UI identifies this version mismatch and gates new search, video and Office export actions until the reviewed API is deployed. The new UI is a preview, not an assertion of live provider access.
- No secret is bundled in the APK. No paid service is enabled by this build.
