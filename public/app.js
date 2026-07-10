import { DUE_HOUR, DUE_SOON_DAYS, MODULES, OPEN_HORIZON_DAYS, YEAR } from './modules.js';

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, sept:8, oct:9, nov:10, dec:11 };
const $ = (id) => document.getElementById(id);
const stateEmpty = () => ({ completion: {}, dates: {} });

let state = stateEmpty();
let stateVersion = 0;
let authed = false;
let currentFilter = 'upcoming';
let pendingItem = null;
let lastFocus = null;

function keyFor(code, n) { return `${code}:${n}`; }
function parseDate(value) {
  if (!value) return null;
  const [dayText, monthText] = value.trim().toLowerCase().split(/\s+/);
  const month = MONTHS[monthText?.replace('.', '').slice(0, 4)] ?? MONTHS[monthText?.slice(0, 3)];
  const day = Number.parseInt(dayText, 10);
  return Number.isInteger(day) && month !== undefined ? new Date(YEAR, month, day, DUE_HOUR) : null;
}
function fromISO(value) {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, DUE_HOUR);
}
function toISO(date) {
  if (!date) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function formatDate(date, options = { day:'numeric', month:'short' }) {
  return date ? date.toLocaleDateString('en-GB', options) : '—';
}
function daysUntil(now, date) { return Math.ceil((date - now) / 86400000); }
function statusLabel(item) {
  if (item.isDone) return 'Completed';
  if (item.status === 'overdue') return 'Overdue';
  if (item.status === 'due-soon') return 'Due soon';
  if (item.openNow) return 'Open';
  return 'Upcoming';
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials:'same-origin', ...options });
  let body = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

async function load() {
  const [stateResult, authResult] = await Promise.all([api('/api/state'), api('/api/auth')]);
  if (stateResult.response.ok) {
    stateVersion = stateResult.body?.version ?? 0;
    state = stateResult.body?.data ?? stateEmpty();
    if (stateResult.body?.warning) showNotice('Stored state was invalid, so an empty state was loaded.');
  } else {
    showNotice('Could not load saved state. Changes are temporarily unavailable.');
  }
  authed = Boolean(authResult.body?.authed);
  updateLockUI();
  render();
}

async function saveState(snapshot) {
  const { response, body } = await api('/api/state', {
    method:'PUT', headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ version:stateVersion, data:state }),
  });
  if (response.status === 401) {
    authed = false; updateLockUI(); state = snapshot;
    showNotice('Your editing session expired. Unlock again to save changes.');
    return false;
  }
  if (response.status === 409) {
    state = snapshot;
    showNotice('The saved data changed elsewhere. Reload the page before trying again.');
    return false;
  }
  if (!response.ok) {
    state = snapshot;
    showNotice(`Could not save changes${body?.error ? ` (${body.error})` : ''}.`);
    return false;
  }
  stateVersion = body.version;
  state = body.data;
  return true;
}

function enrich(now = new Date()) {
  return MODULES.map((module) => ({
    ...module,
    items: module.assessments.map((assessment) => {
      const key = keyFor(module.code, assessment.n);
      const originalOpen = parseDate(assessment.open);
      const originalDue = parseDate(assessment.due);
      const overrideDates = state.dates[key];
      const openDate = overrideDates ? fromISO(overrideDates.open) : originalOpen;
      const dueDate = overrideDates ? fromISO(overrideDates.due) : originalDue;
      const completionOverride = state.completion[key];
      const isDone = completionOverride === 'done' ? true : completionOverride === 'undone' ? false : Boolean(assessment.done);
      const openNow = !isDone && (!openDate || now >= openDate) && (!dueDate || now <= dueDate);
      const remaining = dueDate ? (dueDate - now) / 86400000 : null;
      const status = isDone ? 'completed' : dueDate && remaining < 0 ? 'overdue' : dueDate && remaining <= DUE_SOON_DAYS ? 'due-soon' : 'upcoming';
      return { ...assessment, key, moduleCode:module.code, moduleTitle:module.title, moduleColor:module.color,
        originalOpen, originalDue, openDate, dueDate, isDone, openNow, status,
        datesCustomised:Boolean(overrideDates), completionOverride };
    }),
  }));
}

