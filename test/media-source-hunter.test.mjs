import test from "node:test";
import assert from "node:assert/strict";
import { discoverMediaSources, mediaSourceStatus } from "../dist/media-source-hunter.js";

function apiReply(data, { status = 200 } = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("status never discloses key material", () => {
  const status = mediaSourceStatus({ YOUTUBE_API_KEY: "SECRET_test_not_for_logging", PEXELS_API_KEY: "another_secret" });
  assert.equal(status.officialApis.youtube, true);
  assert.equal(status.officialApis.pexels, true);
  assert.equal(JSON.stringify(status).includes("SECRET"), false);
});

test("official YouTube Data API v3 returns reference metadata without source media", async () => {
  let requested = false;
  const result = await discoverMediaSources({
    query: "Apis cerana", kind: "video", providers: ["youtube"], orientation: "portrait", limit: 3
  }, { env: { YOUTUBE_API_KEY: "SECRET_test_not_for_logging" }, fetcher: async (input) => {
    const u = new URL(String(input));
    requested = true;
    assert.equal(u.hostname, "www.googleapis.com");
    assert.equal(u.pathname, "/youtube/v3/search");
    assert.equal(u.searchParams.get("q"), "Apis cerana");
    assert.equal(u.searchParams.get("maxResults"), "3");
    return apiReply({ items: [{ id: { videoId: "0je9rZUEHIY" },
      snippet: { title: "Apiculture", channelTitle: "Bee channel", thumbnails: {
        medium: { url: "https://i.ytimg.com/vi/0je9rZUEHIY/mqdefault.jpg" }
      } } }] });
  } });
  assert.equal(requested, true);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].rights_status, "reference_only");
  assert.equal(result.assets[0].media_url, null);
  assert.equal(result.assets[0].source_url, "https://www.youtube.com/watch?v=0je9rZUEHIY");
  assert.equal(JSON.stringify(result).includes("SECRET_test"), false);
});

test("missing key fails closed for YouTube while Commons can still work", async () => {
  const result = await discoverMediaSources({
    query: "honeybee", kind: "image", providers: ["youtube", "commons"], orientation: "any", limit: 2,
  }, { env: {}, fetcher: async () => apiReply({
    query: { pages: { "1": { pageid: 1, title: "File:Bee.jpg", imageinfo: [{
      mime: "image/jpeg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Bee.jpg",
      url: "https://upload.wikimedia.org/bee.jpg", width: 800, height: 600,
      extmetadata: { Artist: { value: "<b>Alice</b>" }, LicenseShortName: { value: "CC BY 4.0" } }
    }] } } }
  }) });
  assert.equal(result.notes.youtube, "YOUTUBE_API_KEY_NOT_CONFIGURED");
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].provider, "commons");
  assert.equal(result.assets[0].license, "CC BY 4.0");
  assert.equal(result.assets[0].rights_status, "license_review");
});

test("Google is a discovery reference and never a downloadable asset", async () => {
  const result = await discoverMediaSources({
    query: "mountain scenery", kind: "image", providers: ["google"], orientation: "landscape", limit: 4,
  }, { env: {} });
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].media_url, null);
  assert.equal(result.assets[0].rights_status, "reference_only");
  assert.match(result.assets[0].source_url, /^https:\/\/www\.google\.com\/search\?/);
});

test("official Pexels video endpoint and license state", async () => {
  const result = await discoverMediaSources({
    query: "forest", kind: "video", providers: ["pexels"], orientation: "portrait", limit: 2,
  }, { env: { PEXELS_API_KEY: "secret" }, fetcher: async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/videos/search");
    assert.equal(init.headers.Authorization, "secret");
    return apiReply({ videos: [{ id: 15, url: "https://www.pexels.com/video/15/",
      user: { name: "Alice" }, video_files: [{ file_type: "video/mp4", width: 1080, height: 1920,
        link: "https://videos.pexels.com/video15.mp4" }] }] });
  } });
  assert.equal(result.assets[0].media_url, "https://videos.pexels.com/video15.mp4");
  assert.equal(result.assets[0].rights_status, "license_review");
  assert.equal(result.assets[0].license, "Pexels License");
});

test("API errors do not reveal keys or request URLs", async () => {
  const key = "secret_url_leak_regression";
  const result = await discoverMediaSources({
    query: "bee", kind: "video", providers: ["youtube"], orientation: "any", limit: 1,
  }, { env: { YOUTUBE_API_KEY: key }, fetcher: async () => { throw new Error("https://api.bad/?key=" + key); } });
  assert.equal(result.notes.youtube, "PROVIDER_QUERY_FAILED");
  assert.equal(JSON.stringify(result).includes(key), false);
});

test("input is bounded and unsupported providers are refused", async () => {
  await assert.rejects(discoverMediaSources({
    query: "bee", kind: "video", providers: ["malicious"], orientation: "any", limit: 2
  }), /PROVIDERS_INVALID/);
  await assert.rejects(discoverMediaSources({
    query: "x".repeat(181), kind: "image", providers: ["commons"], orientation: "any", limit: 2
  }), /QUERY_LENGTH_INVALID/);
});

test("Openverse image API is metadata-only", async () => {
  const result = await discoverMediaSources({
    query: "bee", kind: "image", providers: ["openverse"], orientation: "any", limit: 1,
  }, { env: {}, fetcher: async (input) => {
    assert.equal(new URL(String(input)).hostname, "api.openverse.org");
    return apiReply({ results: [{ id: "id", title: "Bee", foreign_landing_url: "https://example.org/photo",
      url: "https://example.org/bee.jpg", thumbnail: "https://example.org/thumb.jpg",
      license: "by", license_version: "4.0", creator: "Alice" }] });
  } });
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].rights_status, "license_review");
  assert.equal(result.assets[0].license, "BY 4.0");
});
