"""Regression: generated clips and rendered startup bones must stay finite."""
import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader'])
 for reduced in ['no-preference','reduce']:
  page=b.new_page(reduced_motion=reduced);errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.add_init_script('''window.invalidBones=[];window.checkedFrames=0;
   window.addEventListener('robot-ready',()=>{
    const renderer=robot3d.renderer,render=renderer.render.bind(renderer);
    renderer.render=(s,c)=>{
     checkedFrames++;
     robot3d.model.traverse(o=>{if(o.isBone && ![...o.position,...o.quaternion,...o.scale].every(Number.isFinite))invalidBones.push(o.name);});
     return render(s,c);
    };
   });''')
  for run in range(2):
   page.goto(os.environ.get('PRIMEBOTX_TEST_URL', 'http://127.0.0.1:8080/ui/PrimebotX.html'),wait_until='domcontentloaded')
   page.wait_for_function('window.robot3d?.ready',timeout=60000)
   page.locator('[data-auth-skip]').first.evaluate('(e)=>e.click()')
   page.wait_for_timeout(1800)
   for action in ['wave','bow_thanks','happy_steps']:
    page.evaluate('(id)=>robot3d.playGesture(id)',action);page.wait_for_timeout(350)
    page.evaluate('robot3d.stopGesture()')
   assert page.evaluate('invalidBones.length')==0,page.evaluate('invalidBones')
   assert page.evaluate('checkedFrames')>0
   assert not errors,errors
   print('PASS finite bones at startup/reload and wave/bow/dance:',reduced,run,flush=True)
  page.close()
 b.close()
