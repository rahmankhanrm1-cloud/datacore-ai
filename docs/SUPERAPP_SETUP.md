# NibrasGPT Super App — Functional Setup and Release Checklist

## Built today (2026-11-21)
- Screenshot-inspired mobile chat UI with file picker, modes and Light/Medium/Deep buttons.
- Server-side AI router through Cloudflare Worker.
- Authenticated Office exports: DOCX/XLSX/PPTX/PDF; verified using Python readers.
- Sandboxed live HTML preview.
- Visual AI Flow Studio `/flow.html`, connected node execution and local save.
- NVIDIA Cosmos3 Nano module: text-to-video / image-to-video 5s or 10s, server-side key, R2 MP4, signed video URL, link refresh.
- Android test APK with native Google Credential Manager code.

## Current production remains unchanged
The changes live in the separate `feature/unified-prompt-router-20261120` branch and Draft PR #6.
**Do not merge into main** until remaining prerequisites and real user E2E checks pass. `main` contains an auto-deploy GitHub Actions Cloudflare workflow.

## Required Cloudflare Worker secrets
Cloudflare account / Worker: `datacore-ai-api`.

1. `TAVILY_API_KEY` — enables real Medium / Deep Search; model must cite search results. **Not configured.** Do not assume free unlimited search.
2. `NVIDIA_COSMOS_API_KEY` — enables NVIDIA Cosmos3 Nano Video. **Not configured.** The user revoked a leaked token; do not reuse or paste secrets in chat.
3. `NVIDIA_API_KEY` — existing binding for NVIDIA Nemotron chat. **Present but may be invalid** following token revocation; verify with a permitted real text prompt before marking functional.

Add secrets in Cloudflare dashboard **Worker > Settings > Variables and Secrets > Add Secret**, not GitHub frontend code or app APK.

## Android test build
- Package: `com.datacore.nibrasgpt`, version `1.1-native-google-test`.
- Credential Manager uses the public Web OAuth client ID; the Android app package/signing fingerprint may require one-time registration in Google Cloud OAuth credentials.
- Debug builds use CI-generated signing keys; reinstall, not in-place upgrade, if signature differs. Use a secure stable signing key before production releases.
- The APK loads the **existing live GitHub Pages site**: new UI becomes visible only after reviewed deployment.
- The new native Google sign-in button exchanges the Google ID token with the existing `/api/auth/google` Worker endpoint, then applies the returned session to the trusted WebView origin only.
- If Credential Manager fails on device, report exact error without sending any token.

## Feature verification
| Module | Positive test | Failure test |
| --- | --- | --- |
| Light Chat | Valid prompt yields LLM text | Logged-out request is denied |
| Medium / Deep | Search result has real HTTPS source URLs | Missing Tavily key returns setup error, never invents sources |
| Photo | Generate/edit an actual image | Invalid file blocked |
| Cosmos Video | MP4 valid, signed download, proper 5/10s metadata | Invalid key/quota/paid error surfaced, no provider purchase |
| Office | DOCX Word, XLSX Excel, PPTX PowerPoint, PDF reader opens output | Invalid format / overlong data / unsupported PDF Unicode handled |
| Code | Fenced HTML preview in sandboxed iframe | External script/network blocked |
| Flow | Prompt→Chat→Output executes; Add/drag/connect/save works | Circular connection rejected |
| Android | Native Google sign-in yields a verified session; email login works | Embedded WebView Google prompt not used |

## Known limitations
- **30-second video generation is not yet ready**. This Cosmos3 Nano integration supports 5/10s; longer scenes require verified provider/continuation + FFmpeg or suitable video processing, duration validation and quota approval.
- Office engine is a functional basic exporter. Advanced charts, rich layouts, page templates, PDF Tamil font embedding and formula recalculation are not yet implemented.
- Flow saves prompts locally. Do not store passwords/API keys there.
- Browser search provider has externally enforced quotas and billing/credit limits.
- Owner Unlimited bypasses the app's own limits and subscription checkout, not third-party GPU limits or API licensing.
- Production monitoring, native Google login on device, and full integration tests with real credentials remain necessary.

## Security and change control
Keep API secrets only in Cloudflare Worker secret bindings; do not commit, screenshot or send values in chat. Never disclose tokens in logs, run provider calls during a CI smoke test without explicit authorization, or enable payments without owner approval. Maintain existing D1 and R2 data.
