from pathlib import Path
import subprocess,tempfile,time,sys,json
from playwright.sync_api import sync_playwright
r=Path(__file__).resolve().parents[2]
ids=['surprised','hug','refuse']
with tempfile.TemporaryDirectory() as t:
 p=subprocess.Popen([str(r/'backend-build/primebotx_backend'),'--port','18085','--web-root',str(r/'frontend')],stdout=subprocess.DEVNULL)
 try:
  time.sleep(.6)
  with sync_playwright() as pw:
   browser=pw.chromium.launch(headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'])
   page=browser.new_page(viewport={'width':1000,'height':760});errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto('http://127.0.0.1:18085/ui/PrimebotX.html');page.wait_for_function('window.robot3d?.ready',timeout=60000)
   page.locator('[data-panel="Gestures"]').click()
   out=r/'evidence/expressions';out.mkdir(parents=True,exist_ok=True)
   for removed in ['thinking','shy','curious']:
    assert page.evaluate('(id)=>robot3d.getGestureInfo(id)',removed) is None
    assert page.locator(f'[data-motion="{removed}"]').count() == 0
   page.evaluate("robot3d.setMood('calm')")
   for id in ids:
    print('Checking gesture:', id, flush=True)
    card=page.locator(f'[data-motion="{id}"]');card.scroll_into_view_if_needed();card.click(force=True)
    page.wait_for_function('(id)=>document.querySelector(`[data-motion="${id}"]`).getAttribute("aria-pressed")==="true"',arg=id)
    time.sleep(1.1)
    actual=page.evaluate('robot3d.mood');expected={'surprised':'alert','hug':'happy','refuse':'focus'}[id]
    assert actual==expected,(id,actual)
    page.evaluate("document.querySelector('.rail--right').classList.remove('is-open')")
    page.screenshot(path=str(out/(id+'.png')))
    page.evaluate("document.querySelector('.rail--right').classList.add('is-open')")
    page.wait_for_function('(id)=>document.querySelector(`[data-motion="${id}"]`).getAttribute("aria-pressed")==="false"',arg=id,timeout=60000)
    assert page.evaluate('robot3d.mood')=='calm',id
   page.evaluate("robot3d.playGesture('surprised');robot3d.setMood('happy');robot3d.stopGesture()")
   assert page.evaluate('robot3d.mood')=='happy'
   page.evaluate("robot3d.setMood('calm');robot3d.playGesture('hug');robot3d.playGesture('refuse');robot3d.stopGesture()")
   assert page.evaluate('robot3d.mood')=='calm'
   page.evaluate("robot3d.playGesture('street_dance')");time.sleep(.3);page.evaluate('robot3d.stopGesture()')
   # Mock only external AI response; exercise real chat UI and local animation controller.
   for id in ids:
    page.route('**/api/v1/chat',lambda route, request, action_id=id:route.fulfill(json={'request_id':'test','data':{'reply':'好的','actions':[action_id],'stop':False},'error':None}))
    page.locator('[data-assistant-input]').fill('请表演'+id);page.locator('[data-assistant-send]').click()
    page.wait_for_function('(id)=>document.querySelector(`[data-motion="${id}"]`).getAttribute("aria-pressed")==="true"',arg=id)
    page.locator('[data-assistant-stop]').click();page.unroute('**/api/v1/chat')
   assert not errors,errors
   print('PASS: 10 cards, three clicks/completions, expressions restored, manual override, replacement, street dance, three chat actions, no script errors')
   browser.close()
 finally:p.terminate();p.wait(timeout=5)
