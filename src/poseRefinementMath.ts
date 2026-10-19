// 确定性的有界阻尼最小二乘；不改变离散身份、支撑和关节分支。
export function boundedLeastSquares(initial:number[], evaluate:(x:number[])=>number[], options:{bounds:Array<[number,number]>;steps:number[];iterations?:number}) {
 const score=(r:number[])=>r.every(Number.isFinite)?r.reduce((s,v)=>s+v*v,0):Infinity;
 const clamp=(x:number[])=>x.map((v,i)=>Math.max(options.bounds[i][0],Math.min(options.bounds[i][1],v)));
 let x=clamp([...initial]),r=evaluate(x),cost=score(r),lambda=.01;
 const history:any[]=[{iteration:0,cost}],limit=Math.min(60,options.iterations??60);let reason='iterationLimit',attempted=0;
 for(let iter=0;iter<limit;iter++){
  attempted=iter+1;
  const jac=x.map((_,j)=>{const h=options.steps[j],v=[...x];v[j]=Math.min(options.bounds[j][1],x[j]+h);if(v[j]===x[j])v[j]=Math.max(options.bounds[j][0],x[j]-h);const d=v[j]-x[j],q=evaluate(v);return r.map((a,i)=>d?(q[i]-a)/d:0);});
  const n=x.length,A=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>jac[i].reduce((s,v,k)=>s+v*jac[j][k],0)+(i===j?lambda:0))),b=jac.map(col=>-col.reduce((s,v,k)=>s+v*r[k],0));
  // 带主元消去，奇异情况交给阻尼重试，不返回随机方向。
  for(let i=0;i<n;i++){let pivot=i;for(let j=i+1;j<n;j++)if(Math.abs(A[j][i])>Math.abs(A[pivot][i]))pivot=j;[A[i],A[pivot]]=[A[pivot],A[i]];[b[i],b[pivot]]=[b[pivot],b[i]];if(Math.abs(A[i][i])<1e-14)continue;for(let j=i+1;j<n;j++){const f=A[j][i]/A[i][i];for(let k=i;k<n;k++)A[j][k]-=f*A[i][k];b[j]-=f*b[i];}}
  const delta=Array(n).fill(0);for(let i=n-1;i>=0;i--)if(Math.abs(A[i][i])>=1e-14)delta[i]=(b[i]-A[i].slice(i+1).reduce((s,v,j)=>s+v*delta[i+j+1],0))/A[i][i];
  let accepted=false;
  for(let step=1;step>=1/128;step/=2){const candidate=clamp(x.map((v,i)=>v+step*delta[i])),q=evaluate(candidate),next=score(q);if(next<cost-1e-10){x=candidate;r=q;cost=next;lambda=Math.max(1e-6,lambda*.5);accepted=true;history.push({iteration:iter+1,cost,step});break;}}
  if(!accepted){lambda*=10;if(lambda>1e8){reason='localStall';break;}}
  if(cost<1e-10){reason='converged';break;}
 }
 return {x,residuals:r,cost,history,reason,iterations:attempted,acceptedSteps:history.length-1,attemptLimit:limit};
}
