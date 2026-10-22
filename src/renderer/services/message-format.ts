/** A small, text-only Markdown renderer: no HTML interpretation or unsafe URL schemes. */
function inline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const tokens = /(```[\s\S]*?```|`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|__[^_\n]+__|_[^_\n]+_|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let position = 0;
  for (const match of text.matchAll(tokens)) {
    fragment.append(document.createTextNode(text.slice(position, match.index)));
    const value = match[0]; let node: HTMLElement;
    if (value.startsWith("```")) { node = document.createElement("pre"); const code = document.createElement("code"); code.textContent = value.slice(3, -3).replace(/^\w*\n/, ""); node.append(code); }
    else if (value.startsWith("`")) { node = document.createElement("code"); node.textContent = value.slice(1, -1); }
    else if ((value.startsWith("**") || value.startsWith("__"))) { node = document.createElement("strong"); node.textContent = value.slice(2, -2); }
    else if (value.startsWith("~~")) { node = document.createElement("del"); node.textContent = value.slice(2, -2); }
    else if ((value.startsWith("*") || value.startsWith("_"))) { node = document.createElement("em"); node.textContent = value.slice(1, -1); }
    else { const link = document.createElement("a"); const split = value.indexOf("]("); link.textContent = value.slice(1, split); link.href = value.slice(split + 2, -1); link.target = "_blank"; link.rel = "noopener noreferrer"; node = link; }
    fragment.append(node); position = match.index! + value.length;
  }
  fragment.append(document.createTextNode(text.slice(position)));
  return fragment;
}

/** Block Markdown uses DOM nodes only; raw HTML always stays literal. */
export function formatMessage(text: string): DocumentFragment {
  const result = document.createDocumentFragment();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const code = document.createElement("code"), pre = document.createElement("pre");
      const content: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith("```")) content.push(lines[i]!);
      code.textContent = content.join("\n"); pre.append(code); result.append(pre); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { const node = document.createElement(`h${heading[1]!.length}`); node.append(inline(heading[2]!)); result.append(node); continue; }
    if (/^> ?/.test(line)) { const node = document.createElement("blockquote"); node.append(inline(line.replace(/^> ?/, ""))); result.append(node); continue; }
    const list = /^(?:[-*+] |\d+\. )/.exec(line);
    if (list) {
      const ordered = /^\d/.test(line), node = document.createElement(ordered ? "ol" : "ul");
      do { const item = document.createElement("li"); item.append(inline(lines[i]!.replace(/^(?:[-*+] |\d+\. )/, ""))); node.append(item); i++; }
      while (i < lines.length && (ordered ? /^\d+\. / : /^[-*+] /).test(lines[i]!));
      i--; result.append(node); continue;
    }
    result.append(inline(line)); if (i < lines.length - 1) result.append(document.createTextNode("\n"));
  }
  return result;
}

/** Count complete emoji graphemes, including flags, skin tones and families. */
export function emojiOnlyCount(text: string): number {
  const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text.trim())].map(part => part.segment).filter(part => !/^\s+$/.test(part));
  return parts.length > 0 && parts.length <= 5 && parts.every(part => /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*(?:\u200D\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*)*)$/u.test(part)) ? parts.length : 0;
}
