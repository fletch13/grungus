/** Small shared stroke icons, rendered as SVG nodes without HTML interpolation. */
const paths = {
  home: ["m3 10 9-7 9 7", "M5 9v11h14V9", "M9 20v-7h6v7"],
  hash: ["M5 9h15M4 15h15M11 3 7 21M17 3l-4 18"],
  shield: ["M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z", "m8 12 3 3 5-6"],
  phone: ["M8 3H4a1 1 0 0 0-1 1c0 10 7 17 17 17a1 1 0 0 0 1-1v-4l-5-2-2 2a14 14 0 0 1-6-6l2-2Z"],
  video: ["M3 6h12v12H3z", "m15 10 6-4v12l-6-4"],
  settings: ["m9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3Z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0"],
  logout: ["M10 4H4v16h6", "M8 12h13m-4-4 4 4-4 4"],
  folder: ["M3 7V5h7l2 3h9v12H3Z"],
  plus: ["M12 5v14M5 12h14"],
  trash: ["M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"],
  attachment: ["m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l10-10", "m7 15 9-9"],
  arrow: ["M5 12h14m-6-6 6 6-6 6"],
  search: ["M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0", "m15 15 6 6"],
  chevron: ["m9 5 7 7-7 7"],
  check: ["m5 12 4 4L19 6"],
  close: ["m6 6 12 12M6 18 18 6"],
  bubble: ["M21 11a9 9 0 0 1-9 9H4l-3 2 2-6a9 9 0 1 1 18-5Z", "M8 10h8M8 14h5"],
  globe: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", "M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"],
  users: ["M15 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0", "M3 21v-3a6 6 0 0 1 12 0v3M17 4a4 4 0 0 1 0 8m2 9v-3a6 6 0 0 0-3-5"],
  key: ["M13 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0", "m12 12 9 9m-4-4 3-3m-6 0 3-3"],
} as const;
export type IconName = keyof typeof paths;
export function icon(name: IconName, size = 18): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: String(size), height: String(size), fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) node.setAttribute(key, value);
  node.classList.add("ui-icon");
  for (const d of paths[name]) {
    const path = document.createElementNS(node.namespaceURI, "path");
    path.setAttribute("d", d);
    node.appendChild(path);
  }
  return node;
}
