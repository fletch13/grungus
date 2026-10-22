/** Preserve an explicit MIME type; recover common attachment types when the OS omits it. */
export function attachmentMimeType(name: string, provided?: string | null): string {
  const type = provided?.trim().toLowerCase();
  if (type && !["application/octet-stream", "binary/octet-stream"].includes(type)) return type;
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  return ({ webm: "video/webm", weba: "audio/webm", mp4: "video/mp4", m4v: "video/mp4", ogv: "video/ogg", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", pdf: "application/pdf", txt: "text/plain", zip: "application/zip" } as Record<string, string>)[extension] ?? "application/octet-stream";
}
