# Visitor Recognizer

Hosted web app that works with Ring cameras through the Ring Appstore and the official Ring Partner API
(Amazon Vision API). Each customer gets an arrival log with snapshots for doorbell presses and motion.
Facial recognition is optional, off by default, behind a separate explicit consent, and only recognizes people the
customer enrolls themselves. All processing runs server-side on Render (United States).

## Ring Developer Portal endpoints

| Console field | URL |
| --- | --- |
| Account Link URL | `https://ring-visitor-recognizer.onrender.com/ring/link` |
| App Homepage URL | `https://ring-visitor-recognizer.onrender.com/ring/config` |
| Token Exchange URL | `https://ring-visitor-recognizer.onrender.com/oauth/token` |
| Webhook URL | `https://ring-visitor-recognizer.onrender.com/ring/webhook` |

Public pages: `/`, `/support.html`, `/privacy.html`, `/terms.html`, `/security.html`. Health check: `/health`.

## How the Ring integration works

1. **Token exchange** (`POST /oauth/token`, form-encoded `code` + `client_id` from Ring): exchanges the code at
   `https://oauth.ring.com/oauth/token`, calls `GET https://api.amazonvision.com/v1/users/me`, stores the token pair and
   Ring Account ID **unclaimed** (encrypted), and only then returns 200. Any failure returns non-2xx. Duplicate
   deliveries of the same code are answered without a second exchange. Unclaimed tokens are deleted after 15 minutes.
2. **Account link** (`GET /ring/link?nonce&time`): rejects `time` older than 600 s or in the future (also on every
   POST that carries nonce/time), shows Create account / Sign in. Only after sign-in does the server match the nonce
   (`HMAC-SHA256(key, "<time>:<accountId>")`, URL-safe base64 without padding, constant-time) against unclaimed tokens,
   claim it for that user, `POST /v1/accounts/me/app-integrations {account_identifier: masked email, nonce}` and
   `PATCH {status: "completed"}`, then shows a confirmation with the shared cameras.
3. **Webhooks** (`POST /ring/webhook`): `X-Signature: sha256=<hex>` verified over the raw body; 200 returned
   immediately; events processed asynchronously and deduplicated on `meta.request_id`. Handles `motion_detected`,
   `button_press`, `device_added/removed/online/offline`, `app_integration_added/removed`,
   `subscription_activated/deactivated`.
4. **Snapshots**: `POST /v1/devices/{id}/media/image/download` (`at_timestamp` = event time; follows the 303),
   retried while the recording is not ready. Devices with `e2e_encryption.enabled` (TAKE/E2EE) or unreadable media are
   logged as “Encrypted video” without a picture. Privacy zones are blacked out before anything is stored or analysed.
5. **Tokens**: refreshed silently before expiry and on 401, and proactively about once a day; every refresh persists
   the new refresh token. Every Ring request sends `User-Agent: VisitorRecognizer/1.0` and a stable `Hardware_Id`
   UUID per Ring account.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `RING_CLIENT_ID`, `RING_CLIENT_SECRET` | yes | Ring app credentials |
| `RING_HMAC_SIGNATURE_KEY` | yes | Nonce + webhook verification |
| `DATA_ENCRYPTION_KEY` | yes | 32-byte key (hex or base64) for AES-256-GCM at rest. `openssl rand -base64 32` |
| `DATABASE_URL` | strongly recommended | Postgres connection string. Without it data is kept in encrypted files under `DATA_DIR`, which Render's free tier wipes on restart |
| `DATABASE_SSL` | no | `true` to require TLS to Postgres (use for external connection strings) |
| `PUBLIC_APP_URL` | no | Defaults to the Render URL |
| `ADMIN_TOKEN` | no | Bearer token for the operator-only `GET /ops/status` (counts only, no personal data) |
| `RETENTION_DAYS` | no | Arrivals/snapshots retention, default 30 |
| `APP_NAME`, `SUPPORT_EMAIL` | no | Display values |
| `RECOGNITION_BLOCKED_STATES` | no | Default `IL,TX,WA`: no facial recognition for cameras Ring locates in these states |

## Develop

```sh
npm ci
npm run build
npm test                       # unit + integration tests against a local mock of Ring's API
TEST_DATABASE_URL=postgres://... npm test   # same suite against Postgres
npm start
```

The image step (`scripts/embed_face.py`) needs Python 3 with `ai-edge-litert pillow numpy opencv-python-headless`
(installed in the Docker image). The bundled model is `model/mobile_facenet.tflite`.

Not affiliated with or endorsed by Ring LLC or Amazon.