function render() {
  const now = new Date();
  $('todayDate').textContent = formatDate(now, { day:'numeric', month:'short', year:'numeric' });
  $('todayTime').textContent = `${now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })} SAST`;
  const modules = enrich(now);
  const all = modules.flatMap((module) => module.items);
  const done = all.filter((item) => item.isDone).length;
  const open = all.filter((item) => item.openNow).length;
  const pointSoon = all.filter((item) => !item.isDone && !item.openDate && item.dueDate && daysUntil(now, item.dueDate) >= 0 && daysUntil(now, item.dueDate) <= OPEN_HORIZON_DAYS).length;
  const dueSoon = all.filter((item) => item.status === 'due-soon').length;
  const next = all.filter((item) => !item.isDone && item.dueDate && item.dueDate >= now).sort((a,b) => a.dueDate - b.dueDate)[0];

  $('doneCount').textContent = done; $('totalCount').textContent = all.length;
  const percentage = all.length ? Math.round(done / all.length * 100) : 0;
  $('donePct').textContent = `${percentage}% complete`; $('progressFill').style.width = `${percentage}%`;
  $('openCount').textContent = open === open + pointSoon ? open : `${open}–${open + pointSoon}`;
  $('dueSoonCount').textContent = dueSoon;
  if (next) {
    const days = daysUntil(now, next.dueDate);
    $('nextTitle').textContent = `${next.moduleCode} · Assessment ${next.n}`;
    $('nextDue').textContent = `Due ${formatDate(next.dueDate, { weekday:'short', day:'numeric', month:'short' })} at 20:00`;
    $('nextCountdown').innerHTML = `${days} <span>${days === 1 ? 'day' : 'days'}</span>`;
  } else {
    $('nextTitle').textContent = 'All caught up'; $('nextDue').textContent = 'No upcoming assessments'; $('nextCountdown').textContent = '🎉';
  }
  renderModules(modules);
}

function renderModules(modules) {
  const container = $('tracker');
  container.replaceChildren();
  let lastLevel = null;
  let visible = 0;
  for (const module of modules) {
    const items = module.items.filter((item) => currentFilter === 'all' || (currentFilter === 'completed' ? item.isDone : !item.isDone));
    if (!items.length) continue;
    visible += items.length;
    if (module.level !== lastLevel) {
      const title = document.createElement('div'); title.className = 'level-title'; title.textContent = `Level ${module.level}`;
      container.append(title); lastLevel = module.level;
    }
    const row = document.createElement('section'); row.className = 'module';
    const info = document.createElement('div'); info.className = 'module-info';
    const code = document.createElement('div'); code.className = 'module-code';
    const link = document.createElement('a'); link.href = `https://mymodules.dtls.unisa.ac.za/course/view.php?id=${module.moodleId}`;
    link.target = '_blank'; link.rel = 'noopener'; link.style.color = module.color; link.textContent = `${module.code} ↗`;
    code.append(link);
    const title = document.createElement('div'); title.className = 'module-title'; title.textContent = module.title;
    const progress = document.createElement('div'); progress.className = 'module-progress'; progress.textContent = `${module.items.filter((item) => item.isDone).length}/${module.items.length} done`;
    info.append(code, title, progress);
    const assessments = document.createElement('div'); assessments.className = 'assessments';
    for (const item of items) assessments.append(createAssessmentButton(item));
    row.append(info, assessments); container.append(row);
  }
  if (!visible) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No assessments match this filter.'; container.append(empty);
  }
}

function createAssessmentButton(item) {
  const button = document.createElement('button'); button.type = 'button'; button.className = `assessment ${item.status}`;
  button.style.setProperty('--module-color', item.moduleColor);
  button.setAttribute('aria-label', `${item.moduleCode} assessment ${item.n}, ${statusLabel(item)}${item.dueDate ? `, due ${formatDate(item.dueDate)}` : ''}`);
  const heading = document.createElement('div'); heading.className = 'assessment-title';
  const name = document.createElement('span'); name.textContent = `Assessment ${item.n}`;
  const status = document.createElement('span'); status.className = 'assessment-status'; status.textContent = statusLabel(item);
  heading.append(name, status);
  const meta = document.createElement('div'); meta.className = 'assessment-meta';
  meta.textContent = item.dueDate ? `${item.openDate ? `${formatDate(item.openDate)} → ` : ''}${formatDate(item.dueDate)} · 20:00` : 'No date recorded';
  button.append(heading, meta);
  if (item.datesCustomised || item.completionOverride) {
    const edited = document.createElement('div'); edited.className = 'assessment-edited'; edited.textContent = 'Manual override'; button.append(edited);
  }
  button.addEventListener('click', () => openEditor(item, button));
  return button;
}

function openEditor(item, trigger) {
  pendingItem = item; lastFocus = trigger;
  $('modalTitle').textContent = `${item.moduleCode} · Assessment ${item.n}`;
  $('modalSub').textContent = item.moduleTitle;
  $('modalDetail').textContent = `${statusLabel(item)}${item.dueDate ? ` · Due ${formatDate(item.dueDate)} at 20:00` : ''}`;
  $('editOpen').value = toISO(item.openDate); $('editDue').value = toISO(item.dueDate);
  $('modalToggle').textContent = item.isDone ? '↶ Unmark as done' : '✓ Mark as done';
  $('modalToggle').className = `btn toggle${item.isDone ? ' undo' : ''}`;
  $('editorModal').classList.add('show'); $('editorModal').setAttribute('aria-hidden', 'false');
  updateLockUI(); $('modalCancel').focus();
}
function closeEditor() {
  $('editorModal').classList.remove('show'); $('editorModal').setAttribute('aria-hidden', 'true');
  pendingItem = null; lastFocus?.focus();
}
function validateDates() {
  const open = $('editOpen').value; const due = $('editDue').value; const hint = $('formHint');
  const error = !due ? 'Due date is required.' : open && open > due ? 'Open date must be on or before due date.' : '';
  hint.textContent = error || 'Times default to 20:00 SAST. Leave Open blank for a single-date assessment.';
  hint.classList.toggle('warn', Boolean(error)); return !error;
}

