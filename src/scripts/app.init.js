// ── Init ──────────────────────────────────────────────────────────
(async()=>{
  try {
    await loadConfigForm();
    const cfg = await api.getConfig();
    const kickCfg = await api.kickGetConfig().catch(() => null);
    const mode = kickCfg?.kickBotMode === 'dev' ? 'dev' : 'prod';
    const active = mode === 'dev' ? kickCfg?.dev : kickCfg?.prod;
    const kickReady = !!(cfg.supabaseUrl && cfg.supabaseKey && active?.clientId && active?.channel && active?.hasToken);
    if (cfg.autoConnectKickBot !== false && kickReady && !kickCfg?.connected) {
      log('info', 'Config Kick encontrada, conectando bot...');
      const r = await api.kickBotConnect({ mode });
      if (!r?.ok) log('warn', 'No se pudo auto-conectar Kick: ' + (r?.error || 'sin detalle'));
      loadOverlays();
    } else if (kickReady) {
      log('info', 'Almost Control iniciado (auto-connect de Kick desactivado)');
      loadOverlays();
    } else {
      log('info','Almost Control iniciado');
      log('info','Ve a Config para terminar de configurar Kick y Spotify');
    }
  } catch (e) {
    log('warn', 'Error en init: ' + (e.message || e));
  }
  // Pre-cargar badges/datos sin necesidad de visitar los tabs
  api.todosGet().then(r => { if (r.ok) { todosData = r.data || []; todoUpdateBadge(); } }).catch(() => {});
  api.duelosGet().then(r => { if (r.ok) { duelos = r.data || []; _updateDueloBadge(); } }).catch(() => {});
  if (typeof loadIdeas === 'function') loadIdeas().catch(() => {});
  if (typeof loadAnuncios === 'function') loadAnuncios().catch(() => {});
  loadLogHistory();
  loadHistorial();
  // Pintamos la estructura del bracket aunque todavía no haya datos
  // (loadOverlays lo rellena cuando llegan de Supabase).
  if (typeof renderTorneoBracket === 'function') renderTorneoBracket();
  // Dashboard es la vista inicial: cargamos su estado al arrancar.
  if (typeof loadDashboard === 'function') loadDashboard();
})();

// ── Cleanup ──────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  clearInterval(spPollInterval);
  clearInterval(spProgressInterval);
  clearTimeout(spVolumeTimer);
  clearInterval(cdInterval);
});
