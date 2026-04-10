(function () {
  var includes = document.querySelectorAll('[data-include]');
  var readLocal = window.api && typeof window.api.readLocalHtml === 'function'
    ? window.api.readLocalHtml
    : null;

  for (var i = 0; i < includes.length; i++) {
    var el = includes[i];
    var src = el.getAttribute('data-include');
    if (!src) continue;

    if (readLocal) {
      var html = readLocal(src);
      if (html) {
        el.outerHTML = html;
        continue;
      }
    }

    var xhr = new XMLHttpRequest();
    xhr.open('GET', src, false);
    try {
      xhr.send(null);
    } catch (e) {
      console.error('Include error:', src, e);
      continue;
    }
    if (xhr.status === 200 || xhr.status === 0) {
      el.outerHTML = xhr.responseText;
    } else {
      console.error('Include failed:', src, xhr.status);
    }
  }

  // Si siguen quedando includes, mostrar alerta visual
  var remaining = document.querySelectorAll('[data-include]').length;
  if (remaining) {
    var warn = document.createElement('div');
    warn.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0b0b0bcc;color:#fff;font-family:Oswald,sans-serif;z-index:99999;text-align:center;padding:24px;';
    warn.innerHTML = '<div style=\"max-width:520px;\"><div style=\"font-size:20px;font-weight:700;margin-bottom:8px;\">No se pudo cargar la UI</div><div style=\"font-size:13px;line-height:1.5;opacity:.85;\">Esto suele pasar cuando el preload no se carga. Cerrá y volvé a abrir la app desde el proyecto con <code style=\"background:#111;padding:2px 6px;border-radius:4px;\">npm run start</code>. Si sigue igual, avisame.</div></div>';
    document.body.appendChild(warn);
  }
})();
