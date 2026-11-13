import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, lexicalSearch, parseVtt } from "../dist/video.js";

test("parseVtt extracts timestamped caption segments and merges exact adjacent duplicates", () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
Xin chào mọi người

00:00:02.100 --> 00:00:03.000
Xin chào mọi người

00:00:03.000 --> 00:00:06.500
Hôm nay nói về mật ong Yên Thế.
`;
  const segments = parseVtt(vtt);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].end, 3);
  assert.match(segments[1].text, /mật ong/i);
});

test("buildTimeline associates sparse keyframes with transcript windows", () => {
  const transcript = [
    { start: 0, end: 12, text: "Giới thiệu dự án" },
    { start: 46, end: 58, text: "Trình bày bảng giá mật ong" },
    { start: 91, end: 105, text: "Kết luận" },
  ];
  const frames = [
    { id: "cover", at: 0, path: "a.jpg", source: "cover" },
    { id: "scene-001", at: 52, path: "b.jpg", source: "scene" },
  ];
  const timeline = buildTimeline(transcript, frames, 120, 45);
  assert.ok(timeline.length >= 3);
  assert.ok(timeline.some((chunk) => chunk.keyframeIds.includes("scene-001")));
});

test("lexicalSearch is Vietnamese-diacritic tolerant", () => {
  const timeline = [
    { start: 0, end: 45, text: "Giới thiệu chung", keyframeIds: [] },
    { start: 45, end: 90, text: "Bảng giá mật ong rừng và quy trình đóng chai", keyframeIds: ["f1"] },
  ];
  const matches = lexicalSearch(timeline, "mat ong", 5);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].start, 45);
  assert.ok(matches[0].score > 0);
});
