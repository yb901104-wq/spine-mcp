import sys,json,math
sys.path.insert(0,sys.argv[1])
from spine_tools import *
root=Path(sys.argv[1]); result={}
for folder,name in [('npc1_walk','walk'),('npc1_explore_run','explore-run')]:
 d=read(root/'输出'/folder/'npc1.json'); a=d['animations'][name]; duration=1.2 if name=='walk' else .6667; error=0
 for i in range(73 if name=='walk' else 41):
  t=duration*i/(72 if name=='walk' else 40); parts=geometry(d,a,t); names=['yt2','zt2'] if name=='walk' else ['yt1','yt2','zt1','zt2']; low=min(p[:,1].min() for n,p,u,tr in parts if n in names); wanted=0 if name=='walk' else 12*(.5+.5*math.cos(4*math.pi*t/duration))**2; error=max(error,abs(low-wanted))
 assert error<.001; result[name]={'maximum_foot_error':error}
d=read(root/'输出'/'npc1_idle_tween'/'npc1.json'); old=read(root/'输出'/'npc1_idle_reference'/'npc1.json'); a=d['animations']['idle-reference']; oa=old['animations']['idle-reference']; mr=mt=mv=0
for t in np.linspace(0,2.79,337):
 for n,tl in a['bones'].items():
  mr=max(mr,abs(sample(tl['rotate'],t,'value')-sample(oa['bones'][n]['rotate'],t,'value')))
  for k in ['x','y']: mt=max(mt,abs(sample(tl['translate'],t,k)-sample(oa['bones'][n]['translate'],t,k)))
 for (_,p,_,_),(_,op,_,_) in zip(geometry(d,a,float(t)),geometry(old,oa,float(t))): mv=max(mv,float(np.linalg.norm(p-op,axis=1).max()))
assert mr<.35 and mt<.09 and mv<1.2
result['idle-reference']={'rotation':mr,'translation':mt,'vertices':mv}; print(json.dumps(result))
