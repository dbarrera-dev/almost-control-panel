// IPC handlers for OBS Dual Remote Control
const { resolveKickRouting } = require('../kick-utils');

function registerObsDualRemoteIpc({ ipcMain, loadConfig, saveConfig, saveLog, obsDualRemoteService, state }) {
  function getRoomIdFromConfig(cfg) {
    const routing = resolveKickRouting(cfg);
    return String(cfg.obsDualRemoteRoomId || routing.activeChannel || '').trim();
  }

  // ── Config ────────────────────────────────────────────────────
  ipcMain.handle('obs-dual-remote-get-config', () => {
    const cfg = loadConfig();
    return {
      ok:              true,
      enabled:         cfg.obsDualRemoteEnabled         || false,
      mode:            cfg.obsDualRemoteMode            || 'streaming',
      roomId:          getRoomIdFromConfig(cfg),
      hotkeys:         cfg.obsDualRemoteHotkeys         || [],
      hotkeysEnabled:  cfg.obsDualRemoteHotkeysEnabled  !== false,
    };
  });

  ipcMain.handle('obs-dual-remote-save-config', (_, data) => {
    try {
      const cfg = loadConfig();
      if (data.enabled        !== undefined) cfg.obsDualRemoteEnabled        = data.enabled;
      if (data.mode           !== undefined) cfg.obsDualRemoteMode           = data.mode;
      if (data.roomId         !== undefined) cfg.obsDualRemoteRoomId         = data.roomId;
      if (data.hotkeys        !== undefined) cfg.obsDualRemoteHotkeys        = data.hotkeys;
      if (data.hotkeysEnabled !== undefined) cfg.obsDualRemoteHotkeysEnabled = data.hotkeysEnabled;
      saveConfig(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── Status ─────────────────────────────────────────────────────
  ipcMain.handle('obs-dual-remote-get-status', () => {
    return { ok: true, ...obsDualRemoteService.getStatus() };
  });

  // ── Start / Stop ───────────────────────────────────────────────
  ipcMain.handle('obs-dual-remote-start', async () => {
    try {
      const cfg    = loadConfig();
      const roomId = getRoomIdFromConfig(cfg);
      if (!roomId) return { ok: false, error: 'Room ID vacío. Configuralo primero.' };

      obsDualRemoteService.mode = cfg.obsDualRemoteMode || 'streaming';
      const result = await obsDualRemoteService.start({
        mode:   cfg.obsDualRemoteMode || 'streaming',
        roomId,
      });

      if (result.ok) {
        cfg.obsDualRemoteEnabled = true;
        saveConfig(cfg);
        // Register hotkeys if configured
        if (cfg.obsDualRemoteHotkeysEnabled && cfg.obsDualRemoteHotkeys?.length) {
          obsDualRemoteService.registerHotkeys(cfg.obsDualRemoteHotkeys);
        }
      }

      return result;
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('obs-dual-remote-stop', async () => {
    try {
      await obsDualRemoteService.stop();
      const cfg = loadConfig();
      cfg.obsDualRemoteEnabled = false;
      saveConfig(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── Mode ───────────────────────────────────────────────────────
  ipcMain.handle('obs-dual-remote-set-mode', async (_, mode) => {
    try {
      const cfg = loadConfig();
      cfg.obsDualRemoteMode = mode;
      saveConfig(cfg);

      // If active, restart with new mode
      if (obsDualRemoteService.subscribed) {
        const roomId = getRoomIdFromConfig(cfg);
        obsDualRemoteService.mode = mode;
        await obsDualRemoteService.start({ mode, roomId });
      } else {
        obsDualRemoteService.mode = mode;
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── Scene commands ─────────────────────────────────────────────
  ipcMain.handle('obs-dual-remote-send-scene', async (_, side, scene) => {
    return obsDualRemoteService.sendSetScene(side, scene);
  });

  ipcMain.handle('obs-dual-remote-request-state', async () => {
    return obsDualRemoteService.sendGetState();
  });

  // ── Hotkeys ────────────────────────────────────────────────────
  ipcMain.handle('obs-dual-remote-get-hotkeys', () => {
    const cfg = loadConfig();
    return { ok: true, hotkeys: cfg.obsDualRemoteHotkeys || [], hotkeysEnabled: cfg.obsDualRemoteHotkeysEnabled !== false };
  });

  ipcMain.handle('obs-dual-remote-save-hotkeys', (_, hotkeys) => {
    try {
      const cfg = loadConfig();
      cfg.obsDualRemoteHotkeys = hotkeys;
      saveConfig(cfg);
      // Re-register if active and enabled
      if (cfg.obsDualRemoteHotkeysEnabled) {
        const result = obsDualRemoteService.registerHotkeys(hotkeys);
        return { ok: true, ...result };
      }
      return { ok: true, registered: 0, errors: [] };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('obs-dual-remote-toggle-hotkeys', (_, enabled) => {
    try {
      const cfg = loadConfig();
      cfg.obsDualRemoteHotkeysEnabled = enabled;
      saveConfig(cfg);
      if (enabled && cfg.obsDualRemoteHotkeys?.length) {
        const result = obsDualRemoteService.registerHotkeys(cfg.obsDualRemoteHotkeys);
        return { ok: true, ...result };
      } else {
        obsDualRemoteService.clearHotkeys();
        return { ok: true, registered: 0, errors: [] };
      }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('obs-dual-remote-clear-hotkeys', () => {
    obsDualRemoteService.clearHotkeys();
    return { ok: true };
  });

  // ── Auto-start on app launch ───────────────────────────────────
  function autoStart() {
    const cfg = loadConfig();
    if (!cfg.obsDualRemoteEnabled) return;
    const roomId = getRoomIdFromConfig(cfg);
    if (!roomId) return;

    // Supabase may not be ready yet — poll until it is
    let attempts = 0;
    const MAX_ATTEMPTS = 15;

    function tryStart() {
      if (state.supabase) {
        obsDualRemoteService.mode = cfg.obsDualRemoteMode || 'streaming';
        obsDualRemoteService.start({ mode: cfg.obsDualRemoteMode || 'streaming', roomId })
          .then(result => {
            if (result.ok && cfg.obsDualRemoteHotkeysEnabled && cfg.obsDualRemoteHotkeys?.length) {
              obsDualRemoteService.registerHotkeys(cfg.obsDualRemoteHotkeys);
            }
          })
          .catch(() => {});
      } else if (attempts < MAX_ATTEMPTS) {
        attempts++;
        setTimeout(tryStart, 4000);
      }
    }

    setTimeout(tryStart, 6000);
  }

  autoStart();
}

module.exports = { registerObsDualRemoteIpc };