async function toggleCompletion() {
  if (!pendingItem || !authed) return;
  const snapshot = structuredClone(state);
  const target = !pendingItem.isDone;
  const original = Boolean(MODULES.find((m) => m.code === pendingItem.moduleCode)?.assessments.find((a) => a.n === pendingItem.n)?.done);
  if (target === original) delete state.completion[pendingItem.key];
  else state.completion[pendingItem.key] = target ? 'done' : 'undone';
  if (await saveState(snapshot)) { closeEditor(); render(); }
}
async function saveDates() {
  if (!pendingItem || !authed || !validateDates()) return;
  const snapshot = structuredClone(state);
  const open = $('editOpen').value || null; const due = $('editDue').value;
  if ((open || null) === (toISO(pendingItem.originalOpen) || null) && due === toISO(pendingItem.originalDue)) delete state.dates[pendingItem.key];
  else state.dates[pendingItem.key] = { open, due };
  if (await saveState(snapshot)) { closeEditor(); render(); }
}

function updateLockUI() {
  $('lockBtn').textContent = authed ? '🔓 Lock editing' : '🔒 Unlock to edit'; $('lockBtn').dataset.authed = authed ? '1' : '0';
  for (const id of ['editOpen','editDue','modalClearDates','modalToggle','modalSave']) $(id).disabled = !authed;
  $('resetButton').disabled = !authed;
}
function openAuth() { $('authError').hidden = true; $('authPassword').value = ''; $('authModal').classList.add('show'); $('authModal').setAttribute('aria-hidden','false'); setTimeout(() => $('authPassword').focus(), 0); }
function closeAuth() { $('authModal').classList.remove('show'); $('authModal').setAttribute('aria-hidden','true'); $('lockBtn').focus(); }
async function submitAuth() {
  const { response, body } = await api('/api/auth', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:$('authPassword').value}) });
  if (response.ok) { authed = true; updateLockUI(); closeAuth(); return; }
  $('authError').hidden = false; $('authError').textContent = response.status === 429 ? 'Too many attempts. Please wait 15 minutes.' : body?.error === 'server_not_configured' ? 'Authentication is not configured.' : 'Incorrect password.';
}
async function toggleLock() {
  if (!authed) return openAuth();
  await api('/api/auth', { method:'DELETE' }); authed = false; updateLockUI();
}
function showNotice(message) { $('notice').textContent = message; $('notice').hidden = false; }

function bindEvents() {
  $('lockBtn').addEventListener('click', toggleLock);
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach((candidate) => candidate.classList.remove('active'));
    button.classList.add('active'); currentFilter = button.dataset.filter; render();
  }));
  $('modalCancel').addEventListener('click', closeEditor); $('modalToggle').addEventListener('click', toggleCompletion); $('modalSave').addEventListener('click', saveDates);
  $('modalClearDates').addEventListener('click', () => { if (!pendingItem) return; $('editOpen').value = toISO(pendingItem.originalOpen); $('editDue').value = toISO(pendingItem.originalDue); validateDates(); });
  $('editOpen').addEventListener('input', validateDates); $('editDue').addEventListener('input', validateDates);
  $('authCancel').addEventListener('click', closeAuth); $('authSubmit').addEventListener('click', submitAuth); $('authForm').addEventListener('submit', (event) => { event.preventDefault(); submitAuth(); });
  $('exportButton').addEventListener('click', () => { const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], {type:'application/json'})); const link = document.createElement('a'); link.href = url; link.download = `unisa-tracker-state-${toISO(new Date())}.json`; link.click(); URL.revokeObjectURL(url); });
  $('resetButton').addEventListener('click', async () => { if (!authed || !confirm('Clear all status and date overrides?')) return; const snapshot = structuredClone(state); state = stateEmpty(); if (await saveState(snapshot)) render(); });
  for (const modal of [$('editorModal'), $('authModal')]) modal.addEventListener('click', (event) => { if (event.target === modal) modal === $('editorModal') ? closeEditor() : closeAuth(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { if ($('authModal').classList.contains('show')) closeAuth(); else if ($('editorModal').classList.contains('show')) closeEditor(); } });
}

bindEvents();
load();
setInterval(render, 60000);
