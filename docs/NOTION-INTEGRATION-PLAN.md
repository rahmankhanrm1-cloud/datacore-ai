# DataCore AI / NibrasGPT — Notion Integration Plan
Status: PLANNING ONLY. No Notion connection or deployment has occurred.
Date: 2026-10-18

## Current application
GitHub Pages static PWA using index.html and sw.js; Cloudflare Worker worker.js with D1, R2 and AI features. Preserve existing features, branding, owner access, payments, plans, and data.

## Goal
Enable authorized NibrasGPT users to read approved Notion notes and project plans. Start with OWNER-ONLY, READ-ONLY access.

## Architecture
Notion workspace -> Notion REST API -> authenticated Cloudflare Worker -> NibrasGPT frontend.

Never expose a Notion API token in GitHub Pages frontend, source code, GitHub secrets output, logs, or Wrangler vars. Store NOTION_API_TOKEN as a Cloudflare Worker secret. Do not change main branch until tests pass.

## Milestones
1. User creates or selects a Notion workspace with a sandbox root page named DataCore Workspace.
2. User creates a Notion integration and grants only the sandbox root page and desired child databases. Store its installation access token in Cloudflare Worker secrets.
3. Implement authenticated owner-only API endpoints for connection status and scoped search. Use existing app authorization, with backend checks. No generic unrestricted read access.
4. Render a source link/title with retrieved knowledge in NibrasGPT AI answers. Fail safely on missing access, token errors or offline connections.
5. After verified tests, add explicit-confirmation create/update actions and approved project or issue databases.
6. Coordinate optional ERP-summary flows after ERP security validation.

## Initial databases
- AI Knowledge Base: Title, Category, Product, Source URL, Last Reviewed, Visibility.
- Development Roadmap: Feature, Product, Priority, Status, Owner, Notes.
- Product Issues: Issue ID, Product, Severity, Status, Resolution.

## Security and implementation
- Use latest verified Notion API version 2026-03-11 with Notion-Version header.
- Query data sources using data source IDs rather than database IDs.
- Scope API capabilities and Notion shared pages; enforce auth on EVERY endpoint.
- Existing broad CORS logic is not authorization. Restrict origins as appropriate and separately enforce identity and roles.
- Apply rate limiting, pagination, 429 Retry-After/backoff, audit logs, and error handling.
- ChatGPT Notion plugin is separate from NibrasGPT's custom Notion API integration.
- Notion MCP could be added later only after implementing a secure MCP client and permissions; REST API is phase 1.
- Do not transmit secrets, private records, customer data or raw files to Notion by default.

## Verification checklist
- Correctly authorized owner can retrieve an allowlisted test page.
- Logged-out or unauthorized users cannot read Notion.
- Unshared pages cannot be accessed.
- Broken, revoked or expired credentials and 429 do not break general AI functionality.
- No credentials appear in code or API responses.
- No deploy or main merge without review, tests and owner approval.
