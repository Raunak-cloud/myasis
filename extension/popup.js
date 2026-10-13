const $ = (id) => document.getElementById(id);

(async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'api', path: '/api/queue' });
    if (!response?.ok || !Array.isArray(response.data)) throw new Error('Queue unavailable');
    const q = response.data;
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
