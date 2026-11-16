import { fetchShareEntity, resolveShareUrl, validateShareResponse } from '../share';
import { setServerUrl, setAuthToken, setSavedUser, logout } from '../api';
const ID='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const entity={id:ID,share_id:ID,title:'Fixture',artist:'Fixture',content_version:null};
const dto=changes=>({type:'track',requested_id:ID,canonical_id:ID,canonical_path:`/track/${ID}`,entity,tracks:[entity],albums:[],...changes});
const response=(data,status=200)=>({ok:status===200,status,json:async()=>data});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function ticks(){for(let i=0;i<15;i++)await Promise.resolve();}
beforeEach(async()=>{setServerUrl('https://api.test');await setAuthToken('access-canary');await setSavedUser({id:17});global.fetch=jest.fn(async()=>response(dto()));});
afterEach(async()=>{jest.useRealTimers();await logout();jest.restoreAllMocks();});
test('real authFetch uses finite one-shot resolver and validates entity/request/canonical path',async()=>{
 const result=await fetchShareEntity('track',ID);expect(result).toEqual(dto());expect(global.fetch).toHaveBeenCalledTimes(1);
 expect(global.fetch.mock.calls[0][0]).toBe(`https://api.test/api/share/track/${ID}`);expect(global.fetch.mock.calls[0][1]).toMatchObject({cache:'no-store',redirect:'error',credentials:'omit'});
});
test.each([{type:'album'},{requested_id:B},{canonical_id:B},{canonical_path:`/track/${B}`},{canonical_path:`https://evil.test/track/${ID}`},{entity:{...entity,share_id:B}},{tracks:[]},{tracks:[{...entity,share_id:B}]},{albums:[{id:1,share_id:'1'}]}])('rejects mismatched returned DTO (%#)',async changes=>{
 global.fetch.mockResolvedValue(response(dto(changes)));await expect(fetchShareEntity('track',ID)).rejects.toMatchObject({code:'invalid_response'});
});
test('same-type alias can resolve to a different valid canonical entity',()=>{
 const e={...entity,id:B,share_id:B};expect(validateShareResponse(dto({canonical_id:B,canonical_path:`/track/${B}`,entity:e,tracks:[e]}),'track',ID).entity.share_id).toBe(B);
});
test('lossless maximum signed64 album ID is preserved as string',async()=>{
 const id='9223372036854775807';global.fetch.mockResolvedValue(response({type:'album',requested_id:id,canonical_id:id,canonical_path:`/album/${id}`,entity:{id:9223372036854775807,share_id:id,title:'Fixture'},tracks:[],albums:[]}));
 expect((await fetchShareEntity('album',id)).canonical_id).toBe(id);
});
test.each([['album','01'],['album','9223372036854775808'],['album',9007199254740992],['track','abcdef11-1111-4111-8111-111111111111'.toUpperCase()],['artist','Radiohead']])('rejects invalid input before network %s/%s',async(type,id)=>{
 await expect(fetchShareEntity(type,id)).rejects.toThrow();expect(global.fetch).not.toHaveBeenCalled();
});
test.each([401,403,404,410,422,429,500,503])('real transport does not retry HTTP %i or expose raw detail',async status=>{
 global.fetch.mockResolvedValue(response({detail:{message:'CANARY https://media.puuk.fun/?md5=CANARY'}},status));let error;try{await fetchShareEntity('track',ID);}catch(e){error=e;}
 expect(global.fetch).toHaveBeenCalledTimes(1);expect(error.status).toBe(status);expect(error.message+JSON.stringify(error)).not.toContain('CANARY');expect(error.cause).toBeNull();
});
test('five-second deadline includes JSON even if actual fetch ignores abort',async()=>{
 jest.useFakeTimers();const gate=deferred();global.fetch.mockResolvedValue({ok:true,status:200,json:()=>gate.promise});const p=fetchShareEntity('track',ID);p.catch(()=>{});await ticks();jest.advanceTimersByTime(5000);await expect(p).rejects.toMatchObject({code:'timeout'});gate.resolve(dto());await ticks();expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('five-second deadline includes actual transport that ignores abort',async()=>{
 jest.useFakeTimers();const gate=deferred();global.fetch.mockImplementation(()=>gate.promise);const p=fetchShareEntity('track',ID);p.catch(()=>{});await ticks();jest.advanceTimersByTime(5000);await expect(p).rejects.toMatchObject({code:'timeout'});gate.resolve(response(dto()));await ticks();expect(global.fetch).toHaveBeenCalledTimes(1);
});
test.each(['logout','server','cancel'])('late JSON after %s is discarded',async mode=>{
 const gate=deferred(),controller=new AbortController();global.fetch.mockResolvedValue({ok:true,status:200,json:()=>gate.promise});const p=fetchShareEntity('track',ID,{signal:controller.signal});p.catch(()=>{});await ticks();
 if(mode==='logout') await logout();else if(mode==='server')setServerUrl('https://other.test');else controller.abort();gate.resolve(dto());await expect(p).rejects.toMatchObject({code:'abort'});
});
test('invalid URL/error/native reporting never echoes arbitrary secret-bearing input',async()=>{
 const input='https://evil.test/?md5=CANARY&token=CANARY';let error;try{await resolveShareUrl(input);}catch(e){error=e;}expect(error.message+JSON.stringify(error)).not.toContain('CANARY');expect(global.fetch).not.toHaveBeenCalled();
});
test('filters filesystem/provenance/editor/permission fields from returned catalog metadata',async()=>{
 global.fetch.mockResolvedValue(response(dto({entity:{...entity,file_path:'/secret/file',stream_url:'?mt=CANARY',headers:{Authorization:'CANARY'}}})));
 const result=await fetchShareEntity('track',ID);expect(JSON.stringify(result)).not.toMatch(/secret|CANARY|file_path|stream_url|headers/);
});
