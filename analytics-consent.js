const MEASUREMENT_ID = "G-G2E9N4XNK1";
const CONSENT_STORAGE_KEY = "bwl-analytics-consent-v1";
const ACCEPTED = "granted";
const DECLINED = "denied";

const panel = document.getElementById("analyticsConsentPanel");
const acceptButton = document.getElementById("analyticsAcceptButton");
const declineButton = document.getElementById("analyticsDeclineButton");
const settingsButton = document.getElementById("analyticsSettingsButton");
let googleTagLoaded = false;
let restoreFocusAfterChoice = false;

function readConsent() {
  try {
    return window.localStorage.getItem(CONSENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeConsent(value) {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, value);
  } catch {
    // The choice applies to this page even when storage is unavailable.
  }
}

function gtag() {
  window.dataLayer.push(arguments);
}

function loadGoogleTag() {
  if (googleTagLoaded) return;
  googleTagLoaded = true;
  window[`ga-disable-${MEASUREMENT_ID}`] = false;
  window.dataLayer = window.dataLayer || [];
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
  });
  gtag("consent", "update", { analytics_storage: "granted" });
  gtag("js", new Date());
  gtag("config", MEASUREMENT_ID, {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    page_location: `${window.location.origin}${window.location.pathname}`,
    page_path: window.location.pathname,
    page_referrer: "",
  });

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  script.referrerPolicy = "no-referrer";
  script.dataset.analyticsLoader = "true";
  document.head.append(script);
}

function disableGoogleTag() {
  window[`ga-disable-${MEASUREMENT_ID}`] = true;
  if (window.dataLayer) {
    gtag("consent", "update", { analytics_storage: "denied" });
  }
  document.querySelector("script[data-analytics-loader]")?.remove();
}

function showPanel() {
  panel.hidden = false;
  acceptButton.focus({ preventScroll: true });
}

function hidePanel({ restoreFocus = false } = {}) {
  panel.hidden = true;
  if (restoreFocus) settingsButton.focus({ preventScroll: true });
}

function choose(value) {
  storeConsent(value);
  if (value === ACCEPTED) loadGoogleTag();
  else disableGoogleTag();
  hidePanel({ restoreFocus: restoreFocusAfterChoice });
  restoreFocusAfterChoice = false;
}

acceptButton.addEventListener("click", () => choose(ACCEPTED));
declineButton.addEventListener("click", () => choose(DECLINED));
settingsButton.addEventListener("click", () => {
  restoreFocusAfterChoice = true;
  showPanel();
});
panel.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && readConsent()) {
    hidePanel({ restoreFocus: restoreFocusAfterChoice });
    restoreFocusAfterChoice = false;
  }
});

const initialConsent = readConsent();
if (initialConsent === ACCEPTED) loadGoogleTag();
else if (initialConsent !== DECLINED) showPanel();
