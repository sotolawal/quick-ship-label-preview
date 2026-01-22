document.addEventListener("DOMContentLoaded", async () => {
    const listContainer = document.getElementById("history-list");

    try {
        const result = await chrome.storage.local.get("labelHistory");
        const history = result.labelHistory || [];

        if (history.length === 0) {
            listContainer.innerHTML = '<div class="empty-state">No recent labels found.</div>';
            return;
        }

        history.forEach(item => {
            const el = document.createElement("div");
            el.className = "history-item";
            
            const date = new Date(item.timestamp);
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const dateStr = date.toLocaleDateString();

            el.innerHTML = `
                <div class="item-info">
                    <span class="pack-id">Pack ID: ${item.packID}</span>
                    <span class="timestamp">${dateStr} at ${timeStr}</span>
                </div>
                <div style="color: #0056b3; font-size: 20px;">&rsaquo;</div>
            `;

            el.addEventListener("click", () => {
                openInNewTab(item.png);
            });

            listContainer.appendChild(el);
        });

    } catch (err) {
        console.error("Failed to load history:", err);
        listContainer.innerHTML = '<div class="empty-state">Error loading history.</div>';
    }

    function openInNewTab(base64) {
        const src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
        
        // Open the base64 image in a new tab
        // Note: Chrome might block navigating to top-frame data URIs directly. 
        // A safer way is to fetch it as a blob and create a blob URL, or write to a new tab's document.
        fetch(src)
            .then(res => res.blob())
            .then(blob => {
                const url = URL.createObjectURL(blob);
                chrome.tabs.create({ url: url });
            });
    }
});
