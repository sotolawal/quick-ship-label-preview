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
    const errorModalBody = document.getElementById("error-modal-body");
    const errorModalCloseBtn = document.getElementById("error-modal-close-btn");

    function showErrorModal(msg) {
        if (errorModalBody) errorModalBody.textContent = msg;
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
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("[Quick Ship] Failed to open viewer:", chrome.runtime.lastError.message);
                showErrorModal(chrome.runtime.lastError.message || "Failed to open viewer.");
            }
        });
    }
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === "labelPreview") {
            pasteBtn.style.opacity = "1";
            if (msg.success) {
                loadHistory(); // Refresh list
                openInNewTab(msg.images, {
                    source: "clipboard"
                });
            } else {
                console.error(msg.error);
                showErrorModal(msg.error || "Failed to process label.");
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
