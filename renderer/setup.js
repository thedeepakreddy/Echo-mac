/*
 * Setup window.
 *
 * The field list comes from the main process rather than being duplicated here,
 * so adding a key in one place cannot leave this form out of date.
 */
const form = document.getElementById("keys");
const status = document.getElementById("status");
const pathEl = document.getElementById("path");

const api = window.jarvisSetup;

function field(f, value) {
  const wrap = document.createElement("div");
  wrap.className = "field";

  const row = document.createElement("div");
  row.className = "row";

  const label = document.createElement("label");
  label.textContent = f.label;
  label.htmlFor = f.env;

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = f.optional ? "optional" : "required";

  const link = document.createElement("a");
  link.textContent = "get a key";
  link.href = "#";
  // Opened in the real browser: this window has no navigation of its own.
  link.addEventListener("click", (e) => {
    e.preventDefault();
    api?.openUrl(f.url);
  });

  row.append(label, tag, link);

  const input = document.createElement("input");
  input.id = f.env;
  input.name = f.env;
  input.type = "password"; // a key on screen is a key over your shoulder
  input.spellcheck = false;
  input.placeholder = value ? "•••••••• saved" : "paste your key here";
  input.value = value ?? "";

  const help = document.createElement("p");
  help.className = "help";
  help.textContent = f.help;

  // Catch a mis-paste now rather than at runtime, but never block saving —
  // key formats change, and being wrong about that should not lock anyone out.
  const check = () => {
    const v = input.value.trim();
    const bad = v && f.hint && !v.startsWith(f.hint);
    input.classList.toggle("suspect", !!bad);
    help.classList.toggle("warn", !!bad);
    help.textContent = bad ? `That doesn't look like a ${f.label} key — they usually start "${f.hint}". Saving anyway is fine.` : f.help;
  };
  input.addEventListener("input", check);

  wrap.append(row, input, help);
  return wrap;
}

async function load() {
  if (!api) {
    status.textContent = "Setup bridge failed to load.";
    return;
  }
  const { fields, values, path } = await api.load();
  pathEl.textContent = path.replace(/^\/Users\/[^/]+/, "~");
  form.replaceChildren(...fields.map((f) => field(f, values[f.env])));
}

document.getElementById("save").addEventListener("click", async () => {
  const values = {};
  for (const input of form.querySelectorAll("input")) {
    values[input.name] = input.value.trim();
  }
  status.textContent = "Saving…";
  const res = await api.save(values);
  if (res?.ok) {
    status.textContent = res.count ? `Saved ${res.count} key(s).` : "Cleared.";
    // Let the confirmation be readable before the window goes.
    setTimeout(() => api.close(), 600);
  } else {
    status.textContent = res?.error ?? "Could not save.";
  }
});

document.getElementById("close").addEventListener("click", () => api?.close());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api?.close();
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) document.getElementById("save").click();
});

load();
