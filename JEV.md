# Jev upgrade — Semantic vault search and group suggestions

Open the signed-in owner vault. Choose notes to search, select eligible text/link clips, and choose Semantic search or Suggest existing groups. Selection is explicit; nothing is preselected. A maximum of 50 candidates is listed. Long notes send only their first 2,000 characters, shown in the preview. Attachments, encoded images, temporary clips and file bytes are excluded. Show clip opens an existing note; group suggestions require the normal Move controls and never modify Firebase on their own.

## Use

1. Open the new feature panel in its intended app view.
2. Enter a request and use **Preview input** to inspect exactly what will be sent.
3. Select the per-request consent checkbox, then run the check.
4. Review the result. Where available, a separate Open/Fill/Show button performs the bounded action.

The feature works only after a deployed endpoint and server-side TypeSafe API key are configured. Source integration and mocked tests do **not** establish live model accuracy. Without configuration, all existing app workflows remain available.

## Connect

### Browser-first Cloudflare setup

1. Create a **separate Worker** in Cloudflare Dashboard and connect this GitHub repository. Keep the existing GitHub Pages site.
2. Use the repository root as the project directory. Set the deploy command to `npx wrangler@4.145.0 deploy --config jev/wrangler.jsonc`. No frontend build is needed.
3. In that Worker's Settings → Variables and Secrets, add `TYPESAFE_API_KEY` as a **secret**. The supplied config uses `ALLOWED_ORIGINS=https://0xtrvkc.github.io` and `JEV_MODEL=jev-latest`. Edit the allowed origin for your own fork or domain.
4. The supplied configuration defines `JEV_LIMITER` (10 requests per minute per Cloudflare location). Its `namespace_id` must be unique within your Cloudflare account. This bounds feature usage but is not a global spending cap; use TypeSafe account limits appropriate to your budget.
5. Also add `JEV_ACCESS_TOKEN` as a server secret containing a random value of at least 32 characters. Enter this **separate feature access token** in the app connection panel for each session. It is kept only in memory and restricts access to this private endpoint. It is not a TypeSafe API key or a Firebase credential.
6. Deploy the Worker. In the app's **Jev connection**, enter `https://YOUR-WORKER.workers.dev/api/jev`. The browser remembers this URL only. Alternatively set the public endpoint in `jev/config.js`; never put credentials there.

Optional terminal route: `npx wrangler@4.145.0 deploy --config jev/wrangler.jsonc` after configuring the same bindings and secrets. Keep service keys out of Git commits.

## What is checked

- Server-owned typed questions; clients cannot supply arbitrary prompts, model names or questions.
- Explicit origins, private feature token or existing WatchDog session, bounded streamed input (60 KB), fixed provider URL and rate-limit binding.
- Complete response shape, allowed options, finite confidence, valid distributions and score consistency.
- Choice confidence below 0.8 produces review; this is a conservative starting policy, **not a calibrated accuracy guarantee**. Relevance rankings can still show clearly labeled possible matches.
- Source text and selected excerpts are displayed as text, not executable HTML.
- Preview and inference do not mutate trading calculations, financial settings or external records.
- Session-only response cache for ten unchanged requests; sensitive text is not written to localStorage. Context changes clear results/cache. Requests are cancellable; expired responses cannot repopulate a cleared result.
- Timeouts, overload, malformed responses and configuration errors restore the Run control and leave existing workflows usable.

## Tests and live evaluation

```sh
node --test tests/jev.test.mjs
# With Playwright and Chromium installed:
node tests/jev-browser.cjs
# Only after explicitly configuring TYPESAFE_API_KEY in your local environment:
node jev/live-check.mjs
```

`tests/jev.test.mjs` uses synthetic provider responses to verify the boundary and domain behavior. `tests/jev-browser.cjs` loads the actual application in Chromium at desktop and mobile widths, blocks unrelated external network requests, supplies synthetic statements/vault data where needed, and mocks Jev responses. It checks consent, preview, actions, session caching, failures, cancellation and layout. It does not log into your real Firebase account, send real email or prove TypeSafe semantic quality.

The GitHub Actions **Jev integration checks** workflow runs the boundary suite and real Chromium checks on PRs and `main`. Existing repository checks remain enabled.

`jev/live-check.mjs` evaluates a small synthetic example against the actual provider and validates its response shape. It never uses your private clipboard, statement or portfolio. Before relying on classifications, build labeled representative examples in your languages and domain, measure errors, and tune questions/thresholds. Pin a tested `JEV_MODEL` version when reproducibility matters.

Reference: [TypeSafe API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice), [Confidence](https://docs.typesafe.ai/confidence).
