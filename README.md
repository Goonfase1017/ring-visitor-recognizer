# Ring Visitor Recognizer

## Run

```powershell
npm install
npm start
```

The dashboard is available at `http://localhost:3000/`.

## Face runtime

Face embeddings run locally with Python 3.13 and LiteRT AI Edge:

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

Recognition events and their local snapshot paths are persisted in `data/events.json` and remain available in the dashboard event log after the app restarts.
