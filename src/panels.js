// Collapsible panels for small screens: every sidebar section (tap its title), the HUD, the chart and the legend
// (tap their heading), and the whole left column (the ☰ button in the header). On a phone everything starts
// folded except the play controls, so the 3D view stays visible.

/** A phone: touch only and a short screen side under 600 px (tablets and desktops keep the full UI). */
export const isPhone = () =>
  matchMedia('(hover: none) and (pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;

function foldable(panel, handle, collapsed) {
  panel.classList.add('foldable');
  handle.classList.add('fold-handle');
  handle.setAttribute('role', 'button');
  handle.tabIndex = 0;
  const set = (c) => {
    panel.classList.toggle('collapsed', c);
    handle.setAttribute('aria-expanded', String(!c));
  };
  set(collapsed);
  const toggle = (e) => {
    if (e.target.closest('button, input, select, a') && e.target !== handle) return; // the heading's own buttons
    set(!panel.classList.contains('collapsed'));
  };
  handle.addEventListener('click', toggle);
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
  });
}

export function setupPanels() {
  const phone = isPhone();
  document.body.classList.toggle('phone', phone);

  for (const sec of document.querySelectorAll('.control-sidebar .sidebar-section')) {
    const open = sec.querySelector('#txt-sec-controls'); // play controls stay open on a phone
    foldable(sec, sec.querySelector('.section-title'), phone && !open);
  }
  foldable(document.querySelector('.hud-panel'), document.getElementById('hud-toggle'), false);
  foldable(document.querySelector('.chart-panel'), document.getElementById('txt-chart-title'), phone);
  foldable(document.querySelector('.legend-panel'), document.getElementById('txt-legend-title'), phone);

  // whole left column: folds down to the ☰ button (in place of the brand icon)
  const col = document.querySelector('.left-column');
  const btn = document.getElementById('btn-left-toggle');
  const set = (c) => {
    col.classList.toggle('collapsed', c);
    btn.setAttribute('aria-expanded', String(!c));
  };
  set(phone);
  btn.addEventListener('click', () => set(!col.classList.contains('collapsed')));
}
