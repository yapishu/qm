const { CSS, document, sessionStorage } = globalThis;

const state = {
  token: sessionStorage.getItem("qm-host-token") || "",
  busy: new Set(),
};

const byId = (id) => document.getElementById(id);
const tenantsNode = byId("tenants");
const authDialog = byId("auth-dialog");
const logsDialog = byId("logs-dialog");

function showToast(message, bad = false) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.className = bad ? "show bad" : "show";
  globalThis.setTimeout(() => {
    toast.className = "";
  }, 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { authorization: `Bearer ${state.token}` },
  });
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (response.status === 401) {
    state.token = "";
    sessionStorage.removeItem("qm-host-token");
    authDialog.showModal();
    throw new Error("Admin token rejected");
  }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusPill(running, label) {
  const node = element("span", running ? "status good" : "status stopped", label);
  const dot = element("span", "dot");
  node.prepend(dot);
  return node;
}

async function operation(key, path, message) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  renderLoading(key);
  try {
    await api(path, { method: "POST" });
    showToast(message);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy.delete(key);
    await refresh();
  }
}

function renderLoading(key) {
  document.querySelectorAll(`[data-operation="${CSS.escape(key)}"]`).forEach((button) => {
    button.disabled = true;
    button.textContent = "Working…";
  });
}

function tenantCard(tenant) {
  const card = element("article", "tenant-card");
  const top = element("div", "tenant-top");
  const identity = element("div");
  identity.append(element("p", "eyebrow", tenant.hostname), element("h3", "", tenant.orgId));
  top.append(identity, statusPill(tenant.running, tenant.running ? "Running" : "Stopped"));

  const services = element("div", "services");
  if (tenant.services.length === 0) {
    services.append(element("p", "empty", "No containers are present."));
  } else {
    for (const service of tenant.services) {
      const row = element("div", "service-row");
      row.append(
        element("span", "service-name", service.name.replace(`qm-${tenant.orgId}-`, "")),
        element("span", service.state === "running" ? "service-state good-text" : "service-state", service.detail),
      );
      services.append(row);
    }
  }

  const actions = element("div", "card-actions");
  const open = element("a", "button-link secondary", "Open");
  open.href = tenant.publicUrl;
  open.target = "_blank";
  open.rel = "noreferrer";
  const logs = element("button", "secondary", "Logs");
  logs.addEventListener("click", () => showLogs(tenant));
  const lifecycle = element("button", tenant.running ? "danger" : "", tenant.running ? "Stop" : "Start");
  const key = tenant.orgId;
  lifecycle.dataset.operation = key;
  lifecycle.addEventListener("click", () =>
    operation(
      key,
      `/api/tenants/${encodeURIComponent(tenant.orgId)}/${tenant.running ? "down" : "up"}`,
      `${tenant.orgId} ${tenant.running ? "stopped" : "started"}`,
    ),
  );
  if (state.busy.has(key)) {
    lifecycle.disabled = true;
    lifecycle.textContent = "Working…";
  }
  actions.append(open, logs, lifecycle);
  card.append(top, services, actions);
  return card;
}

function render(status) {
  const running = status.tenants.filter((tenant) => tenant.running).length;
  byId("summary").textContent = `${running} of ${status.tenants.length} companies running on ${status.id}`;
  byId("updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  const gateway = byId("gateway-card");
  gateway.replaceChildren(
    statusPill(status.gateway.running, status.gateway.running ? "Gateway online" : "Gateway offline"),
    element("span", "gateway-name", status.gateway.name),
    element("span", "gateway-detail", status.gateway.detail),
  );
  tenantsNode.replaceChildren(...status.tenants.map(tenantCard));
}

async function refresh() {
  if (!state.token) {
    authDialog.showModal();
    return;
  }
  try {
    render(await api("/api/status"));
  } catch (error) {
    if (state.token) showToast(error.message, true);
  }
}

async function showLogs(tenant) {
  byId("logs-title").textContent = tenant.orgId;
  byId("logs").textContent = "Loading logs…";
  logsDialog.showModal();
  try {
    const body = await api(`/api/tenants/${encodeURIComponent(tenant.orgId)}/logs?service=core&tail=300`);
    byId("logs").textContent = body.logs || "No logs returned.";
  } catch (error) {
    byId("logs").textContent = error.message;
  }
}

byId("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = byId("token").value;
  sessionStorage.setItem("qm-host-token", state.token);
  authDialog.close();
  await refresh();
});

byId("refresh").addEventListener("click", refresh);
byId("gateway").addEventListener("click", () => operation("gateway", "/api/gateway/reconcile", "Gateway reconciled"));
byId("close-logs").addEventListener("click", () => logsDialog.close());

await refresh();
