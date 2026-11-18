# NibrasGPT workspace setup

Install the Worker dependencies with `npm ci` before deploying with the existing GitHub Actions workflow. Cloudflare D1 creates the new project and digest tables at startup.

- Set `NVIDIA_API_KEY` as a Cloudflare Worker secret to enable NVIDIA Nemotron 3.5 Lightning as an optional text model. Users who select Nemotron send their prompt and applicable document or web context to NVIDIA NIM. The default text model stays on Workers AI. [NVIDIA NIM API reference](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/apireference)
- Set `BRAVE_SEARCH_API_KEY` as a Cloudflare Worker secret to enable live web search.
- Set `NOTION_API_TOKEN` as a Cloudflare Worker secret and share the approved roadmap data source with the Notion integration. The owner's weekly digest runs Mondays at 07:00 UTC. The owner can also run it from the app. To flag overdue items, add a Notion date property named **Due Date** or **Due**. The digest scans up to 100 roadmap records per run.
- Seedance video uses Cloudflare AI Gateway. Enable Unified Billing for the gateway and set `AI_GATEWAY_ID` to the gateway ID if the account uses a named gateway.
- Voice transcription and FLUX image generation use the existing Workers AI binding. Listen uses speech synthesis voices installed on the user's device.

Project PDFs keep extracted text by page so they can answer follow-up questions after reopening the project. Each project supports five PDFs, each up to 8 MB and 20 pages. Standalone PDFs stay available for follow-up questions while the current chat is open.
