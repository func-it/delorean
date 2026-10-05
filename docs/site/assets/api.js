// The API reference, read from api/openapi.yaml at load time: the page shows
// the contract itself, so it cannot drift from it.
import { load } from "../vendor/js-yaml.esm.min.js";
import { marked } from "../vendor/marked.esm.js";

const METHODS = ["get", "post", "put", "patch", "delete"];

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const block = (s) => (s ? marked.parse(s) : "");
const inline = (s) => (s ? marked.parseInline(s) : "");
const refName = (ref) => ref.split("/").pop();
const schemaId = (name) => `schema-${name.toLowerCase()}`;

/** Follows a local $ref ("#/components/…") to what it names. */
function resolve(spec, node) {
  if (!node?.$ref) return node;
  return node.$ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((at, key) => at?.[key], spec);
}

/** A schema as one line: a link for a named schema, its constraints after. */
function typeOf(s) {
  if (!s) return "";
  if (s.$ref) return `<a href="#${schemaId(refName(s.$ref))}">${esc(refName(s.$ref))}</a>`;
  if (s.const !== undefined) return `const <code>${esc(JSON.stringify(s.const))}</code>`;
  if (s.enum) return s.enum.map((v) => `<code>${esc(v)}</code>`).join(" | ");
  let type = Array.isArray(s.type) ? s.type.join(" | ") : (s.type ?? "any");
  if (type === "array") type = `${typeOf(s.items)}[]`;
  if (type === "object" && typeof s.additionalProperties === "object") type = `map of ${typeOf(s.additionalProperties)}`;
  const rules = [];
  if (s.format) rules.push(s.format);
  if (s.minimum !== undefined) rules.push(`≥ ${s.minimum}`);
  if (s.maximum !== undefined) rules.push(`≤ ${s.maximum}`);
  if (s.minLength !== undefined) rules.push(`length ≥ ${s.minLength}`);
  if (s.maxLength !== undefined) rules.push(`length ≤ ${s.maxLength}`);
  if (s.minItems !== undefined) rules.push(`items ≥ ${s.minItems}`);
  if (s.pattern) rules.push(`<code>${esc(s.pattern)}</code>`);
  return rules.length ? `${type} <span class="schema-type">(${rules.join(", ")})</span>` : type;
}

function table(head, rows) {
  if (!rows.length) return "";
  return `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function parameters(spec, op) {
  const rows = (op.parameters ?? []).map((p) => {
    const param = resolve(spec, p);
    return [
      `<code>${esc(param.name)}</code>${param.required ? '<span class="req">required</span>' : ""}`,
      esc(param.in),
      typeOf(param.schema),
      inline(param.description),
    ];
  });
  return rows.length ? `<h4>Parameters</h4>${table(["Name", "In", "Type", "Description"], rows)}` : "";
}

function requestBody(spec, op) {
  const body = resolve(spec, op.requestBody);
  if (!body) return "";
  return Object.entries(body.content ?? {})
    .map(([media, c]) => {
      const example = Object.values(c.examples ?? {})[0]?.value ?? c.example;
      return `<h4>Request body${body.required ? '<span class="req">required</span>' : ""}</h4>
        <p><code>${esc(media)}</code> · ${typeOf(c.schema)}</p>
        ${example ? `<pre><code>${esc(JSON.stringify(example, null, 2))}</code></pre>` : ""}`;
    })
    .join("");
}

function responses(spec, op) {
  const examples = [];
  const rows = Object.entries(op.responses ?? {}).map(([status, r]) => {
    const res = resolve(spec, r);
    const media = Object.entries(res.content ?? {})
      .map(([m, c]) => {
        for (const [name, ex] of Object.entries(c.examples ?? {})) examples.push([`${status} · ${name}`, ex.value]);
        if (c.example) examples.push([status, c.example]);
        return `<code>${esc(m)}</code> ${typeOf(c.schema)}`;
      })
      .join("<br>");
    const headers = Object.keys(res.headers ?? {})
      .map((h) => `<code>${esc(h)}</code>`)
      .join(" ");
    return [`<span class="status s${status[0]}">${esc(status)}</span>`, block(res.description), media, headers];
  });
  const shown = examples
    .map(
      ([label, value]) =>
        `<details><summary>Example ${esc(label)}</summary><pre><code>${esc(JSON.stringify(value, null, 2))}</code></pre></details>`,
    )
    .join("");
  return `<h4>Responses</h4>${table(["Status", "Description", "Body", "Headers"], rows)}${shown}`;
}

function curl(spec, path, method, op) {
  const base = spec.servers?.find((server) => server.url.endsWith(":24793"))?.url ?? "http://localhost:24793";
  const body = resolve(spec, op.requestBody);
  const c = body && Object.values(body.content ?? {})[0];
  const example = c && (Object.values(c.examples ?? {})[0]?.value ?? c.example);
  const lines = [`curl -s ${method === "get" ? "" : `-X ${method.toUpperCase()} `}${base}${path}`];
  if (example) {
    lines.push(`  -H 'content-type: application/json'`);
    lines.push(`  -d '${JSON.stringify(example).replace(/'/g, "'\\''")}'`);
  }
  return `<h4>Try it</h4><pre><code>${esc(lines.join(" \\\n"))}</code></pre>`;
}

