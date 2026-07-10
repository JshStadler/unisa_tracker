const YEAR = 2026;
const ABSOLUTE_START = new Date(YEAR, 3, 1);
const ABSOLUTE_END = new Date(YEAR, 8, 30, 23, 59, 59);
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseShortDate(value) {
  const match = value?.match(/(\d{1,2})\s+([A-Za-z]{3})/);
  if (!match) return null;
  const month = MONTH_NAMES.findIndex((name) => name.toLowerCase() === match[2].toLowerCase());
  if (month < 0) return null;
  return new Date(YEAR, month, Number(match[1]), 20, 0, 0);
}

function visibleWindow() {
  const now = new Date();
  const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const start = new Date(Math.max(ABSOLUTE_START.getTime(), previousMonthStart.getTime()));
  return { start, end: ABSOLUTE_END, span: ABSOLUTE_END - start };
}

function percent(date, window) {
  const bounded = Math.max(window.start.getTime(), Math.min(window.end.getTime(), date.getTime()));
  return ((bounded - window.start.getTime()) / window.span) * 100;
}

function dateFromBar(bar, kind) {
  if (kind === 'open') {
    const range = bar.textContent.match(/(\d{1,2}\s+[A-Za-z]{3})\s*→/);
    return parseShortDate(range?.[1]);
  }
  const range = bar.textContent.match(/→\s*(\d{1,2}\s+[A-Za-z]{3})/);
  if (range) return parseShortDate(range[1]);
  const due = bar.title.match(/Due\s+(\d{1,2}\s+[A-Za-z]{3})/i);
  return parseShortDate(due?.[1]);
}

function applyUpcomingWindow() {
  const activeFilter = document.querySelector('.filter-btn.active')?.dataset.filter;
  if (activeFilter !== 'upcoming') return;

  const tracker = document.getElementById('tracker');
  if (!tracker || tracker.dataset.windowApplied === '1') return;
  tracker.dataset.windowApplied = '1';

  const window = visibleWindow();
  const firstVisibleMonth = window.start.getMonth();

  tracker.querySelectorAll('.timeline-scale, .timeline-grid').forEach((container) => {
    const labels = [...container.querySelectorAll('.month-label')];
    const ticks = [...container.querySelectorAll('.month-tick')];

    labels.forEach((label) => {
      const month = MONTH_NAMES.findIndex((name) => name.toLowerCase() === label.textContent.trim().slice(0, 3).toLowerCase());
      if (month < firstVisibleMonth) {
        label.hidden = true;
        return;
      }
      label.hidden = false;
      label.style.left = `${percent(new Date(YEAR, month, 1), window)}%`;
    });

    ticks.forEach((tick, index) => {
      const month = 3 + index;
      if (month < firstVisibleMonth) {
        tick.hidden = true;
        return;
      }
      tick.hidden = false;
      tick.style.left = `${percent(new Date(YEAR, month, 1), window)}%`;
    });
  });

  tracker.querySelectorAll('.assessment-bar').forEach((bar) => {
    const due = dateFromBar(bar, 'due');
    if (!due) return;

    if (bar.classList.contains('point')) {
      bar.style.left = `calc(${percent(due, window)}% - 7px)`;
      return;
    }

    const open = dateFromBar(bar, 'open') || due;
    const left = percent(open, window);
    const width = Math.max(2, percent(due, window) - left);
    bar.style.left = `${left}%`;
    bar.style.width = `${width}%`;
  });

  tracker.querySelectorAll('.today-line').forEach((line) => {
    const now = new Date();
    if (now < window.start || now > window.end) {
      line.hidden = true;
      return;
    }
    line.hidden = false;
    line.style.left = `${percent(now, window)}%`;
  });

  const label = tracker.querySelector('.timeline-label');
  if (label) {
    label.textContent = `Timeline · from ${MONTH_NAMES[firstVisibleMonth]}`;
  }
}

const observer = new MutationObserver(() => requestAnimationFrame(applyUpcomingWindow));
const tracker = document.getElementById('tracker');
if (tracker) observer.observe(tracker, { childList: true, subtree: true });
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-filter]')) requestAnimationFrame(applyUpcomingWindow);
});
requestAnimationFrame(applyUpcomingWindow);
