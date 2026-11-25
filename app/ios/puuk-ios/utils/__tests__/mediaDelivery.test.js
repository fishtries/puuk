import { MediaDelivery, validateMediaTicket, mediaDelivery, mediaSession, hasOfflineSession, boundedMediaOperation } from '../../shared/api/media';
import { authFetch, setAuthToken, setSavedUser, setServerUrl, getAuthSessionGeneration, logout } from '../../shared/api/api';
import * as SecureStore from 'expo-secure-store';
const ID='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222', HASH='a'.repeat(64);
const session={origin:'https://api.test',userId:'17',generation:1};
const cdn=`https://media.puuk.fun/cdn/audio/${ID}/${HASH}?md5=${'z'.repeat(22)}&expires=2000001800`;
function ticket(changes={}) {return {url:cdn,expires_in:1800,expires_at:2000001800,server_time:2000000000,delivery:'cdn',content_version:HASH,content_length:5000,download_binding:'immutable-path',delivery_epoch:'pilot-v1',cache_for:30,...changes};}
function direct(changes={}) {return ticket({delivery:'direct',url:`/api/stream/${ID}?mt=a.b.c`,download_binding:'if-match',...changes});}
const response=(dto,status=200)=>({ok:status===200,status,json:async()=>dto});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function ticks(){for(let i=0;i<12;i++)await Promise.resolve();}
let now, fetcher, resolver, owner;
beforeEach(()=>{now=1000;owner={...session};fetcher=jest.fn(async()=>response(ticket()));resolver=new MediaDelivery({fetch:fetcher,clock:()=>now,session:()=>owner,enabled:true,token:async()=>'access'});});
afterEach(()=>{resolver.invalidate();jest.useRealTimers();jest.restoreAllMocks();});
const validate=d=>validateMediaTicket(d,{trackId:ID,session,startedAt:1000,now:1000,requested:'cdn'});
test('monotonic request-start expiry and the 30s lease ignore client epoch rollback',()=>{
 const d=validate(ticket());expect(d.usableUntil).toBe(1771000);expect(d.reuseUntil).toBe(31000);
 jest.spyOn(Date,'now').mockReturnValue(-1000000000);expect(validate(ticket()).reuseUntil).toBe(31000);
});
test.each([
 {expires_in:'1800'},{expires_in:1801},{expires_in:0},{expires_at:NaN},{server_time:1999999000},{cache_for:31},{cache_for:'30'},
 {delivery:'other'},{delivery_epoch:'secret?token=x'},{content_version:HASH.toUpperCase()},{content_length:0},{content_length:5000.5},
 {download_binding:'if-match'},{content_version:null,content_length:null,download_binding:null},
])('malformed new DTO is terminal (%#)',changes=>expect(()=>validate(ticket(changes))).toThrow());
test.each([
 `http://media.puuk.fun/cdn/audio/${ID}/${HASH}?md5=${'z'.repeat(22)}&expires=2000001800`,
 cdn.replace('media.puuk.fun','evil.test'),cdn.replace('media.puuk.fun','media.puuk.fun:443'),cdn.replace('media.puuk.fun','user@media.puuk.fun'),
 cdn.replace('/cdn/','/x/../cdn/'),cdn.replace('/cdn/','/%63dn/'),cdn.replace('/audio/','//audio/'),cdn.replace(ID,B),cdn.replace(HASH,'b'.repeat(64)),
 `${cdn}&token=canary`,`${cdn}&md5=canary`,`${cdn}#fragment`,cdn.replace('2000001800','02000001800'),cdn.replace('md5=','m%645='),
])('raw hostile URL fails before normalization (%#)',url=>expect(()=>validate(ticket({url}))).toThrow());
test('legacy server exact API-origin direct response remains streaming-only',()=>{
 const d=validateMediaTicket({url:`https://api.test/api/stream/${ID}?mt=a.b.c`,expires_in:600,expires_at:2000000600},{trackId:ID,session,startedAt:0,now:10});
 expect(d).toMatchObject({delivery:'direct',cacheable:false,contentVersion:null,reuseUntil:30000,headers:{}});
 expect(()=>validateMediaTicket({url:`https://evil.test/api/stream/${ID}?mt=a.b.c`,expires_in:600,expires_at:2000000600},{trackId:ID,session,startedAt:0,now:10})).toThrow();
});
test('direct fallback request cannot accept a CDN-selected response',()=>expect(()=>validateMediaTicket(ticket(),{trackId:ID,session,startedAt:0,now:1,requested:'direct'})).toThrow());
test('CDN flag defaults off and accepted direct mode does not force CDN',async()=>{
 const r=new MediaDelivery({fetch:jest.fn(async()=>response(direct())),session:()=>session,clock:()=>0});await r.resolve(ID);expect(r.fetch.mock.calls[0][1].body).toEqual({track_id:ID,delivery:'direct'});
});
test('dedupes and expires reuse lease at 30s without persisting a source URL',async()=>{
 const a=resolver.resolve({id:ID,stream_url:'https://evil.test/audio?token=canary'}),b=resolver.resolve(ID);await Promise.all([a,b]);expect(fetcher).toHaveBeenCalledTimes(1);
 now=30999;await resolver.resolve(ID);expect(fetcher).toHaveBeenCalledTimes(1);now=31000;await resolver.resolve(ID);expect(fetcher).toHaveBeenCalledTimes(2);
});
test('request duration is deducted in full; a response arriving after lease is never reused',async()=>{
 fetcher.mockImplementation(async()=>{now+=31000;return response(ticket());});await resolver.resolve(ID);await resolver.resolve(ID);expect(fetcher).toHaveBeenCalledTimes(2);
});
test('monotonic reset clears permissions',async()=>{await resolver.resolve(ID);now=500;await resolver.resolve(ID);expect(fetcher).toHaveBeenCalledTimes(2);});
test('permission LRU never exceeds 200',async()=>{
 fetcher.mockImplementation(async(_,o)=>{const id=o.body.track_id;return response(direct({url:`/api/stream/${id}?mt=a.b.c`}));});
 for(let i=0;i<205;i++) await resolver.resolve(`11111111-1111-4111-8111-${String(i).padStart(12,'0')}`);
 expect(resolver.cache.size).toBe(200);
});
test.each([401,403,404,410,422,429,500,503])('ticket error %i has no nested retry/fallback/compatibility bypass',async status=>{
 fetcher.mockResolvedValue(response({detail:{code:'track_unavailable',message:'secret?md5=canary'}},status));const negotiation=jest.fn(()=>true);
 await expect(resolver.resolve(ID,{consumeNegotiation:negotiation})).rejects.toMatchObject({status});expect(fetcher).toHaveBeenCalledTimes(1);expect(negotiation).not.toHaveBeenCalled();
});
test('definitive absent endpoint uses one consumed negotiation and scoped Bearer direct',async()=>{
 fetcher.mockResolvedValue(response({detail:'Not Found'},404));const consume=jest.fn(()=>true);const d=await resolver.resolve(ID,{consumeNegotiation:consume});
 expect(consume).toHaveBeenCalledTimes(1);expect(d).toMatchObject({delivery:'direct',cacheable:false,headers:{Authorization:'Bearer access'},uri:`https://api.test/api/stream/${ID}`});
});
test('unsupported delivery schema negotiates once with legacy request body',async()=>{
 fetcher.mockResolvedValueOnce(response({detail:[{loc:['body','delivery'],type:'extra_forbidden'}]},422)).mockResolvedValueOnce(response({url:`/api/stream/${ID}?mt=a.b.c`,expires_in:600,expires_at:2000000600}));
 await resolver.resolve(ID,{consumeNegotiation:()=>true});expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[1][1].body).toEqual({track_id:ID});
});
test('current priority cancels speculative permission acquisition; late completion cannot publish',async()=>{
 const gate=deferred();fetcher.mockImplementationOnce(()=>gate.promise).mockResolvedValueOnce(response(direct({url:`/api/stream/${B}?mt=a.b.c`})));
 const p=resolver.resolve(ID,{priority:'preload'});p.catch(()=>{});await ticks();const current=resolver.resolve(B);await current;await expect(p).rejects.toThrow();gate.resolve(response(ticket()));await ticks();expect([...resolver.cache.values()].some(v=>v.trackId===ID)).toBe(false);
});
test('late JSON after account/server/generation switch never commits',async()=>{
 const gate=deferred();fetcher.mockResolvedValue({ok:true,status:200,json:()=>gate.promise});const p=resolver.resolve(ID);p.catch(()=>{});await ticks();owner={...owner,userId:'99',generation:2};gate.resolve(ticket());await expect(p).rejects.toThrow();expect(resolver.cache.size).toBe(0);
});
test('non-cooperating canceled requests retain bounded lanes until actual completion',async()=>{
 jest.useFakeTimers();const gate=deferred();fetcher.mockImplementation(()=>gate.promise);
 const jobs=[];for(let i=0;i<8;i++){const p=resolver.resolve(`11111111-1111-4111-8111-${String(i).padStart(12,'0')}`);p.catch(()=>{});jobs.push(p);}
 await ticks();jest.advanceTimersByTime(3000);await Promise.allSettled(jobs);expect(resolver.running.size).toBe(8);
 await expect(resolver.resolve(B)).rejects.toMatchObject({code:'busy'});gate.resolve(response(direct()));await ticks();expect(resolver.running.size).toBe(0);
});
test('sanitized native/fetch error has no raw cause/URL/credential',async()=>{
 fetcher.mockRejectedValue(new Error('https://media.puuk.fun/audio?md5=CANARY Authorization: Bearer CANARY'));
 let error;try{await resolver.resolve(ID);}catch(e){error=e;}expect(JSON.stringify(error)+error.message).not.toContain('CANARY');expect(error.cause).toBeUndefined();
});

