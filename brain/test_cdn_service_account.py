import test_db_path  # before application imports; all data below is synthetic
import io
import json
import os
import ssl
import time
from types import SimpleNamespace
from unittest import mock
import pytest
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from services import cdn_purge_service as purge


@pytest.fixture(scope='module')
def account_key():
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    return key, {'id':'synthetic-key-id','service_account_id':'synthetic-account-id',
        'private_key':key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()}


class Response:
    def __init__(self,obj,status=200,headers=None):
        self.status=status
        self.headers=headers or {}
        self.body=io.BytesIO(json.dumps(obj).encode())
    def read(self,n):return self.body.read(n)
    def getheader(self,name,default=None):return self.headers.get(name,default)


def transport(monkeypatch, iam, operation=None):
    calls=[]
    replies=[iam,operation or Response({'id':'operation-one','done':False})]
    class Connection:
        def __init__(self,host,**options):
            assert options['context'].verify_mode==ssl.CERT_REQUIRED
            assert 0<options['timeout']<=2
            self.host=host;self.sock=SimpleNamespace(settimeout=lambda timeout: None)
            self.response=replies.pop(0);self.closed=False
            calls.append(self)
        def request(self,method,path,body=None,headers=None):
            self.method=method;self.path=path;self.body=body;self.headers=headers
        def getresponse(self):return self.response
        def close(self):self.closed=True
    monkeypatch.setattr('http.client.HTTPSConnection',Connection)
    return calls


@pytest.mark.parametrize('operation',[None,'operation-one'])
def test_child_exchanges_ps256_and_never_outputs_credentials(monkeypatch,capsys,account_key,operation):
    private,key=account_key
    calls=transport(monkeypatch,Response({'iamToken':'runtime-token-canary'}))
    data={'resource':'synthetic-resource','service_account_key':key,'operation':operation,
        'paths':['/cdn/audio/11111111-1111-4111-8111-111111111111/*']}
    monkeypatch.setattr(purge.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(json.dumps(data).encode())))
    purge.http_job()
    output=capsys.readouterr().out
    assert json.loads(output)=={'status':'polling','operation_id':'operation-one'}
    assert 'runtime-token-canary' not in output and key['private_key'] not in output
    assert len(calls)==2 and all(c.closed for c in calls)
    iam,cdn=calls
    assert iam.host=='iam.api.cloud.yandex.net' and iam.method=='POST' and iam.path=='/iam/v1/tokens'
    assertion=json.loads(iam.body)['jwt']
    header=jwt.get_unverified_header(assertion)
    assert header['alg']=='PS256' and header['kid']==key['id']
    claims=jwt.decode(assertion,private.public_key(),algorithms=['PS256'],
        audience='https://iam.api.cloud.yandex.net/iam/v1/tokens')
    assert claims['iss']==key['service_account_id'] and claims['exp']-claims['iat']==300
    assert cdn.headers['Authorization']=='Bearer runtime-token-canary'
    assert cdn.host==('operation.api.cloud.yandex.net' if operation else 'cdn.api.cloud.yandex.net')
    assert cdn.method==('GET' if operation else 'POST')
    assert 'private_key' not in (cdn.body or b'').decode()


@pytest.mark.parametrize('code,status',[(301,'terminal'),(401,'terminal'),(403,'terminal'),(429,'retry'),(500,'retry')])
def test_iam_failure_never_follows_redirect_or_sends_purge(monkeypatch,capsys,account_key,code,status):
    calls=transport(monkeypatch,Response({'error':'private-canary'},code,{'Retry-After':'65'}))
    data={'resource':'synthetic-resource','service_account_key':account_key[1],
        'paths':['/cdn/audio/11111111-1111-4111-8111-111111111111/*']}
    monkeypatch.setattr(purge.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(json.dumps(data).encode())))
    purge.http_job()
    output=capsys.readouterr().out
    assert json.loads(output)=={'status':status,'reason':'iam_rejected','retry_after':65}
    assert 'private-canary' not in output
    assert len(calls)==1 and calls[0].closed


@pytest.mark.parametrize('token',['', 'bad\r\nheader', 'bad token', 'z'*7001])
def test_invalid_iam_token_cannot_be_used_as_http_credential(monkeypatch,account_key,token):
    calls=transport(monkeypatch,Response({'iamToken':token}))
    with pytest.raises(ValueError):purge.service_account_token(account_key[1],time.monotonic()+10)
    assert len(calls)==1 and calls[0].closed


def test_iam_and_purge_share_one_deadline(monkeypatch,account_key):
    calls=transport(monkeypatch,Response({'iamToken':'runtime-token'}))
    data={'resource':'synthetic-resource','service_account_key':account_key[1],
        'paths':['/cdn/audio/11111111-1111-4111-8111-111111111111/*']}
    monkeypatch.setattr(purge.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(json.dumps(data).encode())))
    # Child start=0, connection before IAM=1, read loop crosses the ten-second limit.
    monkeypatch.setattr(purge.time,'monotonic',mock.Mock(side_effect=[0,1,11]))
    with pytest.raises(TimeoutError):purge.http_job()
    assert len(calls)==1 and calls[0].closed


