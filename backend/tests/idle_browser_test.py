
from pathlib import Path
import subprocess,tempfile,time,json
from playwright.sync_api import sync_playwright
r=Path(__file__).resolve().parents[2]
p=subprocess.Popen([str(r/'backend-build/primebotx_backend'),'--port','18087','--web-root',str(r/'frontend')],stdout=subprocess.DEVNULL)
try:
 with sync_playwright() as pw:
  b=pw.chromium.launch(headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'])
  page=b.new_page(viewport={'width':1100,'height':800});errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('http://127.0.0.1:18087/ui/PrimebotX.html')
  page.wait_for_function('robot3d.ready',timeout=60000)
  page.wait_for_timeout(6000)
  page.evaluate('robot3d.stopGesture();primebotxIdle.setEnabled(true)')
  page.wait_for_function('robot3d.idleState.active',timeout=20000)
  page.wait_for_function("robot3d.idleState.kind==='look'",timeout=20000)
  print('PASS original: idle breath and observation',flush=True)
  (r/'evidence').mkdir(exist_ok=True)
  page.screenshot(path=str(r/'evidence/idle-original.png'))
  page.evaluate("robot3d.playGesture('hug')")
  page.wait_for_function('!robot3d.idleState.active')
  page.wait_for_function("!document.querySelector('[data-motion=hug].is-on')",timeout=30000)
  page.wait_for_function('robot3d.idleState.active',timeout=20000)
  page.evaluate('robot3d.freezePose()')
  page.wait_for_function('!robot3d.idleState.active')
  a=page.evaluate('robot3d.model.getObjectByName("Bone005").quaternion.toArray()')
  page.wait_for_timeout(3500)
  assert a==page.evaluate('robot3d.model.getObjectByName("Bone005").quaternion.toArray()')
  print('PASS gesture interruption/recovery and manual pose protection',flush=True)
  page.evaluate("robot3d.playGesture('wave');robot3d.stopGesture();primebotxIdle.setEnabled(false)")
  page.wait_for_function('!robot3d.idleState.active')
  page.reload();page.wait_for_function('robot3d.ready',timeout=60000)
  assert page.evaluate('primebotxIdle.state.enabled') is False
  page.evaluate('primebotxIdle.setEnabled(true)')
  # Select skin directly; button is inside the collapsed panel.
  page.locator('[data-skin-id="builtin:xbot"]').evaluate('(button)=>button.click()')
  page.wait_for_timeout(5000)
  page.wait_for_timeout(7000)
  page.wait_for_function('primebotxIdle.state.active',timeout=30000)
  page.screenshot(path=str(r/'evidence/idle-xbot.png'))
  print('PASS X Bot idle and saved toggle',flush=True)
  page.emulate_media(reduced_motion='reduce');page.wait_for_timeout(500)
  assert not page.evaluate('primebotxIdle.state.active')
  assert not errors,errors
  print('PASS reduced motion; no browser errors',flush=True)
  b.close()
finally:p.terminate();p.wait(timeout=5)
