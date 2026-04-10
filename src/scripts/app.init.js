// ── Init ──────────────────────────────────────────────────────────
(async()=>{
  try {
    await loadConfigForm();
    const koCfgRes = await api.keyOverlayGetConfig();
    if (koCfgRes?.config) koConfig = koCfgRes.config;
    const cfg=await api.getConfig();
    if(cfg.autoConnectBot !== false && cfg.supabaseUrl&&cfg.supabaseKey&&cfg.botUsername&&cfg.botOauth&&cfg.twitchChannel) {
      log('info','Config encontrada, conectando...');
      await doConnect();
    } else if(cfg.supabaseUrl&&cfg.supabaseKey&&cfg.botUsername&&cfg.botOauth&&cfg.twitchChannel) {
      log('info','Almost Control iniciado (auto-connect desactivado)');
      loadOverlays();
    } else {
      log('info','Almost Control iniciado');
      log('info','Ve a Config para configurar las credenciales');
    }
  } catch (e) {
    log('warn', 'Error en init: ' + (e.message || e));
  }
  // Pre-cargar badges sin necesidad de visitar los tabs
  api.todosGet().then(r => { if (r.ok) { todosData = r.data || []; todoUpdateBadge(); } }).catch(() => {});
  api.duelosGet().then(r => { if (r.ok) { duelos = r.data || []; _updateDueloBadge(); } }).catch(() => {});
  loadLogHistory();
  loadHistorial();
})();

// ── Cleanup ──────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  clearInterval(spPollInterval);
  clearInterval(spProgressInterval);
  clearTimeout(spVolumeTimer);
  clearInterval(cdInterval);
});

