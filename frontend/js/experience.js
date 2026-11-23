const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('primebotx.auth.token') || '';
// Page identifiers are deliberately never stored: duplicated tabs start independent sessions.
let pageId = null, busy = false, modelReady = false;
const message = text => { $('message').textContent = text; };
function signedOut() {
  token = ''; pageId = null; sessionStorage.removeItem('primebotx.auth.token');
  $('auth-form').hidden = false; $('controls').hidden = true; $('identity').textContent = '尚未登录';
  if (window.robot3d?.ready) window.robot3d.playClip('idle', true);
}
async function api(path, method = 'GET', body) {
  const headers = {'Content-Type':'application/json'};
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api/v1' + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  const result = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') signedOut();
    throw new Error(result.error?.message || '请求失败');
  }
  return result.data;
}
function updateButtons() {
  document.querySelectorAll('[data-action]').forEach(b => { b.disabled = busy || !modelReady || !pageId; });
}
async function startPage() {
  const {user} = await api('/auth/me');
  const page = await api('/browser/sessions', 'POST', {}); pageId = page.session_id;
  const {items} = await api('/browser/actions');
  $('identity').textContent = user.display_name + ' · ' + user.username;
  $('auth-form').hidden = true; $('controls').hidden = false;
  $('actions').replaceChildren();
  for (const action of items) {
    const button = document.createElement('button'); button.textContent = action.label; button.dataset.action = action.id;
    button.addEventListener('click', () => execute(action.id)); $('actions').append(button);
  }
  message('已创建本页面独立会话。'); updateButtons();
}
async function execute(id) {
  busy = true; updateButtons();
  try {
    const result = await api('/browser/sessions/' + pageId + '/actions', 'POST', {action_id:id});
    window.robot3d.playClip(result.playback.clip, result.playback.loop);
    message('仅在本页面播放：' + result.playback.label);
  } catch (e) { message(e.message); }
  finally { busy = false; updateButtons(); }
}
async function authenticate(register) {
  if (!$('auth-form').reportValidity()) return;
  $('login').disabled = $('register').disabled = true;
  try {
    const body = {username:$('username').value, password:$('password').value};
    if (register) {
      if ($('display-name').value) body.display_name = $('display-name').value;
      await api('/auth/register', 'POST', body); message('注册成功，请登录。');
    } else {
      const result = await api('/auth/login', 'POST', body);
      token = result.access_token; sessionStorage.setItem('primebotx.auth.token', token);
      $('password').value = ''; await startPage();
    }
  } catch(e) { message(e.message); }
  finally { $('login').disabled = $('register').disabled = false; }
}
$('auth-form').addEventListener('submit', e => { e.preventDefault(); authenticate(false); });
$('register').addEventListener('click', () => authenticate(true));
$('logout').addEventListener('click', async () => {
  try { await api('/auth/logout', 'POST', {}); signedOut(); message('已退出登录。'); }
  catch(e) { message(e.message); }
});
window.addEventListener('robot-ready', () => { modelReady = true; $('playback').textContent = '模型已就绪'; updateButtons(); });
window.addEventListener('robot-playback', e => { $('playback').textContent = e.detail.clip + ' · ' + e.detail.state; });
modelReady = window.robot3d?.ready || false;
if (token) startPage().catch(e => { message(e.message); });
// Integration hook for the frontend; does not accept arbitrary clips or user IDs.
window.primebotxExperience = {execute, get sessionId(){return pageId;}};
