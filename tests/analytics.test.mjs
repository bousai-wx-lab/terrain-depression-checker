import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../analytics-consent.js", import.meta.url), "utf8");

assert.ok(html.includes('id="analyticsConsentPanel"'));
assert.ok(html.includes('id="analyticsAcceptButton"'));
assert.ok(html.includes('id="analyticsDeclineButton"'));
assert.ok(html.includes('id="analyticsSettingsButton"'));
assert.ok(html.includes('src="./analytics-consent.js?v=20260905-1"'));
assert.ok(html.includes("https://www.googletagmanager.com"));
assert.ok(html.includes("https://*.google-analytics.com"));
assert.ok(html.includes("共有URLに含まれる地図中心・選択地点・表示設定は送らず"));

assert.equal((script.match(/G-G2E9N4XNK1/g) || []).length, 1);
assert.ok(script.includes('analytics_storage: "denied"'));
assert.ok(script.includes('gtag("consent", "update", { analytics_storage: "granted" })'));
assert.ok(script.includes('allow_google_signals: false'));
assert.ok(script.includes('allow_ad_personalization_signals: false'));
assert.ok(script.includes('page_location: `${window.location.origin}${window.location.pathname}`'));
assert.ok(script.includes('page_path: window.location.pathname'));
assert.ok(script.includes('page_referrer: ""'));
assert.ok(!script.includes("window.location.search"));
assert.ok(!script.includes("URLSearchParams"));
assert.ok(script.indexOf("function loadGoogleTag") < script.indexOf("const initialConsent"));
assert.ok(script.includes("if (initialConsent === ACCEPTED) loadGoogleTag()"));

process.stdout.write("ANALYTICS_CONSENT_TESTS_OK page_view_only=1 query_excluded=1 basic_consent=1\n");
