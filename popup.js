document.addEventListener("DOMContentLoaded", async () => {
    const listContainer = document.getElementById("history-list");
    const toggleSearchBtn = document.getElementById("toggle-search-btn");
    const deleteAllBtn = document.getElementById("delete-all-btn");
    const searchBar = document.getElementById("search-bar");
    const searchInput = document.getElementById("search-input");
    const searchClearIcon = document.getElementById("search-clear-icon");
    const moreActionsBtn = document.getElementById("more-actions-btn");
    const moreActionsMenu = document.getElementById("more-actions-menu");
    const p21FabToggleBtn = document.getElementById("p21-fab-toggle-btn");
    const p21FabStatus = document.getElementById("p21-fab-status");
    const p21FabResetBtn = document.getElementById("p21-fab-reset-btn");
    // Quick Ship connection mapping controls.
    const quickShipConnectionsBtn = document.getElementById("quick-ship-connections-btn");
    const connectionsModal = document.getElementById("connections-modal");
    const connectionsListView = document.getElementById("connections-list-view");
    const connectionsList = document.getElementById("connections-list");
    const connectionForm = document.getElementById("connection-form");
    const connectionFormTitle = document.getElementById("connection-form-title");
    const configuredBaseInput = document.getElementById("configured-base-input");
    const accessibleBaseInput = document.getElementById("accessible-base-input");
    const connectionsStatus = document.getElementById("connections-status");
    const connectionsAddBtn = document.getElementById("connections-add-btn");
    const connectionsCloseBtn = document.getElementById("connections-close-btn");
    const connectionBackBtn = document.getElementById("connection-back-btn");
    const connectionCancelBtn = document.getElementById("connection-cancel-btn");
    const connectionsSaveBtn = document.getElementById("connections-save-btn");
    let editingConfiguredBase = null;
    let fullHistory = [];

    // --- Pause/Play Functionality ---
    const pauseBtn = document.createElement("button");
    pauseBtn.id = "pause-btn";
    // Basic styling to match typical icon buttons
    pauseBtn.className = "icon-btn";
    pauseBtn.style.marginRight = "2px";

    // Insert before the search button
    if (toggleSearchBtn && toggleSearchBtn.parentNode) {
        toggleSearchBtn.parentNode.insertBefore(pauseBtn, toggleSearchBtn);
    }

    // --- Clipboard Button ---
    const pasteBtn = document.createElement("button");
    pasteBtn.id = "paste-btn";
    pasteBtn.className = "icon-btn";
    pasteBtn.style.marginRight = "2px";
    pasteBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>`;
    pasteBtn.title = "Paste from Clipboard";

    // Insert before pause button
    if (pauseBtn && pauseBtn.parentNode) {
        pauseBtn.parentNode.insertBefore(pasteBtn, pauseBtn);
    }

    pasteBtn.addEventListener("click", async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (!text) {
                showErrorModal("Clipboard is empty or permission denied.");
                return;
            }
            pasteBtn.style.opacity = "0.5"; // Visual feedback
            chrome.runtime.sendMessage({ type: "analyzeText", text: text });
        } catch (err) {
            console.error("Clipboard read failed:", err);
            showErrorModal(err.message || "Failed to read clipboard.");
        }
    });

    function updatePauseUI(isPaused) {
        const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24" fill="#fff"><path d="M560-200v-560h160v560H560Zm-320 0v-560h160v560H240Z"/></svg>`;
        const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24" fill="#fff"><path d="M320-200v-560l440 280-440 280Z"/></svg>`;
        
        pauseBtn.innerHTML = isPaused ? playIcon : pauseIcon;
        pauseBtn.title = isPaused ? "Resume Label Generation" : "Pause Label Generation";
    }

    // Initialize State
    const initialSettings = await chrome.storage.local.get("isPaused");
    updatePauseUI(initialSettings.isPaused);

    pauseBtn.addEventListener("click", async () => {
        const settings = await chrome.storage.local.get("isPaused");
        const newState = !settings.isPaused;
        await chrome.storage.local.set({ isPaused: newState });
        updatePauseUI(newState);
    });

    // --- Debounce Utility ---
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }


    // --- P21 FAB Popup Controls ---
    function closeMoreActionsMenu() {
        if (!moreActionsMenu || !moreActionsBtn) return;
        moreActionsMenu.classList.remove("active");
        moreActionsBtn.setAttribute("aria-expanded", "false");
    }
    function toggleMoreActionsMenu() {
        if (!moreActionsMenu || !moreActionsBtn) return;
        const isActive = moreActionsMenu.classList.toggle("active");
        moreActionsBtn.setAttribute("aria-expanded", String(isActive));
    }
    async function updateP21FabMenuUI() {
        if (!p21FabToggleBtn) return;
        const settings = await chrome.storage.local.get("p21FabHidden");
        const hidden = Boolean(settings.p21FabHidden);
        const label = p21FabToggleBtn.querySelector("span:first-child");
        if (label) label.textContent = hidden ? "Show P21 Button" : "Hide P21 Button";
        if (p21FabStatus) p21FabStatus.textContent = hidden ? "Hidden" : "Visible";
    }
    if (moreActionsBtn) {
        moreActionsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleMoreActionsMenu();
        });
    }
    document.addEventListener("click", (e) => {
        if (!moreActionsMenu || !moreActionsBtn) return;
        if (!moreActionsMenu.contains(e.target) && !moreActionsBtn.contains(e.target)) closeMoreActionsMenu();
    });
    if (p21FabToggleBtn) {
        p21FabToggleBtn.addEventListener("click", async () => {
            const settings = await chrome.storage.local.get("p21FabHidden");
            await chrome.storage.local.set({ p21FabHidden: !settings.p21FabHidden });
            await updateP21FabMenuUI();
            closeMoreActionsMenu();
        });
    }
    if (p21FabResetBtn) {
        p21FabResetBtn.addEventListener("click", async () => {
            await chrome.storage.local.remove("qsP21FabPosition");
            await chrome.storage.local.set({ p21FabHidden: false });
            await updateP21FabMenuUI();
            closeMoreActionsMenu();
        });
    }
    updateP21FabMenuUI();

    // --- Quick Ship Connections ---
    const QUICK_SHIP_OVERRIDE_STORAGE_KEY = "quickShipBaseOverrides";
    const QUICK_SHIP_TEST_STATE_STORAGE_KEY = "quickShipConnectionTestStates";
    const connectionIcons = {
        server: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M8 6.5h.01M8 17.5h.01M12 10v4"/></svg>',
        monitor: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="16" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
        link: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/></svg>',
        chevron: '<svg class="connection-chevron" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>',
        test: '<svg width="16" height="16" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M320 146c-19-8-41-12-64-12a160 160 0 1 0 160 160"/><polyline points="256 58 336 138 256 218"/></svg>',
        edit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
        remove: '<svg viewBox="0 0 24 24" fill="currentColor" ><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
    };

    function normalizePopupBase(value) {
        const raw = String(value || "").trim();
        if (!raw) return "";
        const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
        try {
            const parsed = new URL(withProtocol);
            const markerIndex = parsed.pathname.toLowerCase().indexOf("/epicorfreightservice.svc");
            const basePath = markerIndex >= 0 ? parsed.pathname.slice(0, markerIndex) : parsed.pathname;
            return `${parsed.origin}${basePath}`.replace(/\/$/, "");
        } catch { return withProtocol.replace(/\/$/, ""); }
    }

    function quickShipPopupOverrideKey(value) {
        return normalizePopupBase(value).toLowerCase();
    }
    function getConnectionName(configured) {
        try { return new URL(configured).hostname || configured; }
        catch { return configured.replace(/^https?:\/\//i, "").split(/[/:]/)[0] || configured; }
    }

    function makeIconButton(icon, label, className = "") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `connection-icon-btn ${className}`.trim();
        button.innerHTML = icon;
        button.title = label;
        button.setAttribute("aria-label", label);
        return button;
    }

    async function getConnectionMappings() {
        const stored = await chrome.storage.local.get(QUICK_SHIP_OVERRIDE_STORAGE_KEY);
        return { ...(stored[QUICK_SHIP_OVERRIDE_STORAGE_KEY] || {}) };
    }

    async function getConnectionTestStates() {
        const stored = await chrome.storage.local.get(QUICK_SHIP_TEST_STATE_STORAGE_KEY);
        return { ...(stored[QUICK_SHIP_TEST_STATE_STORAGE_KEY] || {}) };
    }

    async function saveConnectionTestState(configured, state, message = "") {
        const key = quickShipPopupOverrideKey(configured);
        const states = await getConnectionTestStates();
        states[key] = {
            state,
            message,
            testedAt: Date.now()
        };
        await chrome.storage.local.set({ [QUICK_SHIP_TEST_STATE_STORAGE_KEY]: states });
        return states[key];
    }

    function formatConnectionTestState(testState) {
        if (!testState || !testState.testedAt) return "Not tested";
        const tested = new Date(testState.testedAt);
        if (Number.isNaN(tested.getTime())) return testState.message || "Not tested";
        const dateText = tested.toLocaleDateString([], { month: "short", day: "numeric" });
        const timeText = tested.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        if (testState.state === "connected") return `Connected · ${dateText} at ${timeText}`;
        return testState.message ? `Failed · ${dateText} at ${timeText}` : `Test failed · ${dateText} at ${timeText}`;
    }

    async function renderConnectionMappings(openConfigured = null) {
        if (!connectionsList) return;
        const [mappings, testStates] = await Promise.all([
            getConnectionMappings(),
            getConnectionTestStates()
        ]);
        connectionsList.replaceChildren();
        const entries = Object.entries(mappings);
        if (!entries.length) {
            const empty = document.createElement("div");
            empty.className = "connection-empty";
            empty.textContent = "No Quick Ship mappings yet.";
            connectionsList.appendChild(empty);
            return;
        }

        entries.sort(([a], [b]) => a.localeCompare(b));
        for (const [configured, effective] of entries) {
            const configuredKey = quickShipPopupOverrideKey(configured);
            const card = document.createElement("article");
            card.className = "connection-card";
            if (configured === openConfigured) card.classList.add("open");

            const summary = document.createElement("button");
            summary.type = "button";
            summary.className = "connection-summary";
            summary.setAttribute("aria-expanded", String(configured === openConfigured));

            const serverIcon = document.createElement("span");
            serverIcon.className = "connection-server-icon";
            serverIcon.innerHTML = connectionIcons.server;

            const summaryCopy = document.createElement("span");
            summaryCopy.className = "connection-summary-copy";
            const title = document.createElement("span");
            title.className = "connection-title";
            title.textContent = getConnectionName(configured);
            const subtitle = document.createElement("span");
            subtitle.className = "connection-subtitle";
            subtitle.textContent = configured;
            summaryCopy.append(title, subtitle);

            const summaryActions = document.createElement("span");
            summaryActions.className = "connection-summary-actions";
            const statusDot = document.createElement("span");
            const savedTestState = testStates[configuredKey];
            statusDot.className = "connection-status-dot";
            if (savedTestState?.state === "connected") statusDot.classList.add("connected");
            if (savedTestState?.state === "failed") statusDot.classList.add("failed");
            statusDot.title = savedTestState?.state === "connected"
                ? "Last test succeeded"
                : savedTestState?.state === "failed" ? "Last test failed" : "Not tested";
            const chevron = document.createElement("span");
            chevron.innerHTML = connectionIcons.chevron;
            summaryActions.append(statusDot, chevron);
            summary.append(serverIcon, summaryCopy, summaryActions);

            const details = document.createElement("div");
            details.className = "connection-details";
            const detailsInner = document.createElement("div");
            detailsInner.className = "connection-details-inner";
            const content = document.createElement("div");
            content.className = "connection-details-content";
            const route = document.createElement("div");
            route.className = "connection-route";

            function appendRoute(icon, labelText, addressText) {
                const node = document.createElement("span");
                node.className = "connection-route-node";
                node.innerHTML = icon;
                const copy = document.createElement("span");
                copy.className = "connection-route-copy";
                const label = document.createElement("span");
                label.className = "connection-route-label";
                label.textContent = labelText;
                const address = document.createElement("span");
                address.className = "connection-route-address";
                address.textContent = addressText;
                address.title = addressText;
                copy.append(label, address);
                route.append(node, copy);
            }

            appendRoute(connectionIcons.monitor, "Quick Ship Website", configured);
            const routeLine = document.createElement("span");
            routeLine.className = "connection-route-line";
            route.append(routeLine, document.createElement("span"));
            appendRoute(connectionIcons.link, "Browser-accessible IP Address", effective);

            const footer = document.createElement("div");
            footer.className = "connection-card-footer";
            const testStatus = document.createElement("span");
            testStatus.className = "connection-test-status";
            testStatus.textContent = formatConnectionTestState(savedTestState);
            if (savedTestState?.message) testStatus.title = savedTestState.message;
            const actions = document.createElement("span");
            actions.className = "connection-icon-actions";
            const testBtn = makeIconButton(connectionIcons.test, "Test connection");
            const editBtn = makeIconButton(connectionIcons.edit, "Edit mapping");
            const removeBtn = makeIconButton(connectionIcons.remove, "Remove mapping", "danger");
            actions.append(testBtn, editBtn, removeBtn);
            footer.append(testStatus, actions);
            content.append(route, footer);
            detailsInner.appendChild(content);
            details.appendChild(detailsInner);
            card.append(summary, details);
            connectionsList.appendChild(card);

            summary.addEventListener("click", () => {
                const willOpen = !card.classList.contains("open");
                card.classList.toggle("open", willOpen);
                summary.setAttribute("aria-expanded", String(willOpen));
            });

            testBtn.addEventListener("click", () => {
                testBtn.disabled = true;
                testStatus.textContent = "Testing…";
                statusDot.className = "connection-status-dot";
                chrome.runtime.sendMessage({ type: "saveQuickShipBaseOverride", configuredBase: configured, candidateBase: effective }, async result => {
                    testBtn.disabled = false;
                    if (chrome.runtime.lastError || !result || !result.success) {
                        const errorMessage = (result && result.error) || chrome.runtime.lastError?.message || "Connection test failed.";
                        const savedState = await saveConnectionTestState(configured, "failed", errorMessage);
                        statusDot.className = "connection-status-dot failed";
                        statusDot.title = "Last test failed";
                        testStatus.textContent = formatConnectionTestState(savedState);
                        testStatus.title = errorMessage;
                        return;
                    }
                    const savedState = await saveConnectionTestState(configured, "connected");
                    statusDot.className = "connection-status-dot connected";
                    statusDot.title = "Last test succeeded";
                    testStatus.textContent = formatConnectionTestState(savedState);
                    testStatus.removeAttribute("title");
                });
            });

            editBtn.addEventListener("click", () => showConnectionForm(configured, effective));
            removeBtn.addEventListener("click", async () => {
                const [latest, testStates] = await Promise.all([
                    getConnectionMappings(),
                    getConnectionTestStates()
                ]);
                delete latest[configuredKey];
                delete testStates[configuredKey];
                await chrome.storage.local.set({
                    [QUICK_SHIP_OVERRIDE_STORAGE_KEY]: latest,
                    [QUICK_SHIP_TEST_STATE_STORAGE_KEY]: testStates
                });
                await renderConnectionMappings();
            });
        }
    }

    function showConnectionList() {
        editingConfiguredBase = null;
        connectionForm?.classList.remove("active");
        connectionsListView?.classList.remove("hidden");
        connectionsStatus.textContent = "";
        connectionsStatus.className = "connection-status";
    }

    function showConnectionForm(configured = "", effective = "") {
        editingConfiguredBase = configured || null;
        configuredBaseInput.value = configured;
        accessibleBaseInput.value = effective;
        connectionFormTitle.textContent = configured ? "Edit mapping" : "Add mapping";
        connectionsSaveBtn.textContent = configured ? "Test & Save changes" : "Test & Save";
        connectionsStatus.textContent = "";
        connectionsStatus.className = "connection-status";
        connectionsListView?.classList.add("hidden");
        connectionForm?.classList.add("active");
        configuredBaseInput.focus();
    }

    function closeConnectionsModal() {
        connectionsModal?.classList.remove("active");
        showConnectionList();
    }

    quickShipConnectionsBtn?.addEventListener("click", async () => {
        closeMoreActionsMenu();
        showConnectionList();
        await renderConnectionMappings();
        connectionsModal?.classList.add("active");
    });
    connectionsAddBtn?.addEventListener("click", () => showConnectionForm());
    connectionBackBtn?.addEventListener("click", showConnectionList);
    connectionCancelBtn?.addEventListener("click", showConnectionList);
    connectionsCloseBtn?.addEventListener("click", closeConnectionsModal);
    connectionsModal?.addEventListener("click", event => { if (event.target === connectionsModal) closeConnectionsModal(); });

    connectionsSaveBtn?.addEventListener("click", () => {
        const configuredBase = normalizePopupBase(configuredBaseInput.value);
        const candidateBase = normalizePopupBase(accessibleBaseInput.value);
        connectionsStatus.className = "connection-status";
        if (!configuredBase || !candidateBase) {
            connectionsStatus.classList.add("error");
            connectionsStatus.textContent = "Enter both addresses.";
            return;
        }
        connectionsSaveBtn.disabled = true;
        connectionsSaveBtn.textContent = "Testing…";
        connectionsStatus.textContent = "Testing the browser-accessible address…";
        chrome.runtime.sendMessage({ type: "saveQuickShipBaseOverride", configuredBase, candidateBase }, async result => {
            connectionsSaveBtn.disabled = false;
            connectionsSaveBtn.textContent = editingConfiguredBase ? "Test & Save changes" : "Test & Save";
            if (chrome.runtime.lastError || !result || !result.success) {
                connectionsStatus.classList.add("error");
                connectionsStatus.textContent = (result && result.error) || chrome.runtime.lastError?.message || "Connection test failed.";
                return;
            }
            const configuredKey = quickShipPopupOverrideKey(configuredBase);
            const editingKey = editingConfiguredBase
                ? quickShipPopupOverrideKey(editingConfiguredBase)
                : null;
            if (editingKey && editingKey !== configuredKey) {
                const [latest, testStates] = await Promise.all([
                    getConnectionMappings(),
                    getConnectionTestStates()
                ]);
                delete latest[editingKey];
                delete testStates[editingKey];
                latest[configuredKey] = candidateBase;
                await chrome.storage.local.set({
                    [QUICK_SHIP_OVERRIDE_STORAGE_KEY]: latest,
                    [QUICK_SHIP_TEST_STATE_STORAGE_KEY]: testStates
                });
            }
            await saveConnectionTestState(configuredKey, "connected");
            connectionsStatus.classList.add("success");
            connectionsStatus.textContent = "Connected and saved.";
            await renderConnectionMappings(configuredKey);
            setTimeout(showConnectionList, 450);
        });
    });
    // --- Load History ---
    async function loadHistory() {
        try {
            const result = await chrome.storage.local.get("labelHistory");
            fullHistory = result.labelHistory || [];
            renderHistory(fullHistory);
        } catch (err) {
            console.error("Failed to load history:", err);
            listContainer.innerHTML = '<div class="empty-state">Error loading history.</div>';
        }
    }

    loadHistory();

    // --- Event Listeners ---

    // Toggle Search Bar
    toggleSearchBtn.addEventListener("click", () => {
        const isActive = searchBar.classList.contains("active");
        if (isActive) {
            closeSearch();
        } else {
            openSearch();
        }
    });

    function openSearch() {
        searchBar.classList.add("active");
        searchInput.focus();
    }

    function closeSearch() {
        searchBar.classList.remove("active");
        searchInput.value = "";
        searchClearIcon.style.display = "none";
        renderHistory(fullHistory);
    }

    // Search Input Logic
    searchInput.addEventListener("input", (e) => {
        const val = e.target.value;
        searchClearIcon.style.display = val.length > 0 ? "block" : "none";
        
        // Debounced Filter
        performSearch(val);
    });
    
    const performSearch = debounce((query) => {
        query = query.trim(); // Keep original case for display, lower for logic
        
        if (!query) {
            renderHistory(fullHistory);
            return;
        }

        const lowerQuery = query.toLowerCase();
        
        const filtered = fullHistory.filter(item => {
            const packID = String(item.packID || "").toLowerCase();
            const website = String(item.website || "").toLowerCase();
            return packID.includes(lowerQuery) || website.includes(lowerQuery);
        });
        
        renderHistory(filtered, query);
    }, 250);

    // Clear Search Input Icon
    searchClearIcon.addEventListener("click", () => {
        searchInput.value = "";
        searchClearIcon.style.display = "none";
        renderHistory(fullHistory);
        searchInput.focus();
    });

    // Enter Key on Search
    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const firstItem = listContainer.querySelector(".history-item");
            if (firstItem) {
                firstItem.click(); 
            }
        } else if (e.key === "Escape") {
            closeSearch();
        }
    });

    // Delete All History
    const modal = document.getElementById("confirmation-modal");
    const modalCancelBtn = document.getElementById("modal-cancel-btn");
    const modalConfirmBtn = document.getElementById("modal-confirm-btn");

    function closeModal() {
        modal.classList.remove("active");
    }

    modalCancelBtn.addEventListener("click", closeModal);

    // Close modal when clicking outside
    modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal();
    });
    
    // Close on Escape key
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modal.classList.contains("active")) {
            closeModal();
        }
    });

    // --- Error Modal ---
    const errorModal = document.getElementById("error-modal");
    const errorModalTitle = document.getElementById("error-modal-title");
    const errorModalBody = document.getElementById("error-modal-body");
    const errorModalCloseBtn = document.getElementById("error-modal-close-btn");

    function showErrorModal(msg, title = "Error", details = {}) {
        if (errorModalTitle) errorModalTitle.textContent = title || "Error";
        if (errorModalBody) {
            const hint = details && details.hint ? `

Hint: ${details.hint}` : "";
            errorModalBody.textContent = `${msg || "An unknown error occurred."}${hint}`;
        }
        if (errorModal) errorModal.classList.add("active");
    }

    function closeErrorModal() {
        if (errorModal) errorModal.classList.remove("active");
    }

    if (errorModalCloseBtn) {
        errorModalCloseBtn.addEventListener("click", closeErrorModal);
    }

    if (errorModal) {
        errorModal.addEventListener("click", (e) => {
            if (e.target === errorModal) closeErrorModal();
        });
    }

    // Close on Escape key (Updated)
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            if (modal.classList.contains("active")) closeModal();
            if (errorModal && errorModal.classList.contains("active")) closeErrorModal();
            if (connectionsModal && connectionsModal.classList.contains("active")) closeConnectionsModal();
        }
    });

    deleteAllBtn.addEventListener("click", () => {
        closeMoreActionsMenu();
        if (fullHistory.length === 0) return;
        modal.classList.add("active");
    });

    modalConfirmBtn.addEventListener("click", async () => {
        fullHistory = [];
        await chrome.storage.local.set({ labelHistory: [] });
        renderHistory([]);
        closeSearch();
        closeModal();
    });

    // --- Highlighting Helper ---
    function highlightText(text, query) {
        const fragment = document.createDocumentFragment();
        const strText = String(text || "");
        
        if (!query || !text) {
            fragment.textContent = strText;
            return fragment;
        }
        
        // Escape special regex chars in query
        const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${safeQuery})`, 'gi');
        
        const parts = strText.split(regex);
        
        parts.forEach(part => {
            if (part.toLowerCase() === query.toLowerCase()) {
                const mark = document.createElement("mark");
                mark.textContent = part;
                fragment.appendChild(mark);
            } else if (part.length > 0) {
                fragment.appendChild(document.createTextNode(part));
            }
        });
        
        return fragment;
    }

    // --- Render Function ---
    function renderHistory(items, highlightQuery = "") {
        listContainer.innerHTML = "";

        if (!items || items.length === 0) {
            listContainer.innerHTML = '<div class="empty-state">No recent labels found.</div>';
            return;
        }

        items.forEach(item => {
            const el = document.createElement("div");
            el.className = "history-item";
            
            const date = new Date(item.timestamp);
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const dateStr = date.toLocaleDateString();

            // Structure creation
            const infoDiv = document.createElement("div");
            infoDiv.className = "item-info";
            
            const headerRow = document.createElement("div");
            headerRow.className = "header-row";
            
            const packIdSpan = document.createElement("span");
            packIdSpan.className = "pack-id";
            packIdSpan.title = item.packID || "";
            packIdSpan.appendChild(highlightText(item.packID, highlightQuery));
            headerRow.appendChild(packIdSpan);
            
            if (item.website) {
                const websiteSpan = document.createElement("span");
                websiteSpan.className = "website";
                websiteSpan.appendChild(highlightText(item.website, highlightQuery));
                headerRow.appendChild(websiteSpan);
            }
            
            const timestampSpan = document.createElement("span");
            timestampSpan.className = "timestamp";
            timestampSpan.textContent = `${dateStr} at ${timeStr}`;
            
            infoDiv.appendChild(headerRow);
            infoDiv.appendChild(timestampSpan);
            
            const actionsDiv = document.createElement("div");
            actionsDiv.className = "item-actions";
            
            const chevron = document.createElement("div");
            chevron.className = "chevron";
            chevron.textContent = "\u203A"; // &rsaquo;
            
            const deleteBtn = document.createElement("button");
            deleteBtn.className = "delete-btn";
            deleteBtn.title = "Delete";
            deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
            
            actionsDiv.appendChild(chevron);
            actionsDiv.appendChild(deleteBtn);
            
            el.appendChild(infoDiv);
            el.appendChild(actionsDiv);

            // Open Image
            el.addEventListener("click", (e) => {
                if (e.target.closest(".delete-btn")) return;
                openInNewTab(item.images || (item.png ? [item.png] : []), {
                    source: "history",
                    packID: item.packID,
                    website: item.website,
                    timestamp: item.timestamp
                });
            });

            // Delete Individual Item
            deleteBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                
                el.style.opacity = "0.5";
                fullHistory = fullHistory.filter(h => h.timestamp !== item.timestamp);
                await chrome.storage.local.set({ labelHistory: fullHistory });
                
                if (searchInput.value.trim()) {
                   performSearch(searchInput.value);
                } else {
                   renderHistory(fullHistory);
                }
            });

            listContainer.appendChild(el);
        });
    }

    function openInNewTab(items, metadata = {}) {

        if (!items || items.length === 0) return;

        const images = items.map(item => {
            if (item && typeof item === "object") return item;

            const value = String(item || "").trim();
            if (!value) return null;

            return value.startsWith("data:")
                ? value
                : `data:image/png;base64,${value}`;
        }).filter(Boolean);

        if (images.length === 0) return;
        
        chrome.runtime.sendMessage({
            type: "openViewer",
            images,
            metadata: {
                source: "popup",
                ...metadata
            }
        });
    }

    function getPreviewErrorHint(msg = {}) {
        if (msg.hint === "base64-text-manifest") {
            return "This appears to be a carrier manifest or text document. Select the carrier label response containing PDF, image, or ZPL data instead.";
        }
        if (msg.hint === "base64-text") {
            return "The text decoded correctly, but it is not a supported label payload.";
        }
        if (msg.hint === "structured-no-label-field") {
            return "Try selecting the full XML/JSON response that contains a label field such as GraphicImage, LabelImage, labelData, Base64LabelImage, OutputImage, Data, or ZPL data.";
        }
        if (msg.hint === "unsupported-base64") {
            return "The selected text looks encoded, but it was not recognized as PDF, image, or ZPL label data.";
        }
        if (msg.hint === "generic-invalid-selection") {
            return "Highlight the complete carrier XML/JSON response or encoded label data, then try Preview again.";
        }
        return "Select the full label payload and try again.";
    }

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === "labelPreview") {
            pasteBtn.style.opacity = "1";
            if (msg.success) {
                loadHistory(); // Refresh list
                openInNewTab(msg.images, {
                    source: "clipboard"
                });
                if (msg.warning) {
                    showErrorModal(msg.warning, msg.warningTitle || "Preview Partially Completed");
                }
            } else {
                console.error(msg.error);
                const title = msg.title || (msg.isNoData ? "Nothing to Preview" : "Error");
                showErrorModal(
                    msg.error || "Failed to process label.",
                    title,
                    { category: msg.category, hint: getPreviewErrorHint(msg) }
                );
            }
        }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.labelHistory) {
            loadHistory();
        }
        if (area === "local" && changes.p21FabHidden) {
            updateP21FabMenuUI();
        }
    });
});
