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
    pauseBtn.style.background = "none";
    pauseBtn.style.border = "none";
    pauseBtn.style.cursor = "pointer";
    pauseBtn.style.padding = "4px";
    pauseBtn.style.marginRight = "8px";
    pauseBtn.style.display = "flex";
    pauseBtn.style.alignItems = "center";
    
    // Insert before the search button
    if (toggleSearchBtn && toggleSearchBtn.parentNode) {
        toggleSearchBtn.parentNode.insertBefore(pauseBtn, toggleSearchBtn);
    }

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

        // If single image, open directly
        if (items.length === 1) {
            const base64 = items[0];
            const src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
            
            fetch(src)
                .then(res => res.blob())
                .then(blob => {
                    const url = URL.createObjectURL(blob);
                    chrome.tabs.create({ url: url }, () => {
                        setTimeout(() => URL.revokeObjectURL(url), 10000);
                    });
                });
            return;
        }

        // If multiple images, create a gallery page
        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Label Preview (${items.length} items)</title>
                <style>
                    body { font-family: sans-serif; background: #f5f5f5; margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 40px; }
                    .label-card { background: white; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); border-radius: 8px; max-width: 95vw; box-sizing: border-box; }
                    img { max-width: 100%; height: auto; display: block; }
                    iframe { width: 90vw; height: 90vh; border: none; }
                    .page-num { text-align: center; color: #444; margin-bottom: 10px; font-size: 18px; font-weight: bold; }
                </style>
            </head>
            <body>
                ${items.map((img, idx) => {
                    const src = img.startsWith("data:") ? img : `data:image/png;base64,${img}`;
                    const isPdf = src.includes("application/pdf");
                    return `<div class="label-card"><div class="page-num">Label ${idx + 1}</div>${isPdf ? `<iframe src="${src}"></iframe>` : `<img src="${src}" />`}</div>`;
                }).join('')}
            </body>
            </html>
        `;
        
        const blob = new Blob([htmlContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        chrome.tabs.create({ url }, () => setTimeout(() => URL.revokeObjectURL(url), 10000));
    }

    loadHistory();
});
