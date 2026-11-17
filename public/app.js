const $ = id => document.getElementById(id);
const formatTime = value => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const request = async (url, options = {}) => {
  let response;
  try { response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); }
  catch { throw new Error('Could not connect. Check your connection and try again.'); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The server gave an unexpected response. Please try again.'); }
  if (!response.ok) throw new Error(data.error?.message || 'Please try again.');
  return data;
};
function message(text, isError = false) {
  const target = $('message');
  target.textContent = text;
  target.classList.toggle('error', isError);
  target.hidden = false;
  target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function status(element, value) {
  const labels = { available: 'Available', active: 'In use', awaiting_pickup: 'Awaiting pickup', picked_up: 'Picked up', cancelled: 'Cancelled', expired: 'Expired' };
  element.textContent = labels[value] || value;
  element.className = `status ${value === 'active' ? 'occupied' : value === 'awaiting_pickup' ? 'awaiting' : ''}`;
}
async function machinePage() {
  const slug = location.pathname.split('/').pop();
  const refresh = async () => {
    const { machine } = await request(`/api/machines/${encodeURIComponent(slug)}`);
    $('machine-name').textContent = machine.displayName;
    document.title = `FreshOut · ${machine.displayName}`;
    status($('machine-status'), machine.status);
    $('start-panel').hidden = machine.status !== 'available';
    $('notify-panel').hidden = machine.status === 'available';
    $('status-detail').textContent = machine.status === 'available' ? 'Ready for your laundry.' :
      machine.status === 'awaiting_pickup' ? 'The owner has been asked to collect their laundry.' :
      `Estimated finish: ${formatTime(machine.estimatedCompletionAt)}.`;
  };
  $('duration').addEventListener('change', () => {
    const custom = $('duration').value === 'custom';
    $('custom-wrap').hidden = !custom;
    $('custom-duration').required = custom;
  });
  $('start-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('start-button'); button.disabled = true; button.textContent = 'Starting…';
    $('start-form').setAttribute('aria-busy', 'true');
    try {
      const durationMinutes = Number($('duration').value === 'custom' ? $('custom-duration').value : $('duration').value);
      const data = await request(`/api/machines/${encodeURIComponent(slug)}/sessions`, {
        method: 'POST', body: JSON.stringify({ email: $('email').value, durationMinutes }) });
      location.assign(`${data.privateUrl}?started=1`);
    } catch (error) {
      message(error.message, true);
      button.disabled = false; button.textContent = 'Start timer';
      try { await refresh(); } catch { /* Keep the original actionable error visible. */ }
    } finally { $('start-form').removeAttribute('aria-busy'); }
  });
  $('notify-button').addEventListener('click', async () => {
    const button = $('notify-button'); button.disabled = true; button.textContent = 'Notifying…';
    button.setAttribute('aria-busy', 'true');
    try {
      const data = await request(`/api/machines/${encodeURIComponent(slug)}/notify-owner`, { method: 'POST' });
      message(data.message); await refresh();
    } catch (error) { message(error.message, true); }
    finally { button.disabled = false; button.textContent = 'Notify owner'; button.removeAttribute('aria-busy'); }
  });
  try { await refresh(); } catch (error) { message(error.message, true); }
}
async function sessionPage() {
  const token = location.pathname.split('/').pop();
  const endpoint = `/api/sessions/${encodeURIComponent(token)}`;
  let currentSession;
  const render = session => {
    currentSession = session;
    $('session-machine').textContent = session.machineName;
    document.title = `FreshOut · ${session.machineName} session`;
    $('finish-heading').textContent = formatTime(session.estimatedCompletionAt);
    status($('session-status'), session.status);
    $('actions-panel').hidden = !['active', 'awaiting_pickup'].includes(session.status);
    $('pickup-note').hidden = session.status !== 'picked_up';
    $('add-button').disabled = session.durationMinutes >= 240;
    $('machine-link').href = `/machine/${encodeURIComponent(session.machineSlug)}`;
  };
  try {
    const session = (await request(endpoint)).session;
    render(session);
    if (new URLSearchParams(location.search).has('started')) {
      message(`Timer started. Estimated finish: ${formatTime(session.estimatedCompletionAt)}. Save this private page to manage your laundry.`);
      history.replaceState(null, '', location.pathname);
    }
  } catch (error) { message(error.message, true); return; }
  for (const [id, action, text] of [['add-button', 'add-time', 'Added 10 minutes.'], ['pickup-button', 'pickup', 'Marked as picked up.']]) {
    $(id).addEventListener('click', async () => {
      const button = $(id); button.disabled = true; button.setAttribute('aria-busy', 'true');
      try { render((await request(`${endpoint}/${action}`, { method: 'POST' })).session); message(text); }
      catch (error) { message(error.message, true); }
      finally {
        button.disabled = !['active', 'awaiting_pickup'].includes(currentSession.status) ||
          (action === 'add-time' && currentSession.durationMinutes >= 240);
        button.removeAttribute('aria-busy');
      }
    });
  }
}
if (document.body.dataset.page === 'machine') machinePage();
if (document.body.dataset.page === 'session') sessionPage();