function operations(spec) {
  const out = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      out.push(`<section class="op" id="op-${esc((op.operationId ?? `${method}-${path}`).toLowerCase())}">
        <div class="op-head">
          <span class="method ${method}">${method.toUpperCase()}</span>
          <h3>${esc(path)}</h3>
          <span class="summary">${inline(op.summary)}</span>
        </div>
        <div class="op-body">
          ${block(op.description)}
          ${parameters(spec, op)}
          ${requestBody(spec, op)}
          ${responses(spec, op)}
          ${curl(spec, path, method, op)}
        </div>
      </section>`);
    }
  }
  return out.join("");
}

function schemas(spec) {
  return Object.entries(spec.components?.schemas ?? {})
    .map(([name, s]) => {
      const required = new Set(s.required ?? []);
      const rows = Object.entries(s.properties ?? {}).map(([prop, p]) => [
        `<code>${esc(prop)}</code>${required.has(prop) ? '<span class="req">required</span>' : ""}`,
        typeOf(p),
        inline(p.description),
      ]);
      const shape = rows.length ? table(["Field", "Type", "Description"], rows) : `<p>${typeOf(s)}</p>`;
      return `<section class="schema"><h3 id="${schemaId(name)}">${esc(name)}</h3>${block(s.description)}${shape}</section>`;
    })
    .join("");
}

/** Renders the whole reference into target. */
export async function renderApi(url, target) {
  let spec;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    spec = load(await res.text());
  } catch (err) {
    target.innerHTML = `<p class="notice">Could not load <code>${esc(url)}</code> (${esc(err.message)}). Serve the site with <code>task docs</code> or <code>docker compose up docs</code>.</p>`;
    return;
  }
  const { info = {} } = spec;
  const servers = (spec.servers ?? []).map((s) => [`<code>${esc(s.url)}</code>`, inline(s.description)]);
  const problem = spec.components?.schemas?.ProblemCode;
  target.innerHTML = `
    <p class="eyebrow">API reference · OpenAPI ${esc(spec.openapi)} · version ${esc(info.version)}</p>
    <h1>${esc(info.title)}</h1>
    <p class="lead">${inline(info.summary)}</p>
    <p><a class="button" href="${esc(url)}" target="_blank" rel="noopener">Open the raw contract (api/openapi.yaml)</a></p>
    ${block(info.description)}
    <h2 id="servers">Servers</h2>
    ${table(["URL", "Server"], servers)}
    <h2 id="endpoints">Endpoints</h2>
    ${operations(spec)}
    ${problem ? `<h2 id="problem-codes">Problem codes</h2>${block(problem.description)}` : ""}
    <h2 id="schemas">Schemas</h2>
    ${schemas(spec)}`;
}