describe('actual authFetch transport/session integration',()=>{
 beforeEach(async()=>{setServerUrl('https://api.test');await setAuthToken('access-canary');await setSavedUser({id:17});global.fetch=jest.fn(async()=>response(direct()));});
 afterEach(async()=>{await logout();mediaDelivery.invalidate();});
 test('never reads credentials or fetches an external API destination',async()=>{
   const spy=jest.spyOn(SecureStore,'getItemAsync');await expect(authFetch('https://evil.test/api/media-ticket')).rejects.toThrow();expect(global.fetch).not.toHaveBeenCalled();expect(spy).not.toHaveBeenCalled();
 });
 test('actual transport honors retry:0 and redirects/error/omit for ticket request',async()=>{
   global.fetch.mockResolvedValue(response({},503));const r=new MediaDelivery();await expect(r.resolve(ID)).rejects.toMatchObject({status:503});expect(global.fetch).toHaveBeenCalledTimes(1);
   expect(global.fetch.mock.calls[0][1]).toMatchObject({redirect:'error',credentials:'omit',cache:'no-store',headers:{Authorization:'Bearer access-canary'}});
 });
 test('actual transport latency and JSON decoding share the 3s deadline even if fetch ignores abort',async()=>{
   jest.useFakeTimers();const gate=deferred();global.fetch.mockResolvedValue({ok:true,status:200,json:()=>gate.promise});const r=new MediaDelivery();const p=r.resolve(ID);p.catch(()=>{});await ticks();jest.advanceTimersByTime(3000);await expect(p).rejects.toMatchObject({code:'timeout'});gate.resolve(direct());await ticks();expect(r.cache.size).toBe(0);
 });
 test('SecureStore completion after logout cannot restore an old token',async()=>{
   await setAuthToken(null);const gate=deferred();jest.spyOn(SecureStore,'getItemAsync').mockImplementation(()=>gate.promise);
   const { restoreLocalSession } = require('../../shared/api/api');
   const p=restoreLocalSession();await ticks();await logout();gate.resolve('old-token');await expect(p).resolves.toMatchObject({hasToken:false,hasUser:false});expect(global.fetch).not.toHaveBeenCalled();
 });
 test('server switch after fetch cannot return the old response',async()=>{
   const gate=deferred();global.fetch.mockImplementation(()=>gate.promise);const p=authFetch('/api/media-ticket',{method:'POST',retry:0});await ticks();setServerUrl('https://other.test');gate.resolve(response(direct()));await expect(p).rejects.toMatchObject({type:'abort'});
 });
 test('offline session requires saved stable user and locally unexpired access token',async()=>{
   const jwt=exp=>`a.${Buffer.from(JSON.stringify({exp,sub:17})).toString('base64url')}.c`;
   await setAuthToken(jwt(Date.now()/1000+100));expect(hasOfflineSession()).toBe(true);
   await setAuthToken(jwt(Date.now()/1000-1));expect(hasOfflineSession()).toBe(false);
 });
});

