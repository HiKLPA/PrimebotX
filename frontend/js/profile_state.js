(function () {
  'use strict';

  var API = '/api/v1/auth/state';
  var SAVE_DELAY = 800;
  var MAX_VALUE_LENGTH = 24 * 1024;
  var MAX_AVATAR_LENGTH = 96 * 1024;
  var STORAGE_KEYS = [
    'primebotx.mode',
    'primebotx.bg',
    'primebotx.bot',
    'primebotx.lang',
    'primebotx.idle.enabled',
    'primebotx.chat.speech.enabled',
    'primebotx.mood',
    'primebotx.skin',
    'primebotx.default-view',
    'primebotx:avatar',
    'primebotx:personas',
    'primebotx:persona',
    'primebotx:cards',
  ];

  var userId = null;
  var ready = false;
  var loading = false;
  var saveTimer = 0;
  var lastSnapshot = '';

  function token() {
    return window.primebotxAuth ? window.primebotxAuth.token : '';
  }

  function request(method, body, keepalive) {
    var accessToken = token();
    if (!accessToken) return Promise.reject(new Error('Not signed in'));
    var headers = {'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken};
    if (method !== 'GET') {
      headers['Idempotency-Key'] = window.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
    return fetch(API, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive: !!keepalive,
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (payload) {
        if (!response.ok || !payload || payload.error) {
          var message = payload && payload.error && payload.error.message;
          throw new Error(message || 'Profile state request failed');
        }
        return payload.data;
      });
    });
  }

  function safeValue(key, value) {
    if (typeof value !== 'string') return '';
    if (key === 'primebotx:avatar') {
      if (/^a[1-4]$/.test(value)) return value;
      if (value.length <= MAX_AVATAR_LENGTH &&
          /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
      return '';
    }
    if (value.length > MAX_VALUE_LENGTH) return '';
    if (key === 'primebotx.skin' && value.indexOf('builtin:') !== 0) return '';
    return value;
  }

  function collectStorage() {
    var state = {};
    STORAGE_KEYS.forEach(function (key) {
      try {
        var value = safeValue(key, localStorage.getItem(key));
        if (value) state[key] = value;
      } catch (_error) {}
    });
    return state;
  }

  function collect() {
    return {
      version: 1,
      storage: collectStorage(),
      chat: window.primebotxChat && typeof window.primebotxChat.exportState === 'function'
        ? window.primebotxChat.exportState()
        : {history: [], records: []},
    };
  }

  function applyStorage(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
    var changed = false;
    STORAGE_KEYS.forEach(function (key) {
      try {
        var value = Object.prototype.hasOwnProperty.call(values, key)
          ? safeValue(key, values[key])
          : '';
        if (value && localStorage.getItem(key) !== value) {
          localStorage.setItem(key, value);
          changed = true;
        } else if (!value && localStorage.getItem(key) !== null) {
          localStorage.removeItem(key);
          changed = true;
        }
      } catch (_error) {}
    });
    return changed;
  }

  function clearLocalState() {
    STORAGE_KEYS.forEach(function (key) {
      try { localStorage.removeItem(key); } catch (_error) {}
    });
    if (window.primebotxChat && typeof window.primebotxChat.restoreState === 'function') {
      window.primebotxChat.restoreState({history: [], records: []});
    }
  }

  function flush(keepalive) {
    if (!ready || !userId || loading || !token()) return Promise.resolve(false);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    var state = collect();
    var serialized = JSON.stringify(state);
    if (serialized === lastSnapshot) return Promise.resolve(false);
    return request('PUT', {state: state}, keepalive).then(function () {
      lastSnapshot = serialized;
      return true;
    }).catch(function (error) {
      console.warn('[PrimebotX] Could not save account state:', error.message);
      return false;
    });
  }

  function scheduleSave() {
    if (!ready || !userId || loading) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { flush(false); }, SAVE_DELAY);
  }

  function hydrate(user) {
    if (!user || loading || (userId === user.id && ready)) return;
    userId = user.id;
    ready = false;
    loading = true;
    var seedAccount = false;
    request('GET').then(function (data) {
      var state = data && data.state;
      if (!state) {
        ready = true;
        lastSnapshot = '';
        seedAccount = true;
        return null;
      }
      if (applyStorage(state.storage)) {
        location.reload();
        return null;
      }
      if (window.primebotxChat && typeof window.primebotxChat.restoreState === 'function') {
        window.primebotxChat.restoreState(state.chat || {history: [], records: []});
      }
      ready = true;
      lastSnapshot = JSON.stringify(collect());
      return null;
    }).catch(function (error) {
      console.warn('[PrimebotX] Could not restore account state:', error.message);
    }).finally(function () {
      loading = false;
      if (seedAccount) flush(false);
    });
  }

  document.addEventListener('authchange', function (event) {
    var user = event.detail && event.detail.user;
    if (user) hydrate(user);
    else {
      var wasSignedIn = userId !== null;
      userId = null;
      ready = false;
      lastSnapshot = '';
      clearTimeout(saveTimer);
      if (wasSignedIn) clearLocalState();
    }
  });
  window.addEventListener('primebotx-state-dirty', scheduleSave);
  document.addEventListener('click', scheduleSave);
  document.addEventListener('change', scheduleSave);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.setInterval(scheduleSave, 10000);

  window.primebotxProfile = {
    flush: function () { return flush(false); },
    get ready() { return ready; },
  };

  if (window.primebotxAuth && window.primebotxAuth.user) {
    hydrate(window.primebotxAuth.user);
  }
})();
