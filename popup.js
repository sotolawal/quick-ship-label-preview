document.addEventListener("DOMContentLoaded", async () => {
    const listContainer = document.getElementById("history-list");
    const toggleSearchBtn = document.getElementById("toggle-search-btn");
    const deleteAllBtn = document.getElementById("delete-all-btn");
    const searchBar = document.getElementById("search-bar");
    const searchInput = document.getElementById("search-input");
    const searchClearIcon = document.getElementById("search-clear-icon");
    
    let fullHistory = [];

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
        if (!query || !text) return text;
        
        const strText = String(text);
        // Escape special regex chars in query
        const safeQuery = query.replace(/[.*+?^${}()|[\\]/g, '\\$&');
        const regex = new RegExp(`(${safeQuery})`, 'gi');
        
        return strText.replace(regex, '<mark>$1</mark>');
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

            // Apply highlighting
            const displayPackID = highlightText(item.packID, highlightQuery);
            const displayWebsite = highlightText(item.website, highlightQuery);

            el.innerHTML = `
                <div class="item-info">
                    <div class="header-row">
                        <span class="pack-id" title="${item.packID}">${displayPackID}</span>
                        ${item.website ? `<span class="website">${displayWebsite}</span>` : ''}
                    </div>
                    <span class="timestamp">${dateStr} at ${timeStr}</span>
                </div>
                <div class="item-actions">
                    <div class="chevron">&rsaquo;</div>
                    <button class="delete-btn" title="Delete">
                        <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                </div>
            `;

            // Open Image
            el.addEventListener("click", (e) => {
                if (e.target.closest(".delete-btn")) return;
                openInNewTab(item.png);
            });

            // Delete Individual Item
            const deleteBtn = el.querySelector(".delete-btn");
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

    function openInNewTab(base64) {
        const src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
        
        fetch(src)
            .then(res => res.blob())
            .then(blob => {
                const url = URL.createObjectURL(blob);
                chrome.tabs.create({ url: url });
            });
    }

    loadHistory();
});
