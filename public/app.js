"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  let me = null;
  let objectUrls = [];

  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }

  function flash(message, kind) {
    const box = $("flash");
    box.replaceChildren(el("div", { class: kind === "error" ? "alert" : "okmsg" }, message));
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function api(path, opts) {
    const o = opts || {};
    const res = await fetch("/api" + path, {
      method: o.method || "GET",
      headers: Object.assign({ "Content-Type": "application/json" }, me ? { "X-CSRF-Token": me.csrf } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
      credentials: "same-origin",
    });
    if (res.status === 401) { location.href = "/signin?next=/app"; throw new Error("Signed out"); }
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    if (!res.ok) throw new Error((data && data.error) || "Something went wrong. Please try again.");
    return data;
  }

  const fmt = (iso) => new Date(iso).toLocaleString();

  // ---- confirm dialog -------------------------------------------------------------------------
  function confirmDialog({ title, body, ok, typed, password }) {
    return new Promise((resolve) => {
      const d = $("confirm");
      $("cf-title").textContent = title;
      $("cf-body").textContent = body;
      $("cf-ok").textContent = ok;
      const extra = $("cf-extra");
      extra.replaceChildren();
      let typedInput, pwInput;
      if (typed) {
        typedInput = el("input", { type: "text", id: "cf-typed", autocomplete: "off" });
        extra.append(el("label", { for: "cf-typed" }, `Type ${typed} to confirm`), typedInput);
      }
      if (password) {
        pwInput = el("input", { type: "password", id: "cf-pw", autocomplete: "current-password" });
        extra.append(el("label", { for: "cf-pw" }, "Your password"), pwInput);
      }
      const done = (v) => { d.close(); $("cf-ok").onclick = null; $("cf-cancel").onclick = null; resolve(v); };
      $("cf-cancel").onclick = () => done(null);
      $("cf-ok").onclick = () => {
        if (typed && typedInput.value.trim() !== typed) { typedInput.focus(); return; }
        done({ typed: typedInput ? typedInput.value.trim() : undefined, password: pwInput ? pwInput.value : undefined });
      };
      d.showModal();
    });
  }

  // ---- tutorial -------------------------------------------------------------------------------
  const STEPS = [
    ["Welcome to Visitor Recognizer", "Every time your Ring doorbell is pressed or a shared camera sees motion, the arrival appears here with a snapshot."],
    ["Check your Ring settings", "Arrivals only come in for motion inside your motion zones. If you expect more, open the Ring app, go to your device settings, and review Motion Settings and Motion Zones."],
    ["Facial recognition is optional", "It's off until you turn it on. When it's on, only people you enroll yourself are named; everyone else shows as Unknown."],
    ["Your data, your control", "Arrivals delete themselves after 30 days. You can download or delete your data, or your whole account, any time from Privacy and your data."],
  ];
  let step = 0;
  function showStep() {
    $("tut-progress").textContent = `Step ${step + 1} of ${STEPS.length}`;
    $("tut-title").textContent = STEPS[step][0];
    $("tut-body").textContent = STEPS[step][1];
    $("tut-back").disabled = step === 0;
    $("tut-next").textContent = step === STEPS.length - 1 ? "Finish" : "Next";
  }
  function openTutorial() { step = 0; showStep(); $("tutorial").showModal(); }
  async function closeTutorial(finished) {
    $("tutorial").close();
    if (!me.tutorialDone) { me.tutorialDone = true; await api("/tutorial-done", { method: "POST" }).catch(() => {}); }
    if (finished) flash("You're all set. New arrivals will appear below.");
  }
  $("tut-next").onclick = () => (step === STEPS.length - 1 ? closeTutorial(true) : (step++, showStep()));
  $("tut-back").onclick = () => { if (step) { step--; showStep(); } };
  $("tut-skip").onclick = () => closeTutorial(false);
  $("help-btn").onclick = openTutorial;

  // ---- Ring connection --------------------------------------------------------------------------
  async function loadRing() {
    const r = await api("/ring");
    const box = $("ring");
    box.replaceChildren();
    if (!r.links.length) {
      box.append(
        el("p", {}, "No Ring account is connected yet."),
        el("p", { class: "muted small" }, "To connect, open the Ring app, go to Ring Appstore, find Visitor Recognizer and choose Get. Ring will bring you back here to sign in.")
      );
      return;
    }
    for (const l of r.links) {
      const p = el("p", {}, "Connected to Ring account ", el("strong", {}, l.ringEmail), ` since ${fmt(l.linkedAt)}. `);
      if (l.status !== "active") p.append(el("span", { class: "tag warn" }, "Reconnect needed"), " Open the Ring app and connect Visitor Recognizer again from Ring Appstore → My Apps.");
      p.append(" ", el("button", { type: "button", class: "link", onclick: () => disconnect(l.key) }, "Stop using this Ring account here"));
      box.append(p);
    }
    if (!r.devices.length) {
      box.append(el("p", { class: "notice" }, "No Ring cameras are shared with Visitor Recognizer yet. To add cameras, open the Ring app, go to Ring Appstore → My Apps → Visitor Recognizer and change your device selection."));
    } else {
      const ul = el("ul", { class: "devices", "aria-label": "Connected cameras" });
      for (const d of r.devices) {
        const status = d.online === false ? "Offline" : d.online === true ? "Online" : "Status unknown";
        const li = el("li", {}, el("span", { class: "dot" + (d.online === false ? " off" : ""), "aria-hidden": "true" }), d.name, " ", el("span", { class: "muted" }, `— ${status}`));
        if (d.online === false) li.append(el("div", { class: "muted small" }, "This device is currently offline. Snapshots and events are unavailable until it reconnects."));
        if (d.encrypted) li.append(el("div", { class: "muted small" }, "Video encryption is on for this camera, so snapshots can't be read. Arrivals are still listed."));
        if (!d.recognitionAvailable) li.append(el("div", { class: "muted small" }, "Facial recognition isn't offered for cameras in this state because of local biometric privacy law. Arrivals still work."));
        ul.append(li);
      }
      box.append(ul, el("button", { type: "button", onclick: refreshDevices }, "Refresh cameras"));
    }
  }
  async function refreshDevices() {
    try { await api("/ring/refresh-devices", { method: "POST" }); await loadRing(); flash("Camera list updated."); } catch (e) { flash(e.message, "error"); }
  }
  async function disconnect(key) {
    const ok = await confirmDialog({ title: "Stop using this Ring account?", body: "Visitor Recognizer will delete its access to this Ring account and stop processing its events. To remove the app from Ring completely, also open the Ring app → Ring Appstore → My Apps → Visitor Recognizer → Remove.", ok: "Stop using it" });
    if (!ok) return;
    try { await api("/ring/disconnect", { method: "POST", body: { key } }); await loadRing(); flash("Done. Visitor Recognizer no longer has access to that Ring account."); } catch (e) { flash(e.message, "error"); }
  }

  // ---- arrivals -------------------------------------------------------------------------------
  const STATUS = {
    recognized: ["Recognized", "recognized"],
    unknown: ["Unknown person", "unknown"],
    no_face: ["No face seen", "unknown"],
    logged: ["Arrival", "unknown"],
    encrypted: ["Encrypted video", "warn"],
    unavailable: ["No snapshot", "warn"],
  };
  async function loadSnapshot(img, url) {
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) return;
      const u = URL.createObjectURL(await res.blob());
      objectUrls.push(u);
      img.src = u;
    } catch { /* ignore */ }
  }
  async function loadEvents() {
    const list = await api("/events");
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls = [];
    const box = $("events");
    box.replaceChildren();
    if (!list.length) {
      box.append(el("p", { class: "muted" }, "No arrivals yet. They appear here after a doorbell press or motion on a shared camera."));
      return;
    }
    for (const ev of list) {
      const [label, cls] = STATUS[ev.status] || ["Arrival", "unknown"];
      const what = ev.kind === "button_press" ? "Doorbell press" : `Motion${ev.subType && ev.subType !== "motion" ? ` (${ev.subType.replace(/_/g, " ")})` : ""}`;
      const card = el("article", { class: "event" });
      if (ev.snapshotUrl) {
        const img = el("img", { alt: `Snapshot from ${ev.device} at ${fmt(ev.at)}` });
        card.append(img);
        loadSnapshot(img, ev.snapshotUrl);
      }
      let headline = label;
      if (ev.status === "recognized") headline = ev.recognized.map((r) => r.name).join(", ") + (ev.unknownFaces ? ` + ${ev.unknownFaces} unknown` : "");
      if (ev.status === "unknown") headline = ev.unknownFaces > 1 ? `${ev.unknownFaces} unknown people` : "Unknown person";
      card.append(
        el("p", {}, el("span", { class: "tag " + cls }, headline)),
        el("p", { class: "small" }, `${what} · ${ev.device}`, el("br"), fmt(ev.at))
      );
      if (ev.note) card.append(el("p", { class: "muted small" }, ev.note));
      if (ev.status === "recognized") card.append(el("p", { class: "muted small" }, "Match score: " + ev.recognized.map((r) => `${r.name} ${Math.round(r.score * 100)}%`).join(", ") + ". Matches can be wrong; check the photo."));
      const actions = el("div");
      if (me.recognitionConsent && ev.snapshotUrl && ev.status === "unknown" && ev.unknownFaces === 1) {
        actions.append(el("button", { type: "button", onclick: () => enrollFromEvent(ev) }, "Enroll this person"), " ");
      }
      actions.append(el("button", { type: "button", class: "danger", onclick: () => deleteEvent(ev.id) }, "Delete"));
      card.append(actions);
      box.append(card);
    }
  }
  async function deleteEvent(id) {
    const ok = await confirmDialog({ title: "Delete this arrival?", body: "The arrival and its snapshot will be permanently deleted.", ok: "Delete" });
    if (!ok) return;
    try { await api(`/events/${encodeURIComponent(id)}`, { method: "DELETE" }); flash("Arrival deleted."); await loadEvents(); } catch (e) { flash(e.message, "error"); }
  }
  function enrollFromEvent(ev) {
    $("en-event").value = ev.id;
    $("en-photo").value = "";
    $("en-from-event").hidden = false;
    $("en-name").focus();
  }
  $("en-clear").onclick = () => { $("en-event").value = ""; $("en-from-event").hidden = true; };

  // ---- facial recognition -----------------------------------------------------------------------
  async function loadRecognition() {
    const on = Boolean(me.recognitionConsent);
    $("fr-state").textContent = on ? "On" : "Off";
    $("fr-off").hidden = on;
    $("fr-on").hidden = !on;
    if (!on) return;
    $("consent-info").textContent = `You turned on facial recognition on ${fmt(me.recognitionConsent.grantedAt)}.`;
    const list = await api("/visitors");
    const box = $("visitors");
    box.replaceChildren();
    if (!list.length) {
      box.append(el("p", { class: "muted" }, "Nobody is enrolled yet, so every arrival is shown as Unknown. Enroll someone below."));
      return;
    }
    const tbody = el("tbody");
    for (const v of list) {
      tbody.append(el("tr", {}, el("td", {}, v.name), el("td", {}, fmt(v.enrolledAt)), el("td", {}, v.consentMethod),
        el("td", {}, el("button", { type: "button", class: "danger", onclick: () => deleteVisitor(v) }, `Delete ${v.name}`))));
    }
    box.append(el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Enrolled"), el("th", {}, "How they agreed"), el("th", {}, el("span", { class: "muted" }, "Action")))), tbody));
  }
  async function deleteVisitor(v) {
    const ok = await confirmDialog({ title: `Delete ${v.name}?`, body: `${v.name}'s face template will be permanently deleted and their name removed from past arrivals. This can't be undone.`, ok: "Delete permanently" });
    if (!ok) return;
    try { const r = await api(`/visitors/${encodeURIComponent(v.id)}`, { method: "DELETE" }); flash(r.message || "Deleted."); await refreshAll(); } catch (e) { flash(e.message, "error"); }
  }
  $("consent-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!$("consent-box").checked) { flash("Tick the box to agree before turning on facial recognition.", "error"); return; }
    try {
      const r = await api("/consent", { method: "POST", body: { agree: true, version: me.consentVersion } });
      me.recognitionConsent = r.recognitionConsent;
      $("consent-box").checked = false;
      flash("Facial recognition is on. Enroll the people you want named.");
      await refreshAll();
    } catch (err) { flash(err.message, "error"); }
  });
  $("revoke").onclick = async () => {
    const ok = await confirmDialog({ title: "Turn off facial recognition?", body: "All enrolled faces will be permanently deleted and names removed from past arrivals. Arrivals and snapshots stay.", ok: "Turn off and delete" });
    if (!ok) return;
    try { const r = await api("/consent", { method: "DELETE" }); me.recognitionConsent = null; flash(`Facial recognition is off. ${r.templatesDeleted} face template(s) permanently deleted.`); await refreshAll(); } catch (e) { flash(e.message, "error"); }
  };
  const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
  $("enroll-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { name: $("en-name").value.trim(), method: $("en-method").value, attest: $("en-attest").checked };
    if (!body.attest) { flash("Confirm that this person agreed to be enrolled.", "error"); return; }
    if ($("en-event").value) body.eventId = $("en-event").value;
    else if ($("en-photo").files[0]) body.imageData = await readFile($("en-photo").files[0]);
    else { flash("Choose a photo, or pick an arrival with “Enroll this person”.", "error"); return; }
    try {
      await api("/visitors", { method: "POST", body });
      e.target.reset(); $("en-event").value = ""; $("en-from-event").hidden = true;
      flash(`${body.name} is enrolled. Their photo was not kept, only the face template.`);
      await refreshAll();
    } catch (err) { flash(err.message, "error"); }
  });

  // ---- data rights ----------------------------------------------------------------------------
  $("del-data").onclick = async () => {
    const ok = await confirmDialog({ title: "Delete all my data?", body: "This permanently deletes your arrivals, snapshots, enrolled faces, camera list, Ring connection and activity log. Your sign-in stays so you can connect again.", ok: "Delete everything", typed: "DELETE" });
    if (!ok) return;
    try { await api("/delete-data", { method: "POST", body: { confirm: "DELETE" } }); me.recognitionConsent = null; flash("All your data was permanently deleted."); await refreshAll(); } catch (e) { flash(e.message, "error"); }
  };
  $("del-account").onclick = async () => {
    const ok = await confirmDialog({ title: "Delete my account?", body: "This permanently deletes your account and everything in it. To also remove the app from Ring, open the Ring app → Ring Appstore → My Apps → Visitor Recognizer → Remove.", ok: "Delete my account", typed: "DELETE", password: true });
    if (!ok) return;
    try { await api("/delete-account", { method: "POST", body: { confirm: "DELETE", password: ok.password } }); document.body.replaceChildren(el("main", { class: "narrow" }, el("div", { class: "card success", role: "status" }, el("h1", {}, "Your account was deleted"), el("p", {}, "Your account and all of its data have been permanently deleted."), el("a", { class: "button", href: "/" }, "Home")))); } catch (e) { flash(e.message, "error"); }
  };
  const ACTIVITY = {
    account_created: "Account created", signed_in: "Signed in", sign_in_failed: "Failed sign-in attempt", ring_account_linked: "Ring account connected",
    ring_integration_added: "Ring confirmed the connection", ring_integration_removed: "Ring connection removed in the Ring app", ring_disconnected_in_app: "Ring account disconnected here",
    ring_device_removed: "A camera was removed", ring_link_failed: "Ring connection attempt failed", ring_token_refresh_failed: "Ring access expired; reconnect needed",
    recognition_consent_granted: "Facial recognition turned on", recognition_consent_revoked: "Facial recognition turned off (templates deleted)",
    face_enrolled: "Person enrolled", face_deleted: "Enrolled person deleted", event_deleted: "Arrival deleted", data_exported: "Data downloaded", all_data_deleted: "All data deleted",
    ring_account_moved_to_other_user: "Ring account connected to a different Visitor Recognizer account", recognition_expired_inactivity: "Facial recognition turned off after a year without sign-in (templates deleted)", subscription_activated: "Subscription activated", subscription_deactivated: "Subscription ended",
  };
  async function loadActivity() {
    const list = await api("/activity");
    const box = $("activity");
    box.replaceChildren(list.length ? el("ul", {}, list.slice(0, 50).map((a) => el("li", {}, `${fmt(a.at)} — ${ACTIVITY[a.kind] || a.kind}`))) : el("p", { class: "muted" }, "No activity yet."));
  }

  async function refreshAll() {
    await Promise.all([loadRing(), loadEvents(), loadRecognition(), loadActivity()]);
  }

  $("reload").onclick = () => loadEvents().catch((e) => flash(e.message, "error"));

  (async function init() {
    try {
      me = await api("/me");
      $("who").textContent = me.email + " ";
      $("signout-csrf").value = me.csrf;
      $("consent-text").textContent = me.consentText;
      $("attest-text").textContent = me.attestationText;
      document.querySelectorAll(".retention").forEach((n) => (n.textContent = me.retentionDays));
      await refreshAll();
      if (!me.tutorialDone) openTutorial();
    } catch (e) {
      flash(e.message, "error");
    }
  })();
})();
