"""End-to-end behavior tests against a real local HTTP process; no Q1 required."""
import json, socket, subprocess, sys, time, urllib.request, urllib.error
from uuid import uuid4

with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port=sock.getsockname()[1]
process=subprocess.Popen([sys.argv[1], '--port', str(port)], stdout=subprocess.PIPE)
base=f'http://127.0.0.1:{port}/api/v1'
def call(method,path,data=None,key=None,raw=None):
    body=raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
    headers={'Content-Type':'application/json'}
    if method!='GET':headers['Idempotency-Key']=key or str(uuid4())
    request=urllib.request.Request(base+path,data=body,method=method,headers=headers)
    try:response=urllib.request.urlopen(request,timeout=3)
    except urllib.error.HTTPError as error:response=error
    return response.status,json.load(response)
try:
    for _ in range(100):
        try:
            if call('GET','/health')[0]==200:break
        except OSError:time.sleep(.05)
    else:raise AssertionError('server did not start')
    assert call('GET','/health')[1]['data']['ros2_implemented'] is False
    assert call('POST','/tts',{'text':'test'})[0]==503
    assert call('POST','/connections',{'robot_id':'q1-mock','mode':'ros2'})[0]==422
    assert call('POST','/connections',{'robot_id':'q1-mock','mode':'mock'})[0]==200
    assert call('GET','/status')[1]['data']['battery']['source']=='mock'
    key=str(uuid4()); payload={'text':'你好，启元机器人','interrupt':False}
    a=call('POST','/tts',payload,key); b=call('POST','/tts',payload,key)
    assert a==b and a[1]['data']['robot_executed'] is False
    op=a[1]['data']['operation_id']
    assert call('GET','/operations/'+op)[1]['data']['state']=='simulated'
    assert call('POST','/tts',{'text':'changed'},key)[0]==409
    assert call('POST','/tts',{'text':' '})[0]==400
    assert call('POST','/tts',{'text':'你'*301})[0]==400
    assert call('POST','/tts',raw=b'{bad')[0]==400
    assert call('POST','/actions',{'action_id':'unsafe'})[0]==422
    assert call('POST','/actions',{'action_id':'q1.wave'})[0]==200
    assert call('PUT','/audio',{'volume':37,'muted':True})[0]==200
    assert call('PUT','/audio',{'volume':12,'muted':'yes'})[0]==400
    assert call('GET','/audio')[1]['data']['volume']==37 # invalid update is atomic
    for value in (-1,101,1.5,True):assert call('PUT','/audio',{'volume':value})[0]==400
    assert call('GET','/logs?limit=0')[0]==400
    logs=call('GET','/logs')[1]['data']['items']
    assert sum(x['operation_id']==op for x in logs)==1
    assert call('POST','/motion/target',{'forward_velocity_mps':.2})[0]==422
    assert call('GET','/sim/state')[0]==422 # 未给 --sim-url 时仿真接口一律 422，不伪装成可用
    assert call('POST','/control/joints',{'joints':{'left_elbow_joint':0.1}})[0]==422
    for path in ('/sim/preset','/sim/gait','/sim/camera','/sim/speed'): # 新增的仿真操作同样不能假装可用
        assert call('POST',path,{'name':'walk','speed':1.2,'azimuth':120})[0]==422
    assert call('POST','/connections',{'robot_id':'q1-sim','mode':'sim'})[0]==422
    assert call('GET','/cameras')[0]==422
    assert call('DELETE','/connection')[0]==200
    assert call('GET','/status')[1]['data']['battery'] is None
    assert call('POST','/actions',{'action_id':'q1.wave'})[0]==503
    print('PASS: API lifecycle, mock labeling, validation, idempotency, logs, unsupported robot controls')
finally:
    process.terminate()
    try:process.wait(timeout=5)
    except subprocess.TimeoutExpired:process.kill();process.wait()
