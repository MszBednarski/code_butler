export type DemoWebsiteFeatures = {
  colorful?: boolean;
  touchControls?: boolean;
  sunset?: boolean;
};

export function horseDemoWebsite(features: DemoWebsiteFeatures | boolean = {}) {
  const {
    colorful = false,
    touchControls = false,
    sunset = false,
  } = typeof features === "boolean" ? { colorful: features } : features;
  const featureLabel = touchControls
    ? "PHONE FRIENDLY CONTROLS"
    : sunset
      ? "SUNSET SESSIONS"
      : colorful
        ? "COLOURFUL FENCES"
        : "A LITTLE LEAP OF FAITH";
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:system-ui,sans-serif;color:#234334;background:#deeee1}
canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;outline:none}header{position:absolute;z-index:1;top:0;left:0;right:0;padding:15px 18px;display:flex;align-items:center;justify-content:space-between;pointer-events:none}
h1{font-size:20px;letter-spacing:-.8px;margin:0}header small{font-size:8px;letter-spacing:1.8px;font-weight:700;color:#6f8c73;display:block;margin-bottom:3px}.score{background:#ffffffbd;border:1px solid #fff;border-radius:10px;padding:7px 11px;text-align:center;font-size:9px;min-width:58px}.score b{font-size:21px;display:block;line-height:1.1}
#overlay{position:absolute;z-index:2;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;padding:25px}.card{pointer-events:auto;text-align:center;background:#fffdf4ef;border:1px solid #fff;border-radius:16px;padding:20px 24px;box-shadow:0 12px 35px #244e3320;max-width:275px}.card h2{font-family:Georgia,serif;font-weight:400;font-size:31px;letter-spacing:-1px;line-height:1.1;margin:0 0 10px}.card p{font-size:11px;line-height:1.7;color:#708169;margin:0 0 13px}
button{font:600 12px system-ui,sans-serif;background:#254f3a;color:#fff;border:0;border-radius:8px;padding:11px 18px;cursor:pointer;touch-action:manipulation}button:focus-visible{outline:3px solid #dda962;outline-offset:3px}#overlay[hidden]{display:none}footer{position:absolute;bottom:10px;left:12px;right:12px;display:flex;justify-content:space-between;gap:8px;font-size:9px;font-weight:600;color:#48673e;pointer-events:none}#best{font-weight:400;color:#647d59}
#jump{position:absolute;z-index:1;bottom:32px;left:50%;transform:translateX(-50%);width:min(230px,70%);background:#dce9f6;color:#234e6a;border:2px solid #fff;box-shadow:0 4px 15px #234e6a20;font-size:14px;padding:12px 18px}
</style></head><body>
<canvas id="game" tabindex="0" aria-label="Horse showjumping game. Tap or press Space to jump over fences.">Tap or press Space to help the horse jump over the fences.</canvas>
<header><div><small>${featureLabel}</small><h1>Jump Club</h1></div><div class="score">JUMPS<b id="score" aria-live="polite">0</b></div></header>
<div id="overlay"><div class="card"><h2 id="message">Ready, rider?</h2><p id="hint">Tap or press Space to hop.<br>Keep hopping to clear the fences.</p><button id="start">Let’s jump →</button></div></div>
${touchControls ? '<button id="jump" aria-label="Tap to jump">Tap to jump ↑</button>' : ""}
<footer><span id="status" role="status">Tap or Space to jump</span><span id="best">Best this visit: 0</span></footer>
<script>
(()=>{
 const colorful=${JSON.stringify(colorful)},sunset=${JSON.stringify(sunset)},canvas=document.getElementById('game'),ctx=canvas.getContext('2d');
 const overlay=document.getElementById('overlay'),scoreLabel=document.getElementById('score'),status=document.getElementById('status'),bestLabel=document.getElementById('best');
 let width=400,height=340,ground=280,x=95,y=280,velocity=0,mode='ready',fences=[],score=0,best=0,clock=0,last=0,travel=0,spawn=0,flash=0;
 function resize(){const rect=canvas.getBoundingClientRect(),oldGround=ground;width=rect.width;height=rect.height;ground=height-52;x=Math.min(112,width*.25);y=Math.min(y+ground-oldGround,ground);const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);}
 new ResizeObserver(resize).observe(canvas);resize();
 function start(){mode='playing';score=0;fences=[];y=ground;velocity=0;spawn=1.5;travel=0;scoreLabel.textContent='0';overlay.hidden=true;}
 function hop(){if(mode!=='playing')start();velocity=-355;flash=.35;status.textContent='Jump!';}
 canvas.addEventListener('pointerdown',event=>{event.preventDefault();canvas.focus({preventScroll:true});hop();});
 document.getElementById('jump')?.addEventListener('click',hop);
 document.getElementById('start').addEventListener('click',()=>{canvas.focus({preventScroll:true});hop();});
 window.addEventListener('keydown',event=>{if(['Space','ArrowUp'].includes(event.code)){event.preventDefault();if(!event.repeat)hop();}});
 document.addEventListener('visibilitychange',()=>{last=0;});
 function finish(){mode='over';best=Math.max(best,score);bestLabel.textContent='Best this visit: '+best;document.getElementById('message').textContent='One more little leap?';document.getElementById('hint').textContent='You cleared '+score+' fence'+(score===1?'':'s')+'. Tap a little earlier to give your horse room to jump.';document.getElementById('start').textContent='Try again →';status.textContent='Clipped a fence!';overlay.hidden=false;}
 function hill(base,color,shift){ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(0,base);for(let at=-80;at<width+90;at+=12)ctx.lineTo(at,base-20*Math.sin((at+shift)/130)-9*Math.sin((at+shift)/57));ctx.lineTo(width,height);ctx.lineTo(0,height);ctx.fill();}
 function fence(f){
  const top=ground-f.h,rail=colorful?['#d77e64','#738fbd','#d5ab55'][f.variant%3]:'#b18f67';
  ctx.fillStyle='#65815420';ctx.beginPath();ctx.ellipse(f.x+19,ground+4,36,5,0,0,Math.PI*2);ctx.fill();
  for(const at of [f.x,f.x+40]){ctx.fillStyle=colorful?'#f9f6e8':'#d3bc99';ctx.fillRect(at-3,top-10,6,f.h+10);ctx.fillStyle=rail;ctx.fillRect(at-6,top-13,12,5);if(colorful){ctx.strokeStyle='#738366';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(at,top-12);ctx.lineTo(at,top-30);ctx.stroke();ctx.fillStyle=rail;ctx.beginPath();ctx.moveTo(at,top-30);ctx.lineTo(at+14,top-25);ctx.lineTo(at,top-20);ctx.fill();}}
  for(const level of [top,top+18]){ctx.fillStyle=rail;ctx.fillRect(f.x,level,40,6);if(colorful){ctx.fillStyle='#fffaf0';ctx.fillRect(f.x+8,level,8,6);ctx.fillRect(f.x+25,level,8,6);}}
 }
 function horse(){
  ctx.save();ctx.translate(x,y);ctx.rotate(Math.max(-.13,Math.min(.12,velocity/2700)));
  const running=y>=ground-2;ctx.translate(0,running?Math.sin(clock*15)*1.5:0);ctx.lineCap='round';ctx.lineJoin='round';
  ctx.strokeStyle='#573d2e';ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(-24,-37);ctx.bezierCurveTo(-40,-48,-29,-21,-40,-25+Math.sin(clock*9)*3);ctx.stroke();
  for(let leg=0;leg<4;leg++){const base=leg<2?-16:15,swing=running?Math.sin(clock*15+leg*2)*9:(leg<2?-8:8);ctx.strokeStyle=leg%2?'#a86a43':'#875337';ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(base,-25);ctx.lineTo(base+swing,-13);ctx.lineTo(base-swing*.5,running?0:-6);ctx.stroke();ctx.strokeStyle='#463c32';ctx.beginPath();ctx.moveTo(base-swing*.5,running?0:-6);ctx.lineTo(base-swing*.5+4,running?0:-6);ctx.stroke();}
  ctx.fillStyle='#ad7048';ctx.beginPath();ctx.ellipse(-3,-35,26,14,0,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(10,-38);ctx.lineTo(19,-65);ctx.lineTo(29,-62);ctx.lineTo(24,-30);ctx.closePath();ctx.fill();
  ctx.fillStyle='#523d2e';ctx.beginPath();ctx.moveTo(18,-65);ctx.lineTo(12,-40);ctx.lineTo(17,-36);ctx.lineTo(23,-64);ctx.fill();
  ctx.fillStyle='#b97c51';ctx.beginPath();ctx.ellipse(29,-62,13,8,-.25,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.ellipse(38,-59,8,5,.2,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(21,-68);ctx.lineTo(19,-78);ctx.lineTo(26,-70);ctx.moveTo(27,-69);ctx.lineTo(30,-78);ctx.lineTo(33,-69);ctx.fill();
  ctx.strokeStyle='#f5e8cf';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(31,-67);ctx.lineTo(38,-61);ctx.stroke();ctx.fillStyle='#302e28';ctx.beginPath();ctx.arc(28,-65,1.5,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#efe6c7';ctx.fillRect(-12,-45,21,16);ctx.fillStyle='#315345';ctx.beginPath();ctx.ellipse(-2,-44,12,5,0,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#375844';ctx.beginPath();ctx.moveTo(-6,-47);ctx.lineTo(-3,-61);ctx.lineTo(7,-60);ctx.lineTo(12,-48);ctx.fill();ctx.fillStyle='#ebc7a2';ctx.beginPath();ctx.arc(3,-68,6,0,Math.PI*2);ctx.fill();ctx.fillStyle='#2b4939';ctx.beginPath();ctx.arc(3,-70,6,Math.PI,0);ctx.fill();ctx.fillRect(0,-70,11,2);
  ctx.strokeStyle='#394d36';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(6,-53);ctx.lineTo(34,-59);ctx.stroke();ctx.restore();
 }
 function draw(){
  const sky=ctx.createLinearGradient(0,0,0,height);sky.addColorStop(0,sunset?'#c7b1d2':'#d9ece5');sky.addColorStop(1,sunset?'#f6c397':'#f2edcb');ctx.fillStyle=sky;ctx.fillRect(0,0,width,height);
  ctx.fillStyle='#fff9df';ctx.beginPath();ctx.arc(width*.76,79,26,0,Math.PI*2);ctx.fill();ctx.fillStyle='#ffffff75';for(let n=0;n<3;n++){const at=((n*190+65-travel*.12)%(width+170)+width+170)%(width+170)-60;ctx.beginPath();ctx.ellipse(at,92+n*17,36,9,0,0,Math.PI*2);ctx.fill();}
  hill(ground-45,sunset?'#ad9da9':'#b8d1b0',travel*.14);hill(ground-20,sunset?'#7e9b86':'#9fbd8a',travel*.3);ctx.fillStyle='#f5f1da';ctx.fillRect(0,ground-20,width,3);for(let at=-travel*.5%65;at<width;at+=65)ctx.fillRect(at,ground-31,3,34);
  ctx.fillStyle='#c4d499';ctx.fillRect(0,ground,width,height-ground);ctx.fillStyle='#a4ba79';ctx.fillRect(0,ground,width,4);ctx.fillStyle='#91aa66';for(let n=0;n<width/24+3;n++){const at=(n*27-travel)%(width+54);ctx.fillRect(at,ground+15+(n%3)*8,6,2);}
  ctx.fillStyle='#49663824';ctx.beginPath();ctx.ellipse(x+3,ground+5,26,5,0,0,Math.PI*2);ctx.fill();(mode==='ready'?[{x:width*.69,h:45,variant:0},{x:width+10,h:50,variant:1}]:fences).forEach(fence);horse();
 }
 function frame(time){
  const dt=last?Math.min((time-last)/1000,.035):0;last=time;
  if(!document.hidden){clock+=dt;
   if(mode==='playing'){
    const speed=145+Math.min(score*3,50);travel+=speed*dt;velocity+=940*dt;y+=velocity*dt;if(y>=ground){y=ground;velocity=0;}if(y<125){y=125;velocity=Math.max(0,velocity);}
    spawn-=dt;if(spawn<=0){fences.push({x:width+30,h:43+Math.min(score*2,17),variant:score%3,passed:false});spawn=1.65;}
    for(const f of fences){f.x-=speed*dt;if(!f.passed&&f.x+45<x-24){f.passed=true;score++;scoreLabel.textContent=score;status.textContent='Clean jump!';flash=.7;}if(f.x<x+30&&f.x+42>x-24&&y>ground-f.h+6){finish();break;}}
    fences=fences.filter(f=>f.x>-70);flash-=dt;if(flash<=0)status.textContent='Tap or Space to jump';
   }
   draw();
  }
  requestAnimationFrame(frame);
 }
 requestAnimationFrame(frame);
})();
</script></body></html>`;
}
