// ── Dropdown custom (reemplaza el menú nativo feo del <select>) ──────
// Mejora cualquier <select data-uisel> manteniéndolo como fuente de verdad:
// el código existente puede seguir leyendo/escribiendo select.value y
// escuchando el evento 'change' sin enterarse de nada.
(function () {
  function closeAllUisel(except) {
    document.querySelectorAll('.uisel.open').forEach((w) => {
      if (w !== except) w._uiselClose && w._uiselClose();
    });
  }

  function enhanceSelect(sel) {
    if (!sel || sel.dataset.uiselReady) return;
    sel.dataset.uiselReady = '1';

    const inline = sel.dataset.uisel === 'inline';
    const wrap = document.createElement('div');
    wrap.className = 'uisel' + (inline ? ' uisel-inline' : '');
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('uisel-native');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'uisel-trigger';
    trigger.innerHTML =
      '<span class="uisel-value"></span>' +
      '<svg class="uisel-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    wrap.appendChild(trigger);

    const panel = document.createElement('div');
    panel.className = 'uisel-panel';
    panel.setAttribute('role', 'listbox');
    wrap.appendChild(panel);

    const valueEl = trigger.querySelector('.uisel-value');

    function buildOptions() {
      panel.innerHTML = '';
      Array.from(sel.options).forEach((opt) => {
        const o = document.createElement('div');
        o.className = 'uisel-opt' + (opt.value === sel.value ? ' sel' : '');
        o.textContent = opt.textContent;
        o.dataset.value = opt.value;
        o.setAttribute('role', 'option');
        o.addEventListener('click', () => {
          if (sel.value !== opt.value) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          syncValue();
          close();
        });
        panel.appendChild(o);
      });
    }

    function syncValue() {
      const opt = sel.options[sel.selectedIndex];
      valueEl.textContent = opt ? opt.textContent : '';
      panel.querySelectorAll('.uisel-opt').forEach((o) => {
        o.classList.toggle('sel', o.dataset.value === sel.value);
      });
    }

    function onDocClick(e) { if (!wrap.contains(e.target) && !panel.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') { close(); trigger.focus(); } }
    function onReposition() { positionPanel(); }

    // Posiciona el panel con position:fixed para que NO lo recorte ningún
    // contenedor con overflow:hidden (p. ej. .ops-panel) ni se salga del modal.
    function positionPanel() {
      const r = trigger.getBoundingClientRect();
      panel.style.position = 'fixed';
      panel.style.right = 'auto';
      if (inline) {
        panel.style.width = 'auto';
        panel.style.minWidth = r.width + 'px';
      } else {
        panel.style.width = r.width + 'px';
        panel.style.minWidth = '0';
      }
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      let left = r.left;
      if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - pw);
      panel.style.left = left + 'px';
      const spaceBelow = window.innerHeight - r.bottom;
      if (spaceBelow < ph + 12 && r.top > spaceBelow) {
        panel.style.top = Math.max(8, r.top - ph - 6) + 'px';
      } else {
        panel.style.top = (r.bottom + 6) + 'px';
      }
    }

    function open() {
      closeAllUisel(wrap);
      buildOptions();
      wrap.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      positionPanel();
      const active = panel.querySelector('.uisel-opt.sel');
      if (active) active.scrollIntoView({ block: 'nearest' });
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey);
      window.addEventListener('scroll', onReposition, true);
      window.addEventListener('resize', onReposition);
    }
    function close() {
      wrap.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      // Limpia los estilos inline para restaurar el CSS por defecto
      panel.style.position = panel.style.top = panel.style.left = '';
      panel.style.width = panel.style.minWidth = panel.style.right = '';
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    }
    wrap._uiselClose = close;

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      if (sel.disabled) return;
      wrap.classList.contains('open') ? close() : open();
    });

    // Si otro código cambia el valor por fuera, reflejarlo.
    sel.addEventListener('change', syncValue);

    buildOptions();
    syncValue();
  }

  function scan(root) {
    (root || document).querySelectorAll('select[data-uisel]').forEach(enhanceSelect);
  }

  // Expuesto por si alguna vista inyecta selects dinámicamente.
  window.uiSelectScan = scan;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan());
  } else {
    scan();
  }
})();
