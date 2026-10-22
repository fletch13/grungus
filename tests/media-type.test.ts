import test from "node:test";
import assert from "node:assert/strict";
import { attachmentMimeType } from "../src/renderer/services/media-type.ts";
test("attachments recover WebM MIME types while preserving explicit audio and codec information", () => {
  assert.equal(attachmentMimeType("Schicksalsschlag.WEBM", ""), "video/webm");
  assert.equal(attachmentMimeType("clip.webm", "application/octet-stream"), "video/webm");
  assert.equal(attachmentMimeType("voice.webm", "audio/webm"), "audio/webm");
  assert.equal(attachmentMimeType("clip.webm", "video/webm;codecs=vp9"), "video/webm;codecs=vp9");
  assert.equal(attachmentMimeType("document.pdf"), "application/pdf");
  assert.equal(attachmentMimeType("unknown.xyz"), "application/octet-stream");
});
