// Query the background service worker for connection status
chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
  if (chrome.runtime.lastError || !response) {
    document.getElementById('statusText').textContent = 'Extension loading...';
    return;
  }
  
  const statusEl = document.getElementById('status');
  const dotEl = document.getElementById('dot');
  const textEl = document.getElementById('statusText');
  const pageCountEl = document.getElementById('pageCount');
  
  if (response.connected) {
    statusEl.className = 'status connected';
    dotEl.className = 'dot green';
    textEl.textContent = 'Connected to Markus';
  } else {
    statusEl.className = 'status disconnected';
    dotEl.className = 'dot gray';
    textEl.textContent = 'Not connected';
  }
  
  pageCountEl.textContent = String(response.pageCount || 0);
  document.getElementById('bridgeUrl').textContent = response.bridgeUrl || 'ws://127.0.0.1:9333';
});
