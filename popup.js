document.addEventListener("DOMContentLoaded", async () => {
    const listContainer = document.getElementById("history-list");
    const toggleSearchBtn = document.getElementById("toggle-search-btn");
    const deleteAllBtn = document.getElementById("delete-all-btn");
    const searchBar = document.getElementById("search-bar");
    const searchInput = document.getElementById("search-input");
    const searchClearIcon = document.getElementById("search-clear-icon");
    
    let fullHistory = [];

    // --- Pause/Play Functionality ---
    const pauseBtn = document.createElement("button");
    pauseBtn.id = "pause-btn";
    // Basic styling to match typical icon buttons
    pauseBtn.className = "icon-btn";
    pauseBtn.style.marginRight = "8px";

    // Insert before the search button
    if (toggleSearchBtn && toggleSearchBtn.parentNode) {
        toggleSearchBtn.parentNode.insertBefore(pauseBtn, toggleSearchBtn);
    }

    // --- Clipboard Button ---
    const pasteBtn = document.createElement("button");
    pasteBtn.id = "paste-btn";
    pasteBtn.className = "icon-btn";
    pasteBtn.style.marginRight = "8px";
    pasteBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>`;
    pasteBtn.title = "Paste from Clipboard";

    // Insert before pause button
    if (pauseBtn && pauseBtn.parentNode) {
        pauseBtn.parentNode.insertBefore(pasteBtn, pauseBtn);
    }

    pasteBtn.addEventListener("click", async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (!text) return;
            pasteBtn.style.opacity = "0.5"; // Visual feedback
            chrome.runtime.sendMessage({ type: "analyzeText", text: text });
        } catch (err) {
            console.error("Clipboard read failed:", err);
        }
    });

    function updatePauseUI(isPaused) {
        // Icons: Pause (Standard Grey) / Play (Blue to indicate action needed to resume)
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

    deleteAllBtn.addEventListener("click", () => {
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
                // Support new 'images' array or fallback to old 'png' string
                openInNewTab(item.images || (item.png ? [item.png] : []));
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

    function openInNewTab(items) {
        if (!items || items.length === 0) return;

        // Construct HTML for the viewer (Unified for single/multiple to support rotation)
        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Label Preview (${items.length} items)</title>
                <style>
                    body { font-family: sans-serif; background: #f5f5f5; margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 40px; }
                    .label-card { background: white; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); border-radius: 8px; max-width: 95vw; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; }
                    .header { width: 100%; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
                    .page-num { color: #444; font-size: 18px; font-weight: bold; }
                    .btn { background: #0d6da0; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; transition: background 0.2s; }
                    .btn:hover { background: #095c8a; }
                    .img-container { overflow: hidden; display: flex; justify-content: center; align-items: center; padding: 10px; }
                    img, iframe { max-width: 100%; transition: transform 0.3s ease; }
                    iframe { width: 90vw; height: 90vh; border: none; }
                </style>
                <script>
                    function rotate(id) {
                        const el = document.getElementById(id);
                        let current = parseInt(el.getAttribute('data-rotation') || '0');
                        current = (current + 90) % 360;
                        el.style.transform = 'rotate(' + current + 'deg)';
                        el.setAttribute('data-rotation', current);
                    }
                </script>
            </head>
            <body>
                ${items.map((item, idx) => {
                    let src = item.src || item;
                    if (!src.startsWith("data:")) src = \`data:image/png;base64,\${src}\`;
                    const isPdf = src.includes("application/pdf");
                    return \`
                    <div class="label-card">
                        <div class="header">
                            <div class="page-num">Label \${idx + 1}</div>
                            <button class="btn" onclick="rotate('media-\${idx}')">Rotate ↻</button>
                        </div>
                        <div class="img-container">
                            \${isPdf ? 
                                \`<iframe id="media-\${idx}" src="\${src}"></iframe>\` : 
                                \`<img id="media-\${idx}" src="\${src}" />\`
                            }
                        </div>
                    </div>\`;
                }).join('')}
            </body>
            </html>
        `;
        
        const blob = new Blob([htmlContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        chrome.tabs.create({ url }, () => setTimeout(() => URL.revokeObjectURL(url), 10000));
    }

    loadHistory();

    // Listen for results from background (for clipboard actions)
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === "labelPreview") {
            pasteBtn.style.opacity = "1";
            if (msg.success) {
                loadHistory(); // Refresh list
                openInNewTab(msg.images);
            } else {
                console.error(msg.error);
            }
        }
    });

    // Listen for storage changes to update history list (e.g. when background processes a label on the page)
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.labelHistory) {
            loadHistory();
        }
    });
});
