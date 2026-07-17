# Repository Guidance

## Application Structure

- The application is a static, browser-only site; no backend, API, analytics, storage, service worker, or deployment workflow is permitted.

## Safety Rules

- Email files and derived data must stay in browser memory: never upload, persist, log, or send them to an API. Do not surface message metadata or detailed parser errors in the UI.
- Parse only one HTML email up to 25 MB. Reject plain-text-only messages. Accept CID attachments only when validated PNG, JPEG, or GIF images meet the per-file (10 MB) and total (50 MB) limits.
- Sanitize HTML before adding it to an application DOM. The iframe must render only sanitized content with `sandbox="allow-same-origin allow-modals"` and no `allow-scripts`, so printing remains possible.
- Block remote images by default. Restore only HTTPS `<img>` sources after an explicit warning for the active file, and use `referrerpolicy="no-referrer"`. Never enable HTTP images, `srcset`, external stylesheets/fonts, or CSS resource URLs.

## Verification

- Browser tests use synthetic fixtures only and run against Vite's production preview server. Do not add real receipts or account data.
