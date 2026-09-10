/**
 * FruitsHub Private Master Administration & Analytics Console
 * Vanilla JS Application
 */

const AdminApp = (() => {
  // State
  let authToken = sessionStorage.getItem("fh_admin_token") || "";
  let isMaintenance = false;
  let autoRefreshTimer = null;
  let isAutoRefreshOn = true;
  let activeTab = "tab-overview";
  let executorRange = "all";

  // Keys Pagination & Filter State
  const keyState = {
    search: "",
    status: "all",
    tier: "all",
    page: 1,
    limit: 25,
    totalPages: 1,
    searchDebounce: null
  };

  // Color palette for executors
  const EXECUTOR_COLORS = [
    "fill-cyan",
    "fill-green",
    "fill-purple",
    "fill-amber",
    "fill-muted"
  ];

  // API Client Helper
  async function apiRequest(endpoint, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {})
    };

    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    try {
      const res = await fetch(endpoint, {
        ...options,
        headers
      });

      if (res.status === 401) {
        // Session expired or unauthorized
        sessionStorage.removeItem("fh_admin_token");
        authToken = "";
        showLoginOverlay();
        showToast("Sesión expirada. Por favor introduce tu contraseña de nuevo.", "error");
        throw new Error("Unauthorized");
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP Error ${res.status}`);
      }

      return data;
    } catch (err) {
      console.error(`[-] API Error [${endpoint}]:`, err);
      throw err;
    }
  }

  // Toast Notification System
  function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    let icon = "ℹ️";
    if (type === "success") icon = "✅";
    if (type === "error") icon = "⚠️";

    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      toast.style.transition = "all 0.25s ease";
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Formatter for dates
  function formatDate(isoStr) {
    if (!isoStr) return "Nunca";
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return "Inválido";
      const now = Date.now();
      const diffMs = d.getTime() - now;

      // If permanent (>10 years)
      if (diffMs > 10 * 365 * 24 * 3600 * 1000) {
        return "Permanente (Lifetime)";
      }

      return d.toLocaleDateString("es-ES", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return isoStr;
    }
  }

  function formatTimeAgo(timestamp) {
    if (!timestamp) return "Nunca";
    const now = Date.now();
    const diffSec = Math.floor((now - timestamp) / 1000);

    if (diffSec < 10) return "Ahora mismo";
    if (diffSec < 60) return `Hace ${diffSec}s`;
    const min = Math.floor(diffSec / 60);
    if (min < 60) return `Hace ${min}m`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `Hace ${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `Hace ${days}d`;
  }

  // UI State Transitions
  function showLoginOverlay() {
    document.getElementById("login-overlay")?.classList.remove("hidden");
    document.getElementById("admin-app")?.classList.add("hidden");
  }

  function hideLoginOverlay() {
    document.getElementById("login-overlay")?.classList.add("hidden");
    document.getElementById("admin-app")?.classList.remove("hidden");
  }

  // Auth Initialization
  async function initAuth() {
    if (!authToken) {
      showLoginOverlay();
      return;
    }

    try {
      await apiRequest("/api/admin/verify");
      hideLoginOverlay();
      loadAllData();
      startAutoRefresh();
    } catch {
      showLoginOverlay();
    }
  }

  // Handle Login Submission
  async function handleLogin(e) {
    e.preventDefault();
    const secretInput = document.getElementById("input-admin-secret");
    const errorBox = document.getElementById("login-error");
    const btnSubmit = document.getElementById("btn-login-submit");
    const secret = secretInput.value.trim();

    if (!secret) return;

    btnSubmit.disabled = true;
    errorBox.classList.add("hidden");

    try {
      const data = await apiRequest("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ secret })
      });

      authToken = data.token;
      sessionStorage.setItem("fh_admin_token", authToken);
      secretInput.value = "";
      hideLoginOverlay();
      showToast("¡Consola de administración desbloqueada!", "success");
      loadAllData();
      startAutoRefresh();
    } catch (err) {
      errorBox.textContent = err.message || "Clave secreta incorrecta.";
      errorBox.classList.remove("hidden");
    } finally {
      btnSubmit.disabled = false;
    }
  }

  // Logout
  function handleLogout() {
    sessionStorage.removeItem("fh_admin_token");
    authToken = "";
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    showLoginOverlay();
    showToast("Sesión cerrada.", "info");
  }

  // Tab Switcher
  function switchTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll(".nav-tab").forEach(tab => {
      tab.classList.toggle("active", tab.dataset.tab === tabId);
    });

    document.querySelectorAll(".tab-panel").forEach(panel => {
      panel.classList.toggle("active", panel.id === tabId);
      if (panel.id === tabId) {
        panel.classList.remove("hidden");
      } else {
        panel.classList.add("hidden");
      }
    });

    // Lazy load data for tab
    if (tabId === "tab-keys") loadKeys();
    if (tabId === "tab-executors") loadExecutors(executorRange);
    if (tabId === "tab-logs") loadLogs();
  }

  // Load Overview Data
  async function loadOverview() {
    try {
      const data = await apiRequest("/api/admin/overview");
      const kpi = data.kpi || {};

      document.getElementById("kpi-total-keys").textContent = (kpi.totalKeys || 0).toLocaleString();
      document.getElementById("badge-total-keys").textContent = kpi.totalKeys || 0;
      document.getElementById("kpi-active-keys").textContent = (kpi.activeKeys || 0).toLocaleString();
      document.getElementById("kpi-today-execs").textContent = (kpi.todayExecutions || 0).toLocaleString();
      document.getElementById("kpi-total-execs").textContent = (kpi.totalExecutions || 0).toLocaleString();

      document.getElementById("kpi-keys-sub").textContent = `${kpi.activeKeys || 0} activas, ${(kpi.totalKeys || 0) - (kpi.activeKeys || 0)} expiradas`;

      // Update maintenance status
      isMaintenance = !!kpi.maintenance;
      updateMaintenanceUI(isMaintenance);

      if (kpi.activeVersion) {
        const verEl = document.getElementById("overview-script-ver");
        if (verEl) verEl.textContent = kpi.activeVersion;
      }

      // Render Top 5 Executors in Overview
      renderOverviewExecutors(data.topExecutors || []);
    } catch (err) {
      console.error("[-] Error loading overview:", err);
    }
  }

  function renderOverviewExecutors(topExecutors) {
    const listEl = document.getElementById("overview-executors-list");
    if (!listEl) return;

    if (!topExecutors || topExecutors.length === 0) {
      listEl.innerHTML = `
        <div class="loading-state" style="padding: 16px;">
          No hay ejecuciones registradas todavía.<br>
          <small style="color: var(--text-tertiary);">Aparecerán aquí tan pronto como los jugadores ejecuten el script.</small>
        </div>
      `;
      return;
    }

    const totalInTop = topExecutors.reduce((sum, e) => sum + (e.count || 0), 0) || 1;

    let html = "";
    topExecutors.forEach((item, idx) => {
      const pct = Math.round(((item.count || 0) / totalInTop) * 100);
      const colorClass = EXECUTOR_COLORS[idx % EXECUTOR_COLORS.length];

      html += `
        <div class="ranking-item">
          <div class="ranking-item-header">
            <span class="ranking-executor-name">
              <span style="color: var(--cyan-400); font-family: var(--font-mono); font-size: 0.75rem;">#${idx + 1}</span>
              ${escapeHtml(item.executor)}
            </span>
            <span class="ranking-executor-stats">${item.count.toLocaleString()} cargas (${pct}%)</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill ${colorClass}" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    });

  // Key Pill Formatter (Prevents vertical breaking and allows 1-click copy)
  function formatKeyPill(key) {
    if (!key || key === "NONE") return `<span style="color: var(--text-muted);">—</span>`;
    const display = key.length > 24 
      ? `${key.substring(0, 10)}...${key.substring(key.length - 8)}` 
      : key;
    return `
      <div class="key-pill-wrap" title="Key: ${escapeHtml(key)} (Clic para copiar)" onclick="AdminApp.copyText('${escapeHtml(key)}')">
        <span style="font-size: 0.8rem;">🔑</span>
        <code class="key-pill-code">${escapeHtml(display)}</code>
        <span class="key-copy-hint">Copiar</span>
      </div>
    `;
  }

  // Load Keys Data
  async function loadKeys() {
    const tbody = document.getElementById("tbody-keys");
    if (!tbody) return;

    try {
      const query = new URLSearchParams({
        search: keyState.search,
        status: keyState.status,
        tier: keyState.tier,
        page: keyState.page,
        limit: keyState.limit
      });

      const data = await apiRequest(`/api/admin/keys?${query.toString()}`);
      const keys = data.keys || [];
      const pagination = data.pagination || {};

      keyState.totalPages = pagination.totalPages || 1;

      // Update pagination controls
      document.getElementById("pagination-info").textContent = `Mostrando ${keys.length} de ${pagination.total || 0} keys (Página ${pagination.page} de ${keyState.totalPages})`;
      document.getElementById("page-current-number").textContent = pagination.page;
      document.getElementById("btn-page-prev").disabled = pagination.page <= 1;
      document.getElementById("btn-page-next").disabled = pagination.page >= keyState.totalPages;

      if (keys.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6" style="color: var(--text-tertiary);">No se encontraron keys con los filtros seleccionados.</td></tr>`;
        return;
      }

      let rowsHtml = "";
      keys.forEach(k => {
        const isPerm = ["permanent", "lifetime", "admin"].includes(k.tier.toLowerCase());
        const isBound = k.hwid && k.hwid !== "UNSET" && k.hwid !== "UNBOUND";

        // Status badge
        let statusBadge = `<span class="badge badge-active">Activa</span>`;
        if (k.status === "revoked") {
          statusBadge = `<span class="badge badge-revoked">Revocada</span>`;
        } else if (k.status === "expired") {
          statusBadge = `<span class="badge badge-expired">Expirada</span>`;
        }

        // HWID badge
        let hwidBadge = `<span class="badge badge-unset">UNSET (Libre)</span>`;
        if (isBound) {
          const shortHwid = k.hwid.length > 18 ? `${k.hwid.substring(0, 8)}...${k.hwid.substring(k.hwid.length - 6)}` : k.hwid;
          hwidBadge = `
            <span class="badge badge-bound" title="${escapeHtml(k.hwid)} (Clic para copiar)" style="cursor: pointer;" onclick="AdminApp.copyText('${escapeHtml(k.hwid)}')">
              🔒 ${escapeHtml(shortHwid)}
            </span>
          `;
        }

        // Tier badge
        const tierBadge = `<span class="badge badge-tier">${escapeHtml(k.tier)}</span>`;

        // Remaining / Expiry String
        let expiryText = formatDate(k.expires_at);
        if (isPerm) expiryText = "Permanente";

        rowsHtml += `
          <tr>
            <td>
              ${formatKeyPill(k.key)}
            </td>
            <td>
              <span style="font-size: 0.82rem; color: ${k.note ? '#fff' : 'var(--text-muted)'}">
                ${escapeHtml(k.note || "—")}
              </span>
            </td>
            <td>${tierBadge}</td>
            <td>
              <span class="badge badge-tier" style="background: rgba(255,255,255,0.05); color: #fff;">
                ⚡ ${k.executions_count || 0}
              </span>
            </td>
            <td>${hwidBadge}</td>
            <td>
              <div style="display: flex; flex-direction: column; gap: 2px;">
                <div>${statusBadge}</div>
                <small style="color: var(--text-tertiary); font-size: 0.72rem;">${expiryText}</small>
              </div>
            </td>
            <td class="text-right">
              <div class="action-btns-wrap">
                <!-- 1-Click HWID Reset -->
                <button 
                  class="btn-action btn-action-hwid" 
                  title="Liberar HWID para que el usuario pueda usarla en otro PC"
                  onclick="AdminApp.resetHwid('${escapeHtml(k.key)}')"
                >
                  🔄 Reset HWID
                </button>

                <!-- Extend -->
                <button 
                  class="btn-action btn-action-extend" 
                  title="Sumar tiempo a la key"
                  onclick="AdminApp.openExtendModal('${escapeHtml(k.key)}')"
                >
                  + Tiempo
                </button>

                <!-- Toggle Active -->
                <button 
                  class="btn-action btn-action-toggle" 
                  title="${k.active ? 'Revocar key' : 'Reactivar key'}"
                  onclick="AdminApp.toggleActiveKey('${escapeHtml(k.key)}', ${!k.active})"
                >
                  ${k.active ? 'Desactivar' : 'Activar'}
                </button>

                <!-- Copy Roblox Script Loader -->
                <button 
                  class="btn-action btn-action-toggle" 
                  title="Copiar snippet de Roblox con esta Key lista"
                  onclick="AdminApp.copyLoaderWithKey('${escapeHtml(k.key)}')"
                >
                  📜 Loader
                </button>

                <!-- Delete -->
                <button 
                  class="btn-action btn-action-delete" 
                  title="Eliminar key definitivamente"
                  onclick="AdminApp.deleteKey('${escapeHtml(k.key)}')"
                >
                  🗑️
                </button>
              </div>
            </td>
          </tr>
        `;
      });

      tbody.innerHTML = rowsHtml;
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6" style="color: var(--rose-400);">Error al cargar keys: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // Reset HWID with 1-Click
  async function resetHwid(key) {
    if (!key) return;
    try {
      await apiRequest("/api/admin/keys/reset-hwid", {
        method: "POST",
        body: JSON.stringify({ key })
      });

      showToast("¡HWID liberado correctamente (UNSET)! El usuario ya puede vincular su nuevo dispositivo.", "success");
      loadKeys();
    } catch (err) {
      showToast(`Error al resetear HWID: ${err.message}`, "error");
    }
  }

  // Toggle Active / Revoke Key
  async function toggleActiveKey(key, newActiveState) {
    try {
      await apiRequest("/api/admin/keys/toggle-active", {
        method: "POST",
        body: JSON.stringify({ key, active: newActiveState })
      });

      showToast(`Key ${newActiveState ? "reactivada" : "revocada"} con éxito.`, "success");
      loadKeys();
      loadOverview();
    } catch (err) {
      showToast(`Error: ${err.message}`, "error");
    }
  }

  // Delete Key
  async function deleteKey(key) {
    if (!confirm(`¿Seguro que deseas eliminar la key permanentemente?\n\n${key}`)) {
      return;
    }

    try {
      await apiRequest(`/api/admin/keys/${encodeURIComponent(key)}`, {
        method: "DELETE"
      });

      showToast("Key eliminada de la base de datos.", "success");
      loadKeys();
      loadOverview();
    } catch (err) {
      showToast(`Error al eliminar: ${err.message}`, "error");
    }
  }

  // Modals & Key Creation
  function openCreateModal(duration = 24, tier = "24h", note = "") {
    const modal = document.getElementById("modal-create-key");
    if (!modal) return;

    document.getElementById("modal-create-duration").value = duration;
    document.getElementById("modal-create-tier").value = tier;
    document.getElementById("modal-create-note").value = note;
    document.getElementById("modal-create-count").value = 1;

    modal.classList.remove("hidden");
  }

  function openExtendModal(key) {
    const modal = document.getElementById("modal-extend-key");
    if (!modal) return;

    document.getElementById("modal-extend-key-id").value = key;
    document.getElementById("modal-extend-key-display").textContent = key;
    modal.classList.remove("hidden");
  }

  function closeModals() {
    document.getElementById("modal-create-key")?.classList.add("hidden");
    document.getElementById("modal-extend-key")?.classList.add("hidden");
  }

  async function handleCreateKeySubmit(e) {
    e.preventDefault();
    const duration = document.getElementById("modal-create-duration").value;
    const tier = document.getElementById("modal-create-tier").value;
    const note = document.getElementById("modal-create-note").value.trim();
    const count = parseInt(document.getElementById("modal-create-count").value || "1", 10);
    const btn = document.getElementById("btn-submit-create");

    btn.disabled = true;

    try {
      const res = await apiRequest("/api/admin/keys/create", {
        method: "POST",
        body: JSON.stringify({
          durationHours: duration === "-1" ? -1 : parseFloat(duration),
          tier,
          note,
          count
        })
      });

      closeModals();
      showToast(`¡Se han generado ${res.count || 1} key(s) exitosamente!`, "success");
      loadKeys();
      loadOverview();
    } catch (err) {
      showToast(`Error al generar key: ${err.message}`, "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function handleExtendKeySubmit(e) {
    e.preventDefault();
    const key = document.getElementById("modal-extend-key-id").value;
    const choice = document.getElementById("modal-extend-hours").value;

    try {
      await apiRequest("/api/admin/keys/extend", {
        method: "POST",
        body: JSON.stringify({
          key,
          makePermanent: choice === "perm",
          addHours: choice !== "perm" ? parseFloat(choice) : 0
        })
      });

      closeModals();
      showToast("¡Vigencia de la key extendida correctamente!", "success");
      loadKeys();
    } catch (err) {
      showToast(`Error al extender: ${err.message}`, "error");
    }
  }

  // Load Executor Analytics
  async function loadExecutors(range = "all") {
    executorRange = range;
    const chartBox = document.getElementById("executors-visual-chart");
    const tbody = document.getElementById("tbody-executors-detail");

    document.querySelectorAll(".time-filter-pills .pill-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.range === range);
    });

    if (!chartBox || !tbody) return;

    try {
      const data = await apiRequest(`/api/admin/stats/executors?range=${range}`);
      const executors = data.executors || [];
      const totalExecs = data.totalExecutions || 0;

      if (executors.length === 0) {
        chartBox.innerHTML = `<div class="loading-state">No hay ejecuciones registradas en este período.</div>`;
        tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6" style="color: var(--text-tertiary);">Sin datos disponibles.</td></tr>`;
        return;
      }

      // Render Visual Bars
      let chartHtml = "";
      executors.forEach((item, idx) => {
        const colorClass = EXECUTOR_COLORS[idx % EXECUTOR_COLORS.length];
        chartHtml += `
          <div class="chart-bar-row">
            <div class="chart-bar-info">
              <span class="chart-bar-label">
                <strong style="color: var(--cyan-400);">${idx + 1}.</strong>
                ${escapeHtml(item.executor)}
              </span>
              <span class="chart-bar-count">${item.count.toLocaleString()} (${item.percentage}%)</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill ${colorClass}" style="width: ${item.percentage}%"></div>
            </div>
          </div>
        `;
      });
      chartBox.innerHTML = chartHtml;

      // Render Detail Table
      let tableHtml = "";
      executors.forEach(item => {
        tableHtml += `
          <tr>
            <td>
              <strong style="color: #fff; font-size: 0.9rem;">${escapeHtml(item.executor)}</strong>
            </td>
            <td>
              <span class="font-mono text-cyan">${item.count.toLocaleString()} cargas</span>
            </td>
            <td>
              <span class="badge badge-tier">${item.percentage}%</span>
            </td>
            <td>
              <span style="color: var(--text-secondary); font-size: 0.78rem;">${formatDate(item.last_seen)}</span>
            </td>
          </tr>
        `;
      });
      tbody.innerHTML = tableHtml;
    } catch (err) {
      console.error("[-] Error loading executors:", err);
    }
  }

  // Load Recent Logs Feed
  async function loadLogs() {
    const tbody = document.getElementById("tbody-logs");
    if (!tbody) return;

    try {
      const data = await apiRequest("/api/admin/stats/recent-logs?limit=50");
      const logs = data.logs || [];

      if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6" style="color: var(--text-tertiary);">No hay registros de eventos todavía.</td></tr>`;
        return;
      }

      let rowsHtml = "";
      logs.forEach(log => {
        let statusBadge = `<span class="badge badge-active">Éxito</span>`;
        if (log.status === "expired") {
          statusBadge = `<span class="badge badge-expired">Key Expirada</span>`;
        } else if (log.status === "hwid_mismatch") {
          statusBadge = `<span class="badge badge-revoked">HWID Mismatch</span>`;
        } else if (log.status === "invalid_key") {
          statusBadge = `<span class="badge badge-revoked">Key Inválida</span>`;
        } else if (log.status === "missing_key") {
          statusBadge = `<span class="badge badge-revoked">Sin Key</span>`;
        } else if (log.status === "deactivated") {
          statusBadge = `<span class="badge badge-revoked">Desactivada</span>`;
        } else if (log.status === "maintenance") {
          statusBadge = `<span class="badge badge-expired">Mantenimiento</span>`;
        }

        const shortKey = log.key.length > 20 ? `${log.key.substring(0, 10)}...` : log.key;
        const shortHwid = log.hwid.length > 16 ? `${log.hwid.substring(0, 8)}...` : log.hwid;

        rowsHtml += `
          <tr>
            <td>
              <span style="color: var(--text-secondary); font-size: 0.78rem; font-family: var(--font-mono);">
                ${formatTimeAgo(log.created_at)}
              </span>
            </td>
            <td>
              ${formatKeyPill(log.key)}
            </td>
            <td>
              <strong style="color: #fff;">${escapeHtml(log.executor)}</strong>
            </td>
            <td>
              <span class="font-mono" style="color: var(--text-tertiary); font-size: 0.75rem;" title="${escapeHtml(log.hwid)}">${escapeHtml(shortHwid)}</span>
            </td>
            <td>
              <span class="font-mono" style="color: var(--text-muted); font-size: 0.75rem;">${escapeHtml(log.ip)}</span>
            </td>
            <td>${statusBadge}</td>
          </tr>
        `;
      });

      tbody.innerHTML = rowsHtml;
    } catch (err) {
      console.error("[-] Error loading logs:", err);
    }
  }

  // Maintenance Toggle
  async function toggleMaintenance() {
    const newState = !isMaintenance;
    try {
      const res = await apiRequest("/api/admin/maintenance", {
        method: "POST",
        body: JSON.stringify({ maintenance: newState })
      });

      isMaintenance = !!res.maintenance;
      updateMaintenanceUI(isMaintenance);
      showToast(`Modo Mantenimiento ${isMaintenance ? "ACTIVADO (Scripts pausados)" : "DESACTIVADO (Scripts activos)"}`, isMaintenance ? "error" : "success");
      loadOverview();
    } catch (err) {
      showToast(`Error al cambiar mantenimiento: ${err.message}`, "error");
    }
  }

  function updateMaintenanceUI(active) {
    const btn = document.getElementById("btn-toggle-maintenance");
    const badge = document.getElementById("maint-status-badge");
    if (btn) btn.dataset.active = active ? "true" : "false";
    if (badge) {
      badge.textContent = active ? "ACTIVO" : "OFF";
      badge.className = `badge-maint ${active ? "on" : "off"}`;
    }
  }

  // Clipboard Helpers
  function copyText(text) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      showToast("Key copiada al portapapeles.", "info");
    });
  }

  function copyLoaderWithKey(key) {
    const baseUrl = window.location.origin;
    const loaderCode = `getgenv().Key = "${key}"\nloadstring(game:HttpGet("${baseUrl}/loader"))()`;
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(loaderCode).then(() => {
      showToast("¡Script loader de Roblox copiado al portapapeles listo para usar!", "success");
    });
  }

  // Auto-refresh control
  function startAutoRefresh() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = setInterval(() => {
      if (!isAutoRefreshOn) return;
      if (activeTab === "tab-overview") loadOverview();
      if (activeTab === "tab-logs") loadLogs();
    }, 10000);
  }

  function toggleAutoRefresh() {
    isAutoRefreshOn = !isAutoRefreshOn;
    const btn = document.getElementById("btn-toggle-autorefresh");
    if (btn) {
      btn.classList.toggle("active-mode", isAutoRefreshOn);
      btn.innerHTML = `<span class="live-dot" style="${isAutoRefreshOn ? '' : 'background: #64748b; box-shadow: none;'}"></span> Auto-refresh: ${isAutoRefreshOn ? 'ON (10s)' : 'PAUSADO'}`;
    }
  }

  function loadAllData() {
    loadOverview();
    if (activeTab === "tab-keys") loadKeys();
    if (activeTab === "tab-executors") loadExecutors(executorRange);
    if (activeTab === "tab-logs") loadLogs();
  }

  // Setup Event Listeners
  function setupEvents() {
    // Login form
    document.getElementById("form-login")?.addEventListener("submit", handleLogin);
    document.getElementById("btn-logout")?.addEventListener("click", handleLogout);

    // Password visibility toggle
    document.getElementById("btn-toggle-secret")?.addEventListener("click", () => {
      const input = document.getElementById("input-admin-secret");
      if (input) input.type = input.type === "password" ? "text" : "password";
    });

    // Navigation Tabs
    document.querySelectorAll(".nav-tab").forEach(tab => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });

    // Manual Refresh
    document.getElementById("btn-manual-refresh")?.addEventListener("click", () => {
      showToast("Actualizando datos...", "info");
      loadAllData();
    });

    // Maintenance Toggle
    document.getElementById("btn-toggle-maintenance")?.addEventListener("click", toggleMaintenance);

    // Auto-refresh Toggle in logs
    document.getElementById("btn-toggle-autorefresh")?.addEventListener("click", toggleAutoRefresh);
    document.getElementById("btn-refresh-logs")?.addEventListener("click", () => {
      loadLogs();
      showToast("Logs actualizados.", "info");
    });

    // Keys Filters
    const searchInput = document.getElementById("filter-search");
    const clearSearchBtn = document.getElementById("btn-clear-search");

    searchInput?.addEventListener("input", (e) => {
      clearTimeout(keyState.searchDebounce);
      const val = e.target.value;
      if (clearSearchBtn) clearSearchBtn.classList.toggle("hidden", !val);

      keyState.searchDebounce = setTimeout(() => {
        keyState.search = val.trim();
        keyState.page = 1;
        loadKeys();
      }, 300);
    });

    clearSearchBtn?.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      clearSearchBtn.classList.add("hidden");
      keyState.search = "";
      keyState.page = 1;
      loadKeys();
    });

    document.getElementById("filter-status")?.addEventListener("change", (e) => {
      keyState.status = e.target.value;
      keyState.page = 1;
      loadKeys();
    });

    document.getElementById("filter-tier")?.addEventListener("change", (e) => {
      keyState.tier = e.target.value;
      keyState.page = 1;
      loadKeys();
    });

    // Keys Pagination
    document.getElementById("btn-page-prev")?.addEventListener("click", () => {
      if (keyState.page > 1) {
        keyState.page--;
        loadKeys();
      }
    });

    document.getElementById("btn-page-next")?.addEventListener("click", () => {
      if (keyState.page < keyState.totalPages) {
        keyState.page++;
        loadKeys();
      }
    });

    // Modals
    document.getElementById("form-create-key")?.addEventListener("submit", handleCreateKeySubmit);
    document.getElementById("form-extend-key")?.addEventListener("submit", handleExtendKeySubmit);

    // Executor time range buttons
    document.querySelectorAll(".time-filter-pills .pill-btn").forEach(btn => {
      btn.addEventListener("click", () => loadExecutors(btn.dataset.range));
    });

    // Close modals on Escape key or backdrop click
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModals();
    });

    document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) closeModals();
      });
    });
  }

  // Initialize
  function init() {
    setupEvents();
    initAuth();
  }

  // Public exports
  return {
    init,
    switchTab,
    resetHwid,
    toggleActiveKey,
    deleteKey,
    openCreateModal,
    openExtendModal,
    closeModals,
    copyText,
    copyLoaderWithKey
  };
})();

// Start application when DOM is ready
document.addEventListener("DOMContentLoaded", AdminApp.init);
