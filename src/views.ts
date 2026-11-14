import { APP_NAME, CONFIG } from "./config";
import { Device } from "./repo";
import { escapeHtml as e } from "./secure";

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${e(title)} | ${e(APP_NAME)}</title><link rel="icon" href="/logo.svg" type="image/svg+xml"><link rel="stylesheet" href="/app.css">
</head><body><main class="narrow">
<header class="brand"><img src="/logo.svg" alt="" width="44" height="44"><div><strong>${e(APP_NAME)}</strong><span>Works with Ring cameras</span></div></header>
${body}
<footer class="foot"><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/support.html">Support</a></footer>
</main></body></html>`;
}

const hidden = (fields: Record<string, string>) =>
  Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join("");

function signupForm(action: string, fields: Record<string, string>, email = "") {
  return `<form method="post" action="${e(action)}" class="card" novalidate>
  ${hidden(fields)}
  <h2>Create your ${e(APP_NAME)} account</h2>
  <p class="muted">Create a new account to get started. This is separate from your Ring account.</p>
  <label for="su-email">Email</label>
  <input id="su-email" name="email" type="email" autocomplete="email" required maxlength="254" value="${e(email)}">
  <label for="su-password">Password <span class="muted">(at least 10 characters)</span></label>
  <input id="su-password" name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="200">
  <label class="check"><input type="checkbox" name="agree" value="yes" required> <span>I agree to the <a href="/terms.html" target="_blank" rel="noopener">Terms</a> and have read the <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
  <p class="muted small">Facial recognition is off for new accounts. You can choose to turn it on later in the app.</p>
  <button type="submit" class="primary">Create account</button>
</form>`;
}

function signinForm(action: string, fields: Record<string, string>, email = "") {
  return `<form method="post" action="${e(action)}" class="card secondary" novalidate>
  ${hidden(fields)}
  <h2>Already have an account? Sign in</h2>
  <label for="si-email">Email</label>
  <input id="si-email" name="email" type="email" autocomplete="username" required maxlength="254" value="${e(email)}">
  <label for="si-password">Password</label>
  <input id="si-password" name="password" type="password" autocomplete="current-password" required maxlength="200">
  <button type="submit">Sign in</button>
  <p class="muted small">Forgot your password? Email <a href="mailto:${e(CONFIG.SUPPORT_EMAIL)}">${e(CONFIG.SUPPORT_EMAIL)}</a> and we'll help you reset it.</p>
</form>`;
}

const errorBox = (msg?: string) => (msg ? `<div class="alert" role="alert">${e(msg)}</div>` : "");

/** Account Link URL page: sign in or create an account; nonce/time ride along in hidden fields only. */
export function linkPage(opts: { nonce: string; time: string; csrf: string; error?: string; email?: string; signedInEmail?: string }) {
  const fields = { nonce: opts.nonce, time: opts.time, _csrf: opts.csrf };
  const intro = `<h1>Connect your Ring account</h1>
<p>You're almost done. Sign in to ${e(APP_NAME)}, or create an account, to finish connecting the Ring cameras you selected.</p>`;
  if (opts.signedInEmail) {
    return layout("Connect your Ring account", `${intro}${errorBox(opts.error)}
<form method="post" action="/ring/link/confirm" class="card">${hidden(fields)}
<h2>Signed in as ${e(opts.signedInEmail)}</h2>
<p>Connect your Ring account to this ${e(APP_NAME)} account?</p>
<button type="submit" class="primary">Connect to this account</button></form>
<form method="post" action="/signout" class="inline">${hidden({ _csrf: opts.csrf, next: `/ring/link?nonce=${opts.nonce}&time=${opts.time}` })}
<button type="submit" class="link">Use a different account</button></form>`);
  }
  return layout(
    "Connect your Ring account",
    `${intro}${errorBox(opts.error)}${signupForm("/ring/link/signup", fields, opts.email)}${signinForm("/ring/link/signin", fields, opts.email)}`
  );
}

export function authPage(mode: "signin" | "signup", opts: { csrf: string; error?: string; email?: string; next?: string }) {
  const fields: Record<string, string> = { _csrf: opts.csrf };
  if (opts.next) fields.next = opts.next;
  const body =
    mode === "signup"
      ? `${errorBox(opts.error)}${signupForm("/signup", fields, opts.email)}<p class="center">Have an account? <a href="/signin">Sign in</a></p>`
      : `${errorBox(opts.error)}${signinForm("/signin", fields, opts.email)}<p class="center">New here? <a href="/signup">Create an account</a></p>`;
  return layout(mode === "signup" ? "Create account" : "Sign in", body);
}

function deviceList(devices: Device[]) {
  if (!devices.length) {
    return `<p class="muted">No Ring cameras are connected yet. Ring can take a few seconds to share them; they will appear on your dashboard. To add cameras later, open the Ring app, go to Ring Appstore → My Apps → ${e(APP_NAME)} and change your device selection.</p>`;
  }
  return `<ul class="devices">${devices
    .map(
      (d) =>
        `<li><span class="dot ${d.online === false ? "off" : "on"}" aria-hidden="true"></span>${e(d.name)} <span class="muted">— ${
          d.online === false ? "Offline" : d.online === true ? "Online" : "Status unknown"
        }${d.e2ee ? ", video encryption on (snapshots unavailable)" : ""}</span></li>`
    )
    .join("")}</ul>`;
}

export function linkSuccessPage(devices: Device[], already = false) {
  return layout(
    already ? "Already connected" : "Account linked",
    `<div class="card success" role="status"><h1>${already ? "Your Ring account is already connected" : "Account linked successfully"}</h1>
<p>${e(APP_NAME)} can now see the cameras you shared:</p>${deviceList(devices)}
<h2>What happens next</h2>
<ul><li>Each doorbell press or motion event appears in your <strong>Arrivals</strong> log with a snapshot, usually within a minute.</li>
<li>Facial recognition is <strong>off</strong>. If you want named arrivals, you can turn it on in the app and enroll people yourself.</li>
<li>Arrivals and snapshots are deleted automatically after ${CONFIG.RETENTION_DAYS} days.</li></ul>
<a class="button primary" href="/app">Go to dashboard</a></div>`
  );
}

export function messagePage(title: string, message: string, action?: { href: string; label: string }, status: "error" | "info" = "error") {
  return layout(
    title,
    `<div class="card ${status === "error" ? "error" : ""}" role="${status === "error" ? "alert" : "status"}"><h1>${e(title)}</h1><p>${e(message)}</p>${
      action ? `<a class="button primary" href="${e(action.href)}">${e(action.label)}</a>` : ""
    }</div>`
  );
}

export const LINK_EXPIRED_MESSAGE =
  "This connection link has expired (links are valid for 10 minutes). Open the Ring app, go to Ring Appstore → My Apps → Visitor Recognizer, and start the connection again.";
