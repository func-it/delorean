// The documentation site's shared behaviour: the services rail with live
// status, Markdown pages rendered from the repository's own files, and the
// outline of the page. Everything runs in the browser; the site is static.
import { marked } from "../vendor/marked.esm.js";

// The services of a local run. A service answers or it does not: the probe is
// a no-cors request, so its content stays unreadable but its arrival proves
// the service is up.
const SERVICES = [
  { name: "Web app", detail: "UI and BFF · :24790", url: "http://localhost:24790", probe: "http://localhost:24790/" },
  { name: "Quoter", detail: "/healthz · :24793", url: "http://localhost:24793/healthz", probe: "http://localhost:24793/healthz" },
  { name: "Langfuse", detail: "traces and benches · :24794", url: "http://localhost:24794", probe: "http://localhost:24794/api/public/health" },
];

const LINKS = [
  { name: "Catalog of the quoter", detail: "GET /v1/catalog", url: "http://localhost:24793/v1/catalog" },
  { name: "OpenAPI contract", detail: "api/openapi.yaml", url: "content/openapi.yaml" },
];

// Repository files that have a page of their own on this site.
const PAGES = {
  "README.md": "index.html",
  "docs/architecture.md": "architecture.html",
  "architecture.md": "architecture.html",
  "docs/testing.md": "testing.html",
  "testing.md": "testing.html",
  "api/openapi.yaml": "api.html",
  "docs/adr/0001-lire-le-panier-avec-des-modeles.md": "adr.html",
  "adr/0001-lire-le-panier-avec-des-modeles.md": "adr.html",
};

const OPEN_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M6 3H3v10h10v-3M9 3h4v4M13 3 7 9"/></svg>';

function el(tag, attrs = {}, html = "") {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.innerHTML = html;
  return node;
}

export async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The rail: services with their status and an Open button, then the links. */
export function renderRail(rail) {
  const services = el("section", { "aria-labelledby": "rail-services" });
  services.append(el("h2", { id: "rail-services" }, "Services"));
  const list = el("ul", { class: "services" });
  for (const s of SERVICES) {
    const item = el("li", { class: "service", "data-state": "checking" });
    item.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <span class="name">${s.name}</span>
      <a class="button open" href="${s.url}" target="_blank" rel="noopener">Open ${OPEN_ICON}</a>
      <span class="meta">${s.detail} · <span class="state">checking…</span></span>`;
    list.append(item);
    probe(s.probe).then((up) => {
      item.dataset.state = up ? "up" : "down";
      item.querySelector(".state").textContent = up ? "running" : s.planned ? "not built yet" : "not running";
    });
  }
  services.append(list);

  const links = el("section", { "aria-labelledby": "rail-links" });
  links.append(el("h2", { id: "rail-links" }, "Links"));
  const box = el("div", { class: "links" });
  for (const l of LINKS) {
    box.append(
      el(
        "a",
        { class: "button", href: l.url, target: "_blank", rel: "noopener" },
        `<span>${l.name} <span class="schema-type">${l.detail}</span></span>${OPEN_ICON}`,
      ),
    );
  }
  links.append(box);
  rail.prepend(services, links);
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes. */
export function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorHeadings(root) {
  const seen = new Map();
  for (const h of root.querySelectorAll("h1, h2, h3, h4")) {
    if (h.id) continue;
    let id = slug(h.textContent);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n) id = `${id}-${n}`;
    h.id = id;
    if (h.tagName !== "H1") h.append(el("a", { class: "anchor", href: `#${id}`, "aria-label": "Link to this section" }, "#"));
  }
}

// Links between repository files point to this site's pages when there is
// one; a path with no page stays visible as a repository path.
function rewriteLinks(root) {
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (/^[a-z]+:/i.test(href)) {
      a.target = "_blank";
      a.rel = "noopener";
      continue;
    }
    // anchors, buttons, the site's own pages and files are already right
    if (/^(#|content\/|[\w-]+\.html(#|$))/.test(href) || a.matches(".anchor, .button")) continue;
    const [path, hash] = href.split("#");
    const clean = path.replace(/^(\.\.\/)+|^\.\//, "");
    const page = PAGES[clean];
    if (page) {
      a.href = hash ? `${page}#${hash}` : page;
    } else {
      const span = el("span", { class: "repo-path", title: `In the repository: ${clean}` });
      span.textContent = a.textContent;
      a.replaceWith(span);
    }
  }
}

function wrapTables(root) {
  for (const table of root.querySelectorAll("table")) {
    // a Markdown table with blank headers (| | |) is a list of pairs: no header row
    const head = table.tHead;
    if (head && [...head.querySelectorAll("th")].every((th) => !th.textContent.trim())) head.remove();
    if (table.parentElement.classList.contains("table-wrap")) continue;
    const wrap = el("div", { class: "table-wrap" });
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

/** Renders a Markdown file of the repository into target. */
export async function renderMarkdown(url, target) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    target.innerHTML = marked.parse(await res.text());
  } catch (err) {
    target.innerHTML = `<p class="notice">Could not load <code>${url}</code> (${err.message}). Serve the site with <code>task docs</code> or <code>docker compose up docs</code>: opened as a file, the browser refuses to read the repository's files.</p>`;
    return;
  }
  prepare(target);
}

/** Anchors, links and tables of rendered content. */
export function prepare(root) {
  anchorHeadings(root);
  rewriteLinks(root);
  wrapTables(root);
}

/** The outline of the page, from its h2, with the current section marked. */
export function renderToc(article, rail) {
  const heads = [...article.querySelectorAll("h2[id]")];
  if (heads.length < 2) return;
  const nav = el("nav", { class: "toc", "aria-labelledby": "rail-toc" });
  nav.append(el("h2", { id: "rail-toc" }, "On this page"));
  const list = el("ol");
  const links = new Map();
  for (const h of heads) {
    const label = h.cloneNode(true);
    label.querySelector(".anchor")?.remove();
    const a = el("a", { href: `#${h.id}` });
    a.textContent = label.textContent;
    links.set(h, a);
    const li = el("li");
    li.append(a);
    list.append(li);
  }
  nav.append(list);
  rail.append(nav);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of links.values()) a.classList.remove("active");
        links.get(e.target)?.classList.add("active");
      }
    },
    { rootMargin: "-80px 0px -70% 0px" },
  );
  heads.forEach((h) => observer.observe(h));
}

/** After content arrives, honour a #section in the address. */
export function scrollToHash() {
  if (!location.hash) return;
  document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}
