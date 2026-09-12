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
        showToast("Session expired. Please enter your secret key again.", "error");
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
    if (!isoStr) return "Never";
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return "Invalid";
      const now = Date.now();
      const diffMs = d.getTime() - now;

      // If permanent (>10 years)
      if (diffMs > 10 * 365 * 24 * 3600 * 1000) {
        return "Permanent (Lifetime)";
      }

      return d.toLocaleDateString("en-US", {
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
    if (!timestamp) return "Never";
    const now = Date.now();
    const diffSec = Math.floor((now - timestamp) / 1000);

    if (diffSec < 10) return "Just now";
    if (diffSec < 60) return `${diffSec}s ago`;
    const min = Math.floor(diffSec / 60);
    if (min < 60) return `${min}m ago`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
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
      showToast("Admin console unlocked!", "success");
      loadAllData();
      startAutoRefresh();
    } catch (err) {
      errorBox.textContent = err.message || "Invalid master secret key.";
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
    showToast("Signed out.", "info");
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

      document.getElementById("kpi-keys-sub").textContent = `${kpi.activeKeys || 0} active, ${(kpi.totalKeys || 0) - (kpi.activeKeys || 0)} expired`;

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
          No executions recorded yet.<br>
          <small style="color: var(--text-tertiary);">They will appear here as soon as players execute the script.</small>
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
            <span class="ranking-executor-stats">${item.count.toLocaleString()} loads (${pct}%)</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill ${colorClass}" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    });

    listEl.innerHTML = html;
  }

  // Key Pill Formatter (Prevents vertical breaking and allows 1-click copy)
  function formatKeyPill(key) {
    if (!key || key === "NONE") return `<span style="color: var(--text-muted);">—</span>`;
    const display = key.length > 24 
      ? `${key.substring(0, 10)}...${key.substring(key.length - 8)}` 
      : key;
    return `
      <div class="key-pill-wrap" title="Key: ${escapeHtml(key)} (Click to copy)" onclick="AdminApp.copyText('${escapeHtml(key)}')">
        <span style="font-size: 0.8rem;">🔑</span>
        <code class="key-pill-code">${escapeHtml(display)}</code>
        <span class="key-copy-hint">Copy</span>
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
      document.getElementById("pagination-info").textContent = `Showing ${keys.length} of ${pagination.total || 0} keys (Page ${pagination.page} of ${keyState.totalPages})`;
      document.getElementById("page-current-number").textContent = pagination.page;
      document.getElementById("btn-page-prev").disabled = pagination.page <= 1;
      document.getElementById("btn-page-next").disabled = pagination.page >= keyState.totalPages;

      if (keys.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6" style="color: var(--text-tertiary);">No keys found matching the selected filters.</td></tr>`;
        return;
      }

      let rowsHtml = "";
      keys.forEach(k => {
        const isPerm = ["permanent", "lifetime", "admin"].includes(k.tier.toLowerCase());
        const isBound = k.hwid && k.hwid !== "UNSET" && k.hwid !== "UNBOUND";

        // Status badge
        let statusBadge = `<span class="badge badge-active">Active</span>`;
        if (k.status === "revoked") {
          statusBadge = `<span class="badge badge-revoked">Revoked</span>`;
        } else if (k.status === "expired") {
          statusBadge = `<span class="badge badge-expired">Expired</span>`;
        }

        // HWID badge
        let hwidBadge = `<span class="badge badge-unset">UNSET (Free)</span>`;
        if (isBound) {
          const shortHwid = k.hwid.length > 18 ? `${k.hwid.substring(0, 8)}...${k.hwid.substring(k.hwid.length - 6)}` : k.hwid;
          hwidBadge = `
            <span class="badge badge-bound" title="${escapeHtml(k.hwid)} (Click to copy)" style="cursor: pointer;" onclick="AdminApp.copyText('${escapeHtml(k.hwid)}')">
              🔒 ${escapeHtml(shortHwid)}
            </span>
          `;
        }

        // Tier badge
        const tierBadge = `<span class="badge badge-tier">${escapeHtml(k.tier)}</span>`;

        // Remaining / Expiry String
        let expiryText = formatDate(k.expires_at);
        if (isPerm) expiryText = "Lifetime";

        rowsHtml += `
          <tr>
            <td>
              ${formatKeyPill(k.key)}
            </td>
            <td>
              <div style="display: flex; flex-direction: column; gap: 3px;">
                ${k.discord_tag ? `
                  <span style="font-size: 0.82rem; font-weight: 700; color: #818cf8; display: inline-flex; align-items: center; gap: 5px;" title="Discord ID: ${escapeHtml(k.discord_id || '')}">
                    <svg width="13" height="13" fill="currentColor" viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
                    ${escapeHtml(k.discord_tag)}
                  </span>
                ` : ''}
                <span style="font-size: 0.82rem; color: ${k.note ? '#cbd5e1' : 'var(--text-muted)'}">
                  ${escapeHtml(k.note || (!k.discord_tag ? "—" : ""))}
                </span>
              </div>
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
                  title="Reset device HWID so the user can bind a new machine"
                  onclick="AdminApp.resetHwid('${escapeHtml(k.key)}')"
                >
                  🔄 Reset HWID
                </button>

                <!-- Extend -->
                <button 
                  class="btn-action btn-action-extend" 
                  title="Add time to this key"
                  onclick="AdminApp.openExtendModal('${escapeHtml(k.key)}')"
                >
                  + Extend
                </button>

                <!-- Toggle Active -->
                <button 
                  class="btn-action btn-action-toggle" 
                  title="${k.active ? 'Revoke key' : 'Reactivate key'}"
                  onclick="AdminApp.toggleActiveKey('${escapeHtml(k.key)}', ${!k.active})"
                >
                  ${k.active ? 'Deactivate' : 'Activate'}
                </button>

                <!-- Copy Roblox Script Loader -->
                <button 
                  class="btn-action btn-action-toggle" 
                  title="Copy ready-to-run Roblox loader snippet with this key"
                  onclick="AdminApp.copyLoaderWithKey('${escapeHtml(k.key)}')"
                >
                  📜 Loader
                </button>

                <!-- Delete -->
                <button 
                  class="btn-action btn-action-delete" 
                  title="Permanently delete key"
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
      tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6" style="color: var(--rose-400);">Error loading keys: ${escapeHtml(err.message)}</td></tr>`;
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

      showToast("HWID unbound successfully (UNSET)! User can now bind a new machine.", "success");
      loadKeys();
    } catch (err) {
      showToast(`Error resetting HWID: ${err.message}`, "error");
    }
  }

  // Toggle Active / Revoke Key
  async function toggleActiveKey(key, newActiveState) {
    try {
      await apiRequest("/api/admin/keys/toggle-active", {
        method: "POST",
        body: JSON.stringify({ key, active: newActiveState })
      });

      showToast(`Key ${newActiveState ? "reactivated" : "revoked"} successfully.`, "success");
      loadKeys();
      loadOverview();
    } catch (err) {
      showToast(`Error: ${err.message}`, "error");
    }
  }

  // Delete Key
  async function deleteKey(key) {
    if (!confirm(`Are you sure you want to permanently delete this key?\n\n${key}`)) {
      return;
    }

    try {
      await apiRequest(`/api/admin/keys/${encodeURIComponent(key)}`, {
        method: "DELETE"
      });

      showToast("Key deleted from database.", "success");
      loadKeys();
      loadOverview();
    } catch (err) {
      showToast(`Error deleting key: ${err.message}`, "error");
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
      showToast(`Successfully generated ${res.count || 1} key(s)!`, "success");
      loadKeys();
      loadOverview();
    } catch (err) {
      showToast(`Error generating key: ${err.message}`, "error");
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
      showToast("Key duration extended successfully!", "success");
      loadKeys();
    } catch (err) {
      showToast(`Error extending key: ${err.message}`, "error");
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
        chartBox.innerHTML = `<div class="loading-state">No executions recorded in this time period.</div>`;
        tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6" style="color: var(--text-tertiary);">No data available.</td></tr>`;
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
              <span class="font-mono text-cyan">${item.count.toLocaleString()} loads</span>
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
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6" style="color: var(--text-tertiary);">No execution events recorded yet.</td></tr>`;
        return;
      }

      let rowsHtml = "";
      logs.forEach(log => {
        let statusBadge = `<span class="badge badge-active">Success</span>`;
        if (log.status === "expired") {
          statusBadge = `<span class="badge badge-expired">Expired Key</span>`;
        } else if (log.status === "hwid_mismatch") {
          statusBadge = `<span class="badge badge-revoked">HWID Mismatch</span>`;
        } else if (log.status === "invalid_key") {
          statusBadge = `<span class="badge badge-revoked">Invalid Key</span>`;
        } else if (log.status === "missing_key") {
          statusBadge = `<span class="badge badge-revoked">Missing Key</span>`;
        } else if (log.status === "deactivated") {
          statusBadge = `<span class="badge badge-revoked">Deactivated</span>`;
        } else if (log.status === "maintenance") {
          statusBadge = `<span class="badge badge-expired">Maintenance</span>`;
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
      showToast(`Maintenance mode ${isMaintenance ? "ENABLED (Scripts paused)" : "DISABLED (Scripts active)"}`, isMaintenance ? "error" : "success");
      loadOverview();
    } catch (err) {
      showToast(`Error toggling maintenance: ${err.message}`, "error");
    }
  }

  function updateMaintenanceUI(active) {
    const btn = document.getElementById("btn-toggle-maintenance");
    const badge = document.getElementById("maint-status-badge");
    if (btn) btn.dataset.active = active ? "true" : "false";
    if (badge) {
      badge.textContent = active ? "ACTIVE" : "OFF";
      badge.className = `badge-maint ${active ? "on" : "off"}`;
    }
  }

  // Clipboard Helpers
  function copyText(text) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      showToast("Key copied to clipboard.", "info");
    });
  }

  function copyLoaderWithKey(key) {
    const origin = window.location.origin;
    const baseUrl = (origin.includes("localhost") || origin.includes("127.0.0.1")) ? origin : "https://fruitshub.onrender.com";
    const loaderCode = `getgenv().Webhook = "YOUR_DISCORD_WEBHOOK" -- (Optional)\nloadstring(game:HttpGet("${baseUrl}/loader"))()`;
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(loaderCode).then(() => {
      showToast("Roblox loader snippet copied to clipboard!", "success");
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
      btn.innerHTML = `<span class="live-dot" style="${isAutoRefreshOn ? '' : 'background: #64748b; box-shadow: none;'}"></span> Auto-refresh: ${isAutoRefreshOn ? 'ON (10s)' : 'PAUSED'}`;
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
      const btn = document.getElementById("btn-toggle-secret");
      if (input) {
        const isPassword = input.type === "password";
        input.type = isPassword ? "text" : "password";
        if (btn) btn.textContent = isPassword ? "🙈" : "👁️";
      }
    });

    // Navigation Tabs
    document.querySelectorAll(".nav-tab").forEach(tab => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });

    // Manual Refresh
    document.getElementById("btn-manual-refresh")?.addEventListener("click", () => {
      showToast("Refreshing data...", "info");
      loadAllData();
    });

    // Maintenance Toggle
    document.getElementById("btn-toggle-maintenance")?.addEventListener("click", toggleMaintenance);

    // Auto-refresh Toggle in logs
    document.getElementById("btn-toggle-autorefresh")?.addEventListener("click", toggleAutoRefresh);
    document.getElementById("btn-refresh-logs")?.addEventListener("click", () => {
      loadLogs();
      showToast("Logs refreshed.", "info");
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
