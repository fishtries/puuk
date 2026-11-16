"""One flock-fenced hash supervisor per DB; killable, credential-free children.

Only the supervisor publishes. A child owns its inherited flock until real exit,
so a crashed API cannot overlap a still-running attempt with its successor.
"""
import fcntl
import hashlib
import json
import logging
import os
import stat
import subprocess
import sys
import threading
import time
import uuid
from repositories import delivery
from repositories.base import get_connection, check_deadline
import config

logger = logging.getLogger('puuk.delivery')
MAX_BYTES = 500*1024*1024


def open_safe(path, music_dir=None):
    root=os.path.realpath(music_dir or config.get_effective_music_dir())
    candidate=os.path.realpath(path if os.path.isabs(path) else os.path.join(root,path))
    if os.path.commonpath((root,candidate))!=root or candidate==root:
        raise FileNotFoundError('track_unavailable')
    # Traverse the canonical components using pinned directory descriptors.
    # A parent symlink swapped between realpath/open cannot escape the root.
    directory=os.open(os.path.sep,os.O_RDONLY|os.O_DIRECTORY)
    fd=None
    try:
        parts=candidate.lstrip(os.path.sep).split(os.path.sep)
        for part in parts[:-1]:
            following=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            os.close(directory)
            directory=following
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=directory)
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or delivery.fingerprint(os.stat(candidate))!=delivery.fingerprint(st):
            raise FileNotFoundError('track_unavailable')
        if os.path.commonpath((root,os.path.realpath(candidate)))!=root:
            raise FileNotFoundError('track_unavailable')
        result=fd,st,candidate
        fd=None
        return result
    finally:
        os.close(directory)
        if fd is not None:
            os.close(fd)


def minimal_env():
    return {'PATH':os.defpath,'LANG':'C.UTF-8','PYTHONPATH':os.path.dirname(os.path.dirname(__file__)),
        'PUUK_DB_PATH':os.path.abspath(os.getenv('PUUK_DB_PATH') or config.DB_PATH),
        'MUSIC_DIR':config.get_effective_music_dir(), 'DELIVERY_LOCK_DIR':config.get_delivery_lock_dir()}


