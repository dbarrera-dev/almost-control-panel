function createTwitchHelix({ httpsRequest }) {
  async function twitchHelixGet(path, clientId, token) {
    const r = await httpsRequest('GET', 'api.twitch.tv', path, {
      'Client-Id': clientId,
      'Authorization': `Bearer ${token}`
    });
    return r;
  }

  async function twitchHelixPatch(path, clientId, token, body) {
    const r = await httpsRequest('PATCH', 'api.twitch.tv', path, {
      'Client-Id': clientId,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }, JSON.stringify(body));
    return r;
  }

  async function getTwitchBroadcasterId(channel, clientId, token) {
    const r = await twitchHelixGet(`/helix/users?login=${encodeURIComponent(channel)}`, clientId, token);
    if (r.status !== 200 || !r.data?.data?.[0]) return null;
    return r.data.data[0].id;
  }

  return { twitchHelixGet, twitchHelixPatch, getTwitchBroadcasterId };
}

module.exports = { createTwitchHelix };