describe('coordinator preserves the installed CDN source',()=>{
 let c,p,attempt,revision,position,intent,logicalStarts;
 const { PlaybackCoordinator }=require('../playbackCoordinator');
 const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
 function emit(nativeEvent,extra={}){const event={sourceIdentityVersion:1,sourceAttemptId:attempt,intentRevision:revision,nativeIntent:intent,nativeEvent,isLoaded:true,playing:intent==='play',currentTime:position,...extra};const result=c.handleNativeStatus(p,event);if(result.didStart)logicalStarts++;return result;}
 const sourceTicket=(id=ID)=>ticket({url:`https://media.puuk.fun/cdn/audio/${id}/${HASH}?md5=${'z'.repeat(22)}&expires=2000001800`});
 beforeEach(()=>{
  jest.useFakeTimers();attempt=null;revision=0;position=0;intent='pause';logicalStarts=0;
  fetcher.mockImplementation(async(_,o)=>response(o.body.delivery==='direct'?direct({url:`/api/stream/${o.body.track_id}?mt=a.b.c`}):sourceTicket(o.body.track_id)));
  resolver.clock=()=>performance.now();
  c=new PlaybackCoordinator({mediaDelivery:resolver,cache:{getCachedUri:()=>null},scheduler:{addListener:()=>()=>{},setPlaybackPressure:jest.fn(),cancelAll:jest.fn(),syncQueue:jest.fn()},clock:()=>performance.now(),bypassCache:true});
  p={puukSourceIdentityVersion:1,puukExpectedIntentVersion:1,
   get currentStatus(){return {sourceIdentityVersion:1,sourceAttemptId:attempt,nativeIntent:intent,intentRevision:revision};},
   replaceWithExpectedIntent:jest.fn((source,id,rev,old,expectedIntent)=>p.replaceWithAttempt(source,id,rev,old,expectedIntent)),
   replaceWithAttempt:jest.fn((source,id,rev,old,expectedIntent='play')=>{if(rev!==null&&(rev!==revision||old!==attempt||intent!==expectedIntent))return false;attempt=id;emit('loaded');return true;}),
   playForAttempt:jest.fn((id,rev)=>{if(id!==attempt||(rev!==null&&(rev!==revision||intent!=='play')))return false;intent='play';revision++;emit('intent');return true;}),
   seekForAttempt:jest.fn((id,target,rev)=>{if(id!==attempt||(rev!==null&&rev!==revision))return false;position=target;emit('seekIntent',{seekOrigin:rev===null?'user':'recovery',seekTargetSeconds:target});emit('seek',{seekOrigin:rev===null?'user':'recovery',seekCompleted:true});return true;}),
   pause:jest.fn(()=>{intent='pause';revision++;emit('intent');}),replace:jest.fn(),setActiveForLockScreen:jest.fn()};
 });
 afterEach(()=>c.destroy());
 async function start(id=ID){await c.play(p,{id,title:'Fixture',duration:100,normalization_gain_db:-3},{isUserSelection:true,headers:{Authorization:'CANARY',Cookie:'CANARY'}});position=12;emit('progress');}
 test('startup keeps the selected ticket when playback pressure cancels the scheduler', async () => {
   fetcher.mockImplementation(() => new Promise(resolve => {
     setTimeout(() => resolve(response(ticket({ cache_for: 0 }))), 500);
   }));
   const scheduler = new AbortController();
   const preload = resolver.resolve(ID, { priority: 'preload', signal: scheduler.signal });
   const cancelled = expect(preload).rejects.toMatchObject({ code: 'abort' });
   await jest.advanceTimersByTimeAsync(350);
   c.scheduler.setPlaybackPressure.mockImplementation(({ phase }) => {
     if (phase === 'startup') scheduler.abort();
   });
   const play = start();
   await cancelled;
   expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
   await jest.advanceTimersByTimeAsync(149);
   expect(p.replaceWithAttempt).not.toHaveBeenCalled();
   await jest.advanceTimersByTimeAsync(1);
   await play;
   expect(fetcher).toHaveBeenCalledTimes(1);
   expect(p.replaceWithAttempt.mock.calls[0][0].uri).toBe(cdn);
 });
 test('an almost-expired preload leaves time for a fresh playback request', async () => {
   const gate = deferred();
   fetcher.mockImplementationOnce(() => gate.promise);
   const preload = resolver.resolve(ID, { priority: 'preload' });
   const timeout = expect(preload).rejects.toMatchObject({ code: 'timeout' });
   await jest.advanceTimersByTimeAsync(2850);
   const play = start();
   await jest.advanceTimersByTimeAsync(150);
   await timeout;
   await play;
   expect(fetcher).toHaveBeenCalledTimes(2);
   expect(p.replaceWithAttempt).toHaveBeenCalledTimes(1);
   gate.resolve(response(ticket()));
 });
 test('switching tracks cancels a promoted ticket and ignores its late response', async () => {
   const gate = deferred();
   fetcher.mockImplementationOnce(() => gate.promise);
   const scheduler = new AbortController();
   const preload = resolver.resolve(ID, { priority: 'preload', signal: scheduler.signal });
   const cancelled = expect(preload).rejects.toMatchObject({ code: 'abort' });
   await flush();
   c.scheduler.setPlaybackPressure.mockImplementation(({ phase }) => {
     if (phase === 'startup') scheduler.abort();
   });
   const first = c.play(p, { id: ID }, { isUserSelection: true });
   await cancelled;
   await start(B);
   expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
   gate.resolve(response(ticket()));
   await expect(first).resolves.toMatchObject({ superseded: true });
   await flush();
   expect(p.replaceWithAttempt).toHaveBeenCalledTimes(1);
   expect(c._mediaDescriptor.trackId).toBe(B);
   expect([...resolver.cache.values()].map(value => value.trackId)).toEqual([B]);
 });
 test.each([503, 408, 401, 403, 404, 410])('native failure %i holds position without refreshing its ticket or seeking', async status => {
  await start();
  c.upNextQueue = [{ id: B }];
  const originalAttempt = attempt;
  emit('error', { error: { status } });
  await jest.advanceTimersByTimeAsync(180000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(p.replaceWithAttempt).toHaveBeenCalledTimes(1);
  expect(p.replaceWithAttempt.mock.calls[0][0].headers).toEqual({});
  expect(p.replace).not.toHaveBeenCalled();
  expect(p.seekForAttempt).not.toHaveBeenCalled();
  expect(c.current).toMatchObject({ status: 'error', positionSeconds: 12, sourceAttemptId: originalAttempt, error: { holdTrack: true } });
  expect(c.upNextQueue).toEqual([{ id: B }]);
  expect(logicalStarts).toBe(1);
 });
 test('A to B with late A ticket never replaces B, its descriptor or its attempt',async()=>{
  const gate=deferred();fetcher.mockImplementationOnce(()=>gate.promise);const a=c.play(p,{id:ID},{isUserSelection:true});a.catch(()=>{});await flush();await c.play(p,{id:B},{isUserSelection:true});const bAttempt=attempt;gate.resolve(response(ticket()));await a;await flush();expect(c.currentTrackId).toBe(B);expect(c._mediaDescriptor.trackId).toBe(B);expect(attempt).toBe(bAttempt);expect(p.replaceWithAttempt).toHaveBeenCalledTimes(1);
 });
 test('logout cancels pending tickets, unloads source and rejects old native events',async()=>{
  await start();const old=attempt;c.cancelCurrent('logout',p);expect(p.replace).toHaveBeenCalledWith(null);expect(p.setActiveForLockScreen).toHaveBeenCalledWith(false);expect(c.currentTrackId).toBeNull();expect(c.handleNativeStatus(p,{sourceIdentityVersion:1,sourceAttemptId:old,nativeEvent:'progress'}).accepted).toBe(false);
 });
 test('expired ticket does not replace the already installed item on resume', async () => {
  await start();
  await c.setIntent(p, { type: 'pause' });
  c._mediaDescriptor = { ...c._mediaDescriptor, usableUntil: 0 };
  await c.setIntent(p, { type: 'play' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(p.replaceWithAttempt).toHaveBeenCalledTimes(1);
  expect(p.seekForAttempt).not.toHaveBeenCalled();
  expect(c.current.positionSeconds).toBe(12);
 });
 test('foreground leaves the stream in place and explicit seek targets the same source', async () => {
  await start();
  const originalAttempt = attempt;
  c.foreground();
  await c.setIntent(p, { type: 'seek', positionSeconds: 40 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(p.replaceWithAttempt).toHaveBeenCalledTimes(1);
  expect(p.seekForAttempt).toHaveBeenCalledWith(originalAttempt, 40, null);
  expect(c.current.positionSeconds).toBe(40);
 });
});
test('a monotonic reset during request cannot extend or publish the capability',async()=>{
 const gate=deferred();fetcher.mockImplementation(()=>gate.promise);const p=resolver.resolve(ID);p.catch(()=>{});await ticks();now=0;gate.resolve(response(ticket()));await expect(p).rejects.toThrow();expect(resolver.cache.size).toBe(0);
});
test('a promoted request uses the current selection’s compatibility allowance', async () => {
  const gate = deferred();
  fetcher.mockImplementationOnce(() => gate.promise);
  const controller = new AbortController();
  const preload = resolver.resolve(ID, { priority: 'preload', signal: controller.signal });
  const cancelled = expect(preload).rejects.toMatchObject({ code: 'abort' });
  await ticks();
  const consumeNegotiation = jest.fn(() => true);
  const current = resolver.resolve(ID, { consumeNegotiation });
  controller.abort();
  await cancelled;
  gate.resolve(response({ detail: 'Not Found' }, 404));
  await expect(current).resolves.toMatchObject({ delivery: 'direct', legacy: true });
  expect(consumeNegotiation).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('looking for pending playback work requires an exact version, mode and owner', async () => {
  const gate = deferred();
  fetcher.mockImplementationOnce(() => gate.promise);
  const preload = resolver.resolve({ id: ID, content_version: HASH }, { priority: 'preload' });
  const cancelled = expect(preload).rejects.toMatchObject({ code: 'abort' });
  await ticks();
  const track = { id: ID, content_version: HASH };
  expect(resolver.resolve(ID, { pendingOnly: true })).toBeNull();
  expect(resolver.resolve(track, { mode: 'direct', pendingOnly: true })).toBeNull();
  owner = { ...owner, generation: 2 };
  expect(resolver.resolve(track, { pendingOnly: true })).toBeNull();
  gate.resolve(response(ticket()));
  await cancelled;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
