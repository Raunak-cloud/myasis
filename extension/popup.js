const API = 'http://localhost:5180';
const $ = (id) => document.getElementById(id);

(async () => {
  try {
    const q = await fetch(`${API}/api/queue`).then((r) => r.json());
    $('server').textContent = 'connected';
    $('server').style.color = '#34d399';
    $('queue').textContent = `${q.filter((i) => i.status === 'pending').length} pending`;
  } catch {
    $('server').textContent = 'offline';
    $('server').style.color = '#f87171';
    $('queue').textContent = '—';
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const st = await chrome.tabs.sendMessage(tab.id, { type: 'status' });
    if (st?.onApplyPage) {
      $('sub').textContent = `Ready — job ${st.jobId}`;
      $('fill').disabled = false;
      $('fill').onclick = async () => {
        $('fill').textContent = 'Filling…';
        await chrome.tabs.sendMessage(tab.id, { type: 'fill-now' });
        window.close();
      };
    } else {
      $('sub').textContent = 'Open a SEEK application page to use this.';
    }
  } catch {
    $('sub').textContent = 'Not a SEEK application page.';
  }
})();
