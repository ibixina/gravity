document.addEventListener('DOMContentLoaded', () => {
    // Load existing settings
    chrome.storage.local.get(['settings'], (result) => {
        const settings = result.settings || {
            autoScan: true,
            showBadge: true,
            askSaveLocation: false,
            filenameTemplate: '{site}_{title}_{index}'
        };

        document.getElementById('auto-scan').checked = settings.autoScan;
        document.getElementById('show-badge').checked = settings.showBadge;
        document.getElementById('ask-save-location').checked = settings.askSaveLocation;
        document.getElementById('filename-template').value = settings.filenameTemplate;
    });

    // Save settings
    document.getElementById('save-btn').addEventListener('click', () => {
        const settings = {
            autoScan: document.getElementById('auto-scan').checked,
            showBadge: document.getElementById('show-badge').checked,
            askSaveLocation: document.getElementById('ask-save-location').checked,
            filenameTemplate: document.getElementById('filename-template').value
        };

        chrome.storage.local.set({ settings }, () => {
            const statusMsg = document.getElementById('status-msg');
            statusMsg.textContent = 'Settings saved!';
            statusMsg.style.opacity = '1';

            setTimeout(() => {
                statusMsg.style.opacity = '0';
            }, 3000);
        });
    });
});
