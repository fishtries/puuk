"""Bounded service-account credentials for the supervised CDN control plane.

No application/config/DB imports. Keys enter child stdin, tokens stay in the child,
and all IAM work shares the caller's existing deadline.
"""
import json
import re
import time
_ID=re.compile(r'[A-Za-z0-9_-]{1,64}')


def service_account_key(path):
    import os
    import stat
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid not in (0,os.geteuid()) or st.st_mode & 0o077 or st.st_size>8192:
            raise ValueError('credential_unavailable')
        raw=os.read(fd,8193)
    finally:
        os.close(fd)
    if len(raw)>8192:
        raise ValueError('credential_unavailable')
    obj=json.loads(raw)
    key={k:obj[k] for k in ('id','service_account_id','private_key')}
    if any(not isinstance(key[k],str) or not _ID.fullmatch(key[k]) for k in ('id','service_account_id')):
        raise ValueError('credential_invalid')
    if not isinstance(key['private_key'],str) or not 1<=len(key['private_key'])<=7000:
        raise ValueError('credential_invalid')
    # Validate the signing material before an enabled service can start.
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    from cryptography.hazmat.primitives.asymmetric import rsa
    parsed=load_pem_private_key(key['private_key'].encode(),password=None)
    if not isinstance(parsed,rsa.RSAPrivateKey) or parsed.key_size<2048:
        raise ValueError('credential_invalid')
    return key


def retry_after(response):
    from email.utils import parsedate_to_datetime
    after=response.getheader('Retry-After','0')
    try:
        after=float(after) if after.isdigit() else max(0,parsedate_to_datetime(after).timestamp()-time.time())
    except (ValueError,TypeError,OverflowError):
        after=0
    return min(86400,after)


def service_account_token(key,end):
    """Exchange a short PS256 assertion, without returning secrets from the child."""
    import http.client
    import ssl
    import jwt
    if not isinstance(key,dict) or any(not isinstance(key.get(k),str) or not _ID.fullmatch(key[k]) for k in ('id','service_account_id')):
        raise ValueError('credential_invalid')
    private=key.get('private_key')
    if not isinstance(private,str) or len(private)>7000:
        raise ValueError('credential_invalid')
    now=int(time.time())
    assertion=jwt.encode({'aud':'https://iam.api.cloud.yandex.net/iam/v1/tokens',
        'iss':key['service_account_id'],'iat':now,'exp':now+300},
        private,algorithm='PS256',headers={'kid':key['id']})
    left=end-time.monotonic()
    if left<=0:raise TimeoutError()
    conn=http.client.HTTPSConnection('iam.api.cloud.yandex.net',timeout=min(2,left),context=ssl.create_default_context())
    try:
        conn.request('POST','/iam/v1/tokens',body=json.dumps({'jwt':assertion}).encode(),
            headers={'Content-Type':'application/json','Accept':'application/json'})
        response=conn.getresponse()
        if response.status!=200:
            # Redirects and permanent credential failures never go to another host.
            return {'status':'retry' if response.status==429 or response.status>=500 else 'terminal',
                'reason':'iam_rejected','retry_after':retry_after(response)}
        raw=bytearray()
        while True:
            left=end-time.monotonic()
            if left<=0:raise TimeoutError()
            if conn.sock:conn.sock.settimeout(min(2,left))
            chunk=response.read(min(4096,65537-len(raw)))
            raw.extend(chunk)
            if len(raw)>65536:raise ValueError('credential_response_invalid')
            if not chunk:break
        obj=json.loads(raw)
        token=obj.get('iamToken')
        if not isinstance(token,str) or not 1<=len(token)<=7000 or any(ord(c)<33 or ord(c)>126 for c in token):
            raise ValueError('credential_response_invalid')
        return token
    finally:
        conn.close()


