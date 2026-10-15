/*
 * Grungus — shared UI helpers and the <g-avatar> element.
 * No framework: tiny DOM builder, name colors, date formatting.
 */
"use strict";

/**
 * Create an element, set attributes, append children.
 * Children may be strings (text nodes), nodes, arrays, or null/undefined.
 */
function el(tag, attrs) {
  var node = document.createElement(tag);
  if (attrs) {
    for (var key in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
      var value = attrs[key];
      if (value === null || value === undefined || value === false) continue;
      if (value === true) {
        node.setAttribute(key, "");
        continue;
      }
      if (key === "text") {
        node.textContent = String(value);
      } else if (key === "class") {
        node.className = value;
      } else if (key === "dataset" && typeof value === "object") {
        for (var d in value) node.dataset[d] = value[d];
      } else if (key.slice(0, 2) === "on" && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        node.setAttribute(key, value);
      }
    }
  }
  for (var i = 2; i < arguments.length; i++) {
    appendChild(node, arguments[i]);
  }
  return node;
}

function appendChild(node, child) {
  if (child === null || child === undefined) return;
  if (Array.isArray(child)) {
    for (var i = 0; i < child.length; i++) appendChild(node, child[i]);
    return;
  }
  if (typeof child === "string") node.appendChild(document.createTextNode(child));
  else if (child instanceof Node) node.appendChild(child);
}

/** Deterministic hue from a string — Discord-style per-user colors. */
function colorFor(seed) {
  var str = String(seed || "?");
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  var hue = Math.abs(hash) % 360;
  return "hsl(" + hue + ", 58%, 48%)";
}

/** Up to two uppercase initials ("grungus HQ" -> "GH"). */
function initials(name) {
  var words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "?";
  return words
    .slice(0, 2)
    .map(function (w) {
      return w.charAt(0).toUpperCase();
    })
    .join("");
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDay(ts) {
  return new Date(ts).toLocaleDateString([], {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function sameDay(a, b) {
  var da = new Date(a);
  var db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/**
 * <g-avatar> — avatar bubble with initial-letter fallback.
 * update({ name, userId, url?, load?, size?, square? })
 * `load` may be a Promise of a URL (async media fetch); when it resolves the
 * avatar re-renders with the image, unless a newer update superseded it.
 */
class GAvatar extends HTMLElement {
  constructor() {
    super();
    this._opts = {};
    this._token = 0;
  }

  connectedCallback() {
    this._render();
  }

  update(opts) {
    this._opts = opts || {};
    this._token += 1;
    var myToken = this._token;
    this._render();
    var self = this;
    if (this._opts.load && typeof this._opts.load.then === "function") {
      this._opts.load.then(function (url) {
        if (self._token === myToken && url) {
          self._opts.url = url;
          self._render();
        }
      });
    }
  }

  _render() {
    var o = this._opts || {};
    var size = o.size || 32;
    this.textContent = "";
    this.classList.toggle("squared", !!o.square);

    var av = el("span", { class: "av" });
    av.style.width = size + "px";
    av.style.height = size + "px";
    av.style.background = colorFor(o.userId || o.name || "?");
    av.style.fontSize = Math.max(10, Math.round(size * 0.4)) + "px";
    av.textContent = initials(o.name);

    if (o.url) {
      var img = el("img", { src: o.url, alt: "" });
      img.addEventListener("error", function () {
        img.remove();
      });
      av.textContent = "";
      av.appendChild(img);
    }

    this.appendChild(av);
  }
}

customElements.define("g-avatar", GAvatar);
