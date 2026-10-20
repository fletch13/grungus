/** A small, text-only Markdown renderer: no HTML interpretation or unsafe URL schemes. */
export function formatMessage(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const tokens = /(```[\s\S]*?```|`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let position = 0;
  for (const match of text.matchAll(tokens)) {
    fragment.append(document.createTextNode(text.slice(position, match.index)));
    const value = match[0]; let node: HTMLElement;
    if (value.startsWith("```")) { node = document.createElement("pre"); const code = document.createElement("code"); code.textContent = value.slice(3, -3).replace(/^\w*\n/, ""); node.append(code); }
    else if (value.startsWith("`")) { node = document.createElement("code"); node.textContent = value.slice(1, -1); }
    else if (value.startsWith("**")) { node = document.createElement("strong"); node.textContent = value.slice(2, -2); }
    else if (value.startsWith("~~")) { node = document.createElement("del"); node.textContent = value.slice(2, -2); }
    else if (value.startsWith("*")) { node = document.createElement("em"); node.textContent = value.slice(1, -1); }
    else { const link = document.createElement("a"); const split = value.indexOf("]("); link.textContent = value.slice(1, split); link.href = value.slice(split + 2, -1); link.target = "_blank"; link.rel = "noopener noreferrer"; node = link; }
    fragment.append(node); position = match.index! + value.length;
  }
  fragment.append(document.createTextNode(text.slice(position)));
  return fragment;
}
