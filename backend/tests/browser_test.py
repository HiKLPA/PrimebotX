import subprocess,tempfile,time,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory() as tmp:
 p=subprocess.Popen([sys.argv[1],'--port','18082','--web-root',str(root/'frontend'),'--db-path',tmp+'/test.db'],stdout=subprocess.DEVNULL)
 try:
  time.sleep(1)
  with sync_playwright() as pw:
   browser=pw.chromium.launch(headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'])
   context=browser.new_context(viewport={'width':1200,'height':850})
   errors=[]
   a=context.new_page();a.on('pageerror',lambda e:errors.append(str(e)))
   a.goto('http://127.0.0.1:18082/ui/experience.html')
   a.locator('#username').fill('browseruser');a.locator('#password').fill('password123')
   a.locator('#register').click();a.wait_for_function("document.getElementById('message').textContent.includes('注册成功')")
   a.locator('#login').click();a.wait_for_selector('[data-action="raise_hand"]:enabled',timeout=60000)
   token=a.evaluate("sessionStorage.getItem('primebotx.auth.token')")
   b=context.new_page();b.on('pageerror',lambda e:errors.append(str(e)))
   b.goto('http://127.0.0.1:18082/ui/experience.html')
   b.evaluate('(token)=>sessionStorage.setItem("primebotx.auth.token",token)',token);b.reload()
   b.wait_for_selector('[data-action="raise_hand"]:enabled',timeout=60000)
   assert a.evaluate('primebotxExperience.sessionId')!=b.evaluate('primebotxExperience.sessionId')
   a.locator('[data-action="raise_hand"]').click()
   a.wait_for_function("robot3d.playback.clip==='raisehand'")
   assert b.evaluate('robot3d.playback.clip')=='idle'
   a.wait_for_function("robot3d.playback.state==='completed'",timeout=60000)
   out=root/'evidence';out.mkdir(exist_ok=True);a.screenshot(path=str(out/'browser-auth-chain.png'))
   a.locator('#logout').click();a.wait_for_selector('#auth-form:visible')
   assert not errors,errors
   print('PASS browser: registration > login > GLB load > two independent tabs > action playback completion > logout; no page errors')
   browser.close()
 finally:p.terminate();p.wait(timeout=5)
