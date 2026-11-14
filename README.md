# Visitor Recognizer

## Run

```powershell
npm install
npm start
```

The dashboard is available at `http://localhost:3000/`.

## Face runtime

Face embeddings are generated server-side (on the app's Render service) with Python and LiteRT AI Edge:

```powershell
py -3.13 -m pip install ai-edge-litert pillow numpy
```

The app uses `model/mobile_facenet.tflite` through `scripts/embed_face.py`.

## Ring refresh token

`ring-client-api` includes an authentication CLI. Run it from this project directory:

```powershell
npx ring-auth-cli
```

The command asks for your Ring email address, password, and verification code if Ring sends an MFA challenge. Copy the printed refresh token into `.env`:

```dotenv
RING_REFRESH_TOKEN=your_refresh_token
```

Restart the app after changing `.env`. Keep the refresh token private.

## AWS notifications

Set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, and `AWS_SNS_TOPIC_ARN` in `.env` to enable SNS topic notifications.

To receive visitor alerts by text message, also set:

```dotenv
VISITOR_SMS_PHONE=+14245566170
```

The phone number must use E.164 format, including the leading `+` and country code. Ring motion notifications and app visitor notifications are separate; disabling or configuring Ring notifications does not disable Ring visitor-recognition alerts.

Recognition events are persisted encrypted in `data/events.json.enc`; snapshots are encrypted in `data/media/`. Events older than `RETENTION_DAYS` (default 30) are deleted by an hourly job.


## Security and privacy configuration

Required environment variables in production:

- `ADMIN_TOKEN`: owner bearer token for every data API (dashboard prompts for it).
- `DATA_ENCRYPTION_KEY`: 32-byte key (base64 or hex) for AES-256-GCM encryption at rest. Generate with `openssl rand -base64 32`. Without it the app refuses to store personal data.
- `RETENTION_DAYS` (default 30), `AUDIT_RETENTION_DAYS` (default 365).

Owner endpoints: `GET /privacy/export`, `DELETE /privacy/all`, `GET /audit`, `PATCH /visitors/:id/optout` (deletes the face template), `DELETE /visitors/:id`, `DELETE /events/:id`.
Registration requires `consent: { confirmed: true, method }`; the consent time, method and statement are stored with the visitor.

See `public/security.html` for vulnerability management and incident response.