class OwnerSupervisor:
    """Single synchronous owner thread; no queued control work or replacement on stall."""
    def __init__(self,kind):
        self.kind=kind
        self.stop=threading.Event()
        self.thread=None
        self.owner_fd=None
        self.child=None
        self.clean=True

    def start(self):
        if self.thread and self.thread.is_alive():
            return False
        path=config.get_delivery_lock_dir()
        os.makedirs(path,mode=0o700,exist_ok=True)
        os.chmod(path,0o700)
        fd=os.open(os.path.join(path,self.kind+'-owner.lock'),os.O_CREAT|os.O_RDWR,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            return False
        self.owner_fd=fd
        self.stop.clear()
        self.thread=threading.Thread(target=self._run,name='delivery-'+self.kind,daemon=True)
        self.thread.start()
        return True

    def _run(self):
        try:
            while not self.stop.is_set():
                try:
                    self.tick()
                except Exception:
                    logger.warning('delivery_control kind=%s reason=control_failure',self.kind)
                self.stop.wait(1)
        finally:
            # A stalled tick/child retains this FD and does not reach this branch.
            if self.child is None:
                os.close(self.owner_fd)
                self.owner_fd=None

    def shutdown(self,timeout=5):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout)
        self.clean=not self.thread or not self.thread.is_alive()
        if not self.clean:
            logger.error('delivery_shutdown kind=%s reason=unclean',self.kind)
        return self.clean

    def run_child(self,module,args, *, budget,limit,stdin=None,renew=None):
        if self.child is not None:
            raise TimeoutError('child_still_owned')
        started=time.monotonic()
        proc=subprocess.Popen([sys.executable,'-m',module,*args],shell=False,
            cwd=os.path.dirname(os.path.dirname(__file__)),env=minimal_env(),
            pass_fds=(self.owner_fd,),stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        self.child=proc
        result=bytearray()
        if proc.stdout:
            os.set_blocking(proc.stdout.fileno(),False)
        # stdin is <=8KiB and the child reads immediately; nonblocking writes are
        # included in this same budget instead of an unbounded communicate().
        pending=memoryview(stdin or b'')
        if proc.stdin:
            os.set_blocking(proc.stdin.fileno(),False)
        renew_at=time.monotonic()+10
        ok=True
        try:
            while True:
                if self.stop.is_set() or time.monotonic()-started>=budget:
                    ok=False
                    break
                if renew and time.monotonic()>=renew_at:
                    if not renew():
                        ok=False
                        break
                    renew_at=time.monotonic()+10
                if proc.stdin:
                    if pending:
                        try:
                            n=os.write(proc.stdin.fileno(),pending)
                            pending=pending[n:]
                        except BlockingIOError:
                            pass
                        except BrokenPipeError:
                            pending=memoryview(b'')
                    if not pending:
                        proc.stdin.close()
                        proc.stdin=None
                try:
                    chunk=os.read(proc.stdout.fileno(),min(4096,limit+1-len(result)))
                    result.extend(chunk)
                except BlockingIOError:
                    chunk=None
                if len(result)>limit:
                    ok=False
                    break
                if proc.poll() is not None:
                    # Drain only bounded output after observed exit.
                    while len(result)<=limit:
                        try:
                            chunk=os.read(proc.stdout.fileno(),min(4096,limit+1-len(result)))
                        except BlockingIOError:
                            break
                        if not chunk:
                            break
                        result.extend(chunk)
                    break
                self.stop.wait(.02)
            if proc.poll() is None:
                self.stop_child(proc)
            if not ok or self.stop.is_set() or time.monotonic()-started>=budget or proc.returncode or len(result)>limit:
                raise TimeoutError('child_unavailable')
            return json.loads(result)
        finally:
            if proc.poll() is None:
                self.stop_child(proc)
            if proc.poll() is not None:
                proc.wait()
                for stream in (proc.stdout,proc.stdin):
                    if stream:
                        stream.close()
                self.child=None


    def stop_child(self,proc):
        """All exceptional exits retain ownership until confirmed child exit."""
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.clean=False
                logger.error('delivery_child kind=%s reason=unreaped',self.kind)
                while proc.poll() is None:
                    time.sleep(.1)



class HashSupervisor(OwnerSupervisor):
    def __init__(self):
        super().__init__('hash')

    def tick(self):
        now=time.time()
        fence=uuid.uuid4().hex
        with delivery.transaction(time.monotonic()+.1,self.stop) as conn:
            conn.execute("UPDATE delivery_versions SET state='failed',fence=NULL,lease_until=NULL,reason='hash_exhausted' WHERE state='hashing' AND lease_until<? AND attempts>=2",(now,))
            row=conn.execute("""SELECT * FROM delivery_versions WHERE
                (state='pending' OR (state='hashing' AND lease_until<?))
                AND attempts<2 AND next_attempt_at<=? AND NOT EXISTS (SELECT 1 FROM track_mutation_journal j WHERE j.track_id=delivery_versions.track_id AND j.status IN ('prepared','replaced','failed')) ORDER BY changed_at LIMIT 1""",(now,now)).fetchone()
            if not row:
                return
            track_id=row['track_id']
            conn.execute("UPDATE delivery_versions SET state='hashing',attempts=attempts+1,fence=?,lease_until=? WHERE track_id=?",(fence,now+60,track_id))
        def renew():
            try:
                with delivery.transaction(time.monotonic()+.1,self.stop) as conn:
                    return conn.execute("UPDATE delivery_versions SET lease_until=? WHERE track_id=? AND fence=? AND state='hashing'",(time.time()+60,track_id,fence)).rowcount==1
            except Exception:
                return False
        attempt_deadline=time.monotonic()+120
        try:
            result=self.run_child('services.content_version_service',['--hash-job',track_id],budget=120,limit=512,renew=renew)
            check_deadline(attempt_deadline,self.stop)
            digest=result.get('hash','')
            fp=result.get('fingerprint')
            if len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest) or not isinstance(fp,list) or len(fp)!=5:
                raise ValueError('invalid_result')
            from metadata import track_mutation_lock
            with track_mutation_lock(track_id,config.get_effective_music_dir(),time.monotonic()+.25,self.stop):
                conn=get_connection(deadline=time.monotonic()+.1,cancel=self.stop)
                try:
                    track=conn.execute('SELECT file_path FROM tracks WHERE id=?',(track_id,)).fetchone()
                finally:
                    conn.close()
                if not track:
                    raise FileNotFoundError('track_unavailable')
                fd,st,_=open_safe(track['file_path'])
                try:
                    if delivery.fingerprint(st)!=fp or st.st_size>MAX_BYTES:
                        raise ValueError('changed')
                finally:
                    os.close(fd)
                with delivery.transaction(min(attempt_deadline,time.monotonic()+.1),self.stop) as conn:
                    from repositories.share_entities import recovery_allowed
                    if not recovery_allowed(track_id,conn=conn):
                        return
                    if conn.execute("SELECT 1 FROM track_mutation_journal WHERE track_id=? AND status IN ('prepared','replaced','failed') LIMIT 1",(track_id,)).fetchone():
                        conn.execute("UPDATE delivery_versions SET state='pending',fence=NULL,lease_until=NULL WHERE track_id=? AND fence=?",(track_id,fence))
                        return
                    conn.execute("""UPDATE delivery_versions SET state='ready',content_version=?,fingerprint=?,content_length=?,
                        lease_until=NULL,fence=NULL,reason=NULL,changed_at=? WHERE track_id=? AND fence=? AND state='hashing'""",
                        (digest,json.dumps(fp,separators=(',',':')),st.st_size,time.time(),track_id,fence))
        except Exception:
            with delivery.transaction(time.monotonic()+.1) as conn:
                conn.execute("""UPDATE delivery_versions SET state=CASE WHEN attempts>=2 THEN 'failed' ELSE 'pending' END,
                    reason='hash_unavailable',next_attempt_at=?,fence=NULL,lease_until=NULL,changed_at=? WHERE track_id=? AND fence=?""",(time.time()+5,time.time(),track_id,fence))
            logger.warning('delivery_hash reason=hash_unavailable')


