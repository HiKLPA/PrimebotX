"""Persistent authentication and independent browser-session integration test."""
import contextlib, json, socket, subprocess, sys, tempfile, time, urllib.request, urllib.error, sqlite3
from pathlib import Path
binary=sys.argv[1]
with tempfile.TemporaryDirectory() as tmp:
    db=Path(tmp)/'users.db'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    process=None
    def start():
        global process
        process=subprocess.Popen([binary,'--port',str(port),'--db-path',str(db)],stdout=subprocess.DEVNULL)
        for _ in range(100):
            try:
                if call('GET','/health')[0]==200:return
            except OSError:time.sleep(.05)
        raise AssertionError('server not ready')
    def stop():
        process.terminate();process.wait(timeout=5)
    def call(method,path,body=None,token=None):
        headers={'Content-Type':'application/json'}
        if token:headers['Authorization']='Bearer '+token
        req=urllib.request.Request(f'http://127.0.0.1:{port}/api/v1'+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
        try:res=urllib.request.urlopen(req,timeout=10)
        except urllib.error.HTTPError as e:res=e
        return res.status,json.load(res)
    def data(method,path,body=None,token=None,status=200):
        code,payload=call(method,path,body,token);assert code==status,(code,payload);return payload['data']
    try:
        start()
        assert call('GET','/browser/actions')[0]==401
        for name in ['alice','bob']:
            data('POST','/auth/register',{'username':name,'password':'pass word123','display_name':'测试'},status=201)
        assert call('POST','/auth/register',{'username':'ALICE','password':'pass word123'})[0]==409
        assert call('POST','/auth/login',{'username':'alice','password':'wrong-password'})[0]==401
        a=data('POST','/auth/login',{'username':'ALICE','password':'pass word123'})['access_token']
        b=data('POST','/auth/login',{'username':'bob','password':'pass word123'})['access_token']
        assert data('GET','/auth/me',token=a)['user']['username']=='alice'
        assert data('GET','/auth/state',token=a)['state'] is None
        saved={'version':1,'storage':{'primebotx.mode':'night'},'chat':{'records':[],'history':[]}}
        assert data('PUT','/auth/state',{'state':saved},a)['saved'] is True
        assert data('GET','/auth/state',token=a)['state']==saved
        assert data('GET','/auth/state',token=b)['state'] is None
        assert call('PUT','/auth/state',{'state':'invalid'},a)[0]==400
        pages=[data('POST','/browser/sessions',{},token=t,status=201)['session_id'] for t in [a,a,b]]
        assert len(set(pages))==3
        result=data('POST',f'/browser/sessions/{pages[0]}/actions',{'action_id':'raise_hand'},a)
        assert result['status']=='authorized' and result['robot_executed'] is False
        assert data('GET',f'/browser/sessions/{pages[1]}',token=a)['state']['action_id']=='idle'
        assert data('GET',f'/browser/sessions/{pages[2]}',token=b)['state']['action_id']=='idle'
        assert call('GET',f'/browser/sessions/{pages[0]}',token=b)[0]==404
        assert call('POST',f'/browser/sessions/{pages[0]}/actions',{'action_id':'arbitrary'},a)[0]==422
        assert call('GET','/sim/state',token=a)[0]==404
        stop();start()
        assert data('GET','/auth/me',token=a)['user']['username']=='alice'
        data('POST','/auth/logout',{},a)
        assert call('GET','/auth/me',token=a)[0]==401
        assert data('GET','/auth/me',token=b)['user']['username']=='bob'
        with contextlib.closing(sqlite3.connect(db)) as con:
            hashes=[x[0] for x in con.execute('SELECT password_hash FROM users')]
            assert all(h.startswith('$argon2id$') for h in hashes)
            assert a not in str(list(con.execute('SELECT * FROM sessions')))
            con.execute('UPDATE sessions SET expires_at=0');con.commit()
        assert call('GET','/auth/me',token=b)[0]==401
        print('PASS: registration, profile state, duplicate, wrong password, restart persistence, token hash, logout, expiry, account/page isolation, shared-control rejection')
    finally:
        if process and process.poll() is None:stop()