def test_large_iam_response_is_bounded(monkeypatch,account_key):
    calls=transport(monkeypatch,Response({'iamToken':'z'*65537}))
    with pytest.raises(ValueError):purge.service_account_token(account_key[1],time.monotonic()+10)
    assert len(calls)==1 and calls[0].closed


def test_credential_file_drops_unneeded_fields_and_is_private(monkeypatch,tmp_path,account_key):
    path=tmp_path/'key.json'
    path.write_text(json.dumps({**account_key[1],'public_key':'not-needed','description':'private-canary'}));path.chmod(0o600)
    monkeypatch.setattr(purge.config,'CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH',str(path))
    assert purge.credential_payload()=={'service_account_key':account_key[1]}
    path.chmod(0o644)
    with pytest.raises(ValueError):purge.credential_payload()


def test_credential_file_never_follows_symlink_or_blocks_on_fifo(monkeypatch,tmp_path):
    path=tmp_path/'key.json';other=tmp_path/'other';other.write_text('not a key');path.symlink_to(other)
    monkeypatch.setattr(purge.config,'CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH',str(path))
    with pytest.raises(OSError):purge.credential_payload()
    path.unlink();os.mkfifo(path,0o600)
    with pytest.raises(ValueError):purge.credential_payload()


def test_legacy_token_payload_remains_compatible(monkeypatch):
    monkeypatch.setattr(purge.config,'CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH','')
    monkeypatch.setattr(purge.config,'CDN_PURGE_TOKEN','legacy-canary')
    assert purge.credential_payload()=={'token':'legacy-canary'}


@pytest.mark.parametrize('key_path,token,valid',[
    ('/etc/puuk/purge-key.json','',True),('', 'legacy-token',True),
    ('relative.json','',False),('/etc/../key.json','',False),
    ('/etc/key.json','also-token',False),('','',False)])
def test_config_accepts_exactly_one_protected_auth_method(monkeypatch,tmp_path,account_key,key_path,token,valid):
    if valid and key_path:
        path=tmp_path/"key.json";path.write_text(json.dumps(account_key[1]));path.chmod(0o600);key_path=str(path)
    monkeypatch.setattr(purge.config,'CDN_DELIVERY_ENABLED',False)
    monkeypatch.setattr(purge.config,'CDN_ORIGIN_ENABLED',False)
    monkeypatch.setattr(purge.config,'CDN_PURGE_ENABLED',True)
    monkeypatch.setattr(purge.config,'CDN_RESOURCE_ID','synthetic-resource')
    monkeypatch.setattr(purge.config,'CDN_PURGE_TOKEN',token)
    monkeypatch.setattr(purge.config,'CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH',key_path)
    if valid:assert purge.config.validate_delivery_config()
    else:
        with pytest.raises(ValueError):purge.config.validate_delivery_config()


def test_service_account_auth_keeps_the_purge_heartbeat_gate(monkeypatch,tmp_path):
    import db
    from repositories import delivery
    monkeypatch.setenv('PUUK_DB_PATH',str(tmp_path/'isolated.db'))
    db.init_db()
    monkeypatch.setattr(purge.config,'CDN_PURGE_ENABLED',True)
    monkeypatch.setattr(purge.config,'CDN_RESOURCE_ID','synthetic-resource')
    monkeypatch.setattr(purge.config,'CDN_PURGE_TOKEN','')
    monkeypatch.setattr(purge.config,'CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH','/etc/puuk/key.json')
    assert not delivery.purge_healthy()
    with delivery.transaction() as conn:
        conn.execute("INSERT INTO delivery_control(key,value) VALUES ('purge_heartbeat',?)",(str(time.time()),))
    assert delivery.purge_healthy()
    monkeypatch.setattr(purge.config,'CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH','')
    assert not delivery.purge_healthy()


def test_malformed_key_fails_enabled_config_before_readiness(monkeypatch,tmp_path):
    path=tmp_path/'key.json';path.write_text('{}');path.chmod(0o600)
    monkeypatch.setattr(purge.config,'CDN_DELIVERY_ENABLED',False)
    monkeypatch.setattr(purge.config,'CDN_ORIGIN_ENABLED',False)
    monkeypatch.setattr(purge.config,'CDN_PURGE_ENABLED',True)
    monkeypatch.setattr(purge.config,'CDN_RESOURCE_ID','synthetic-resource')
    monkeypatch.setattr(purge.config,'CDN_PURGE_TOKEN','')
    monkeypatch.setattr(purge.config,'CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH',str(path))
    with pytest.raises((ValueError,KeyError)):purge.config.validate_delivery_config()