def hash_job(track_id):
    from metadata import track_mutation_lock
    parent=os.getppid()
    if parent==1:
        raise TimeoutError()
    end=time.monotonic()+120
    fd=None
    try:
        with track_mutation_lock(track_id,config.get_effective_music_dir(),time.monotonic()+.25):
            conn=get_connection(deadline=time.monotonic()+.1)
            try:
                row=conn.execute('SELECT file_path FROM tracks WHERE id=?',(track_id,)).fetchone()
            finally:
                conn.close()
            if not row:
                raise FileNotFoundError()
            fd,st,path=open_safe(row['file_path'])
            if st.st_size>MAX_BYTES:
                raise ValueError()
        h=hashlib.sha256()
        while True:
            if os.getppid()!=parent or time.monotonic()>=end:
                raise TimeoutError()
            chunk=os.read(fd,1024*1024)
            if not chunk:
                break
            h.update(chunk)
        fp=delivery.fingerprint(st)
        if delivery.fingerprint(os.fstat(fd))!=fp or delivery.fingerprint(os.stat(path))!=fp:
            raise ValueError()
        print(json.dumps({'hash':h.hexdigest(),'fingerprint':fp},separators=(',',':')))
    finally:
        if fd is not None:
            os.close(fd)


if __name__=='__main__':
    try:
        if len(sys.argv)==3 and sys.argv[1]=='--hash-job':
            hash_job(sys.argv[2])
        else:
            sys.exit(2)
    except Exception:
        sys.exit(1)
