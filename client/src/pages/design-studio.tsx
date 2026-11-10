import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type Product, type Quote } from '@/lib/api';
import type { Design, DesignLayer, DesignSnapshot, PrintSettings, Side } from '@/lib/custom-print';
import { DesignCanvas } from '@/components/design-canvas';
import { Button } from '@/components/ui/button';
import { FileUpload } from '@/components/ui/file-upload';
import { useCart } from '@/context/cart';
import { money } from '@/lib/utils';
import { useAuth } from '@/context/auth';
import { useToast } from '@/context/toast';
import {POSITIONS,POSITION_LABEL,positionSide,type Position} from '@/lib/custom-print';

export default function DesignStudio() {
  const {id}=useParams(),[query]=useSearchParams(),navigate=useNavigate(),{user}=useAuth(),{addCustom}=useCart();
  const toast=useToast();
  const [product,setProduct]=useState<Product>(),[design,setDesign]=useState<Design>(),[snapshot,setSnapshot]=useState<DesignSnapshot>();
  const [title,setTitle]=useState('Thiết kế của tôi'),[side,setSide]=useState<Side>('front'),[selected,setSelected]=useState('');
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[preview,setPreview]=useState(false),[zoom,setZoom]=useState(1),[rights,setRights]=useState(false),[quality,setQuality]=useState(false),[quote,setQuote]=useState<Quote>();
  const saving=useRef<Promise<Design|undefined>|null>(null), generation=useRef(0);
  const latest=useRef({snapshot,title,design});latest.current={snapshot,title,design};
  const [uploading,setUploading]=useState(false);
  const [position,setPosition]=useState<Position>('FRONT');
  const designApi=user?'/api/designs':'/api/guest/designs';
  const [qty,setQty]=useState(1),[recovery,setRecovery]=useState<{snapshot:DesignSnapshot;title:string}>();
  const recoveryKey=`vela-editor:${user?.id}:${id||query.get('product')}`;
  useEffect(()=>{try{const data=sessionStorage.getItem(recoveryKey);if(data)setRecovery(JSON.parse(data));}catch{/* storage unavailable */}},[recoveryKey]);
  useEffect(()=>{if(snapshot&&dirty)try{sessionStorage.setItem(recoveryKey,JSON.stringify({snapshot,title}));}catch{/* keep current editor state */}},[snapshot,title,dirty,recoveryKey]);
  useEffect(()=>{let active=true;async function load(){
    try{if(!user)await api.printSession();if(id){const d=await api.get<Design>(`${designApi}/${id}`);const p=await api.get<Product>(`/api/products/${d.productId}`);if(query.get('job')){const job=await api.get<{workflowMode:string;settings:PrintSettings}>(`/api/print-jobs/${query.get('job')}`);if(job.workflowMode==='srs')d.revision.snapshot.settings=job.settings;}if(active){setDesign(d);setProduct(p);setSnapshot(d.revision.snapshot);setTitle(d.title);}}
    else{const p=await api.get<Product>(`/api/products/${query.get('product')}`),settings=await api.get<PrintSettings>(`/api/products/${p.id}/print-options`);if(!settings?.enabled)throw new Error('Sản phẩm chưa bật in');const variant=p.variants.find(v=>v.id===query.get('variant'))||p.variants[0];if(active){setProduct(p);setSnapshot({productId:p.id,variantId:variant.id,color:variant.color,size:variant.size,layers:{front:[],back:[]},settings});}}
    }catch(e){const message=(e as Error).message;setError(message);toast.error(message);}}
    load();return()=>{active=false;};},[id,query]);
  useEffect(()=>{const handler=(e:BeforeUnloadEvent)=>{if(dirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[dirty]);
  function change(next:DesignSnapshot){generation.current++;latest.current.snapshot=next;setSnapshot(next);setDirty(true);setQuote(undefined);setError('');}
  function save():Promise<Design|undefined>{
    if(saving.current)return saving.current;
    const {snapshot,title,design}=latest.current;
    if(!snapshot)return Promise.resolve(undefined);setBusy(true);const gen=generation.current;
    const task=(async()=>{
    try{const body={title,productId:snapshot.productId,variantId:snapshot.variantId,layers:snapshot.layers,version:design?.currentVersion,...(query.get('job')&&snapshot.settings.workflowMode==='srs'?{jobId:query.get('job')}:{})};
      const d=design?await api.patch<Design>(`${designApi}/${design.id}`,body):await api.post<Design>(designApi,body);
      latest.current.design=d;setDesign(d);if(gen===generation.current){setDirty(false);try{sessionStorage.removeItem(recoveryKey);}catch{}}setMessage('Đã lưu phiên bản '+d.currentVersion);setError('');toast.success(`Đã lưu phiên bản ${d.currentVersion}`);return d;
    }catch(e){const message=(e as Error).message+' Nội dung đang sửa vẫn được giữ trên màn hình.';setError(message);toast.error(message);return undefined;}
    finally{setBusy(false);}
    })();
    saving.current=task;void task.finally(()=>{if(saving.current===task)saving.current=null;});return task;
  }
  useEffect(()=>{if(!dirty||!design||busy)return;const timer=setTimeout(()=>void save(),1800);return()=>clearTimeout(timer);},[snapshot,title,dirty,busy,design?.id]);
  useEffect(()=>{if(!design||dirty)return;let active=true;api.post<Quote>('/api/orders/quote',{items:[{productId:design.productId,variantId:design.variantId,itemType:'custom',designRevisionId:design.revisionId,qualityAcknowledged:quality,qty:1}]}).then(q=>{if(active)setQuote(q);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[design,dirty,quality]);
  function update(item:DesignLayer){if(!snapshot)return;change({...snapshot,layers:{...snapshot.layers,[side]:snapshot.layers[side].map(l=>l.id===item.id?item:l)}});}
  function replaceAt(layers:DesignLayer[],layer:DesignLayer){return snapshot?.settings.workflowMode==='srs'?[...layers.filter(l=>(l.position||side.toUpperCase())!==layer.position),layer]:[...layers,layer];}
  function addText(){if(!snapshot)return;const layer:DesignLayer={id:crypto.randomUUID(),position,type:'text',text:'VELATHIER',font:snapshot.settings.supportedFonts?.[0]||'Arial',color:snapshot.settings.supportedColors?.[0]||'#111111',x:.5,y:.5,width:.8,height:.2,rotation:0};change({...snapshot,layers:{...snapshot.layers,[side]:replaceAt(snapshot.layers[side],layer)}});setSelected(layer.id);}
  async function upload(file:File){
    if(!snapshot)return false;if(!rights){const message='Vui lòng xác nhận quyền sử dụng ảnh';setError(message);toast.error(message);return false;}
    if(file.size>snapshot.settings.maxBytes||!(snapshot.settings.workflowMode==='srs'?['image/png','image/jpeg']:['image/png','image/jpeg','image/webp']).includes(file.type)){const message='Ảnh sai định dạng hoặc vượt dung lượng cho phép';setError(message);toast.error(message);return false;}
    const uploadSide=side,uploadPosition=position;setUploading(true);
    try{const d=await save();if(!d)return false;const body=new FormData();body.append('image',file);body.append('rightsConfirmed','true');const a=await api.post<{id:string;width:number;height:number;warning?:string}>(`${designApi}/${d.id}/assets`,body);
      const area=snapshot.settings.positions?.[uploadPosition]||snapshot.settings.areas[uploadSide];const ratio=a.height/a.width*area.widthMM/area.heightMM;
      const layer:DesignLayer={id:crypto.randomUUID(),position:uploadPosition,type:'image',assetId:a.id,x:.5,y:.5,width:Math.min(.8,.8/ratio),height:Math.min(.8,.8*ratio),rotation:0};const current=latest.current.snapshot;if(current)change({...current,layers:{...current.layers,[uploadSide]:replaceAt(current.layers[uploadSide],layer)}});setSelected(layer.id);if(a.warning){setMessage(a.warning);toast.info(a.warning);}else toast.success('Đã tải ảnh lên');
      return true;
    }catch(e){const message=(e as Error).message;setError(message);toast.error(message);return false;}finally{setUploading(false);}
  }
  async function toCart(){if(!product||!snapshot)return;const d=dirty||!design?await save():design;if(!d)return;setBusy(true);
    try{const q=await api.post<Quote>('/api/orders/quote',{items:[{productId:product.id,variantId:snapshot.variantId,itemType:'custom',designRevisionId:d.revisionId,qualityAcknowledged:quality,qty:1}]});
      addCustom({...product,img:d.revision.previewUrl||product.img},product.variants.find(v=>v.id===snapshot.variantId)!,d.revisionId,q.items[0].price,quality,qty,q.items[0].priceBreakdown?.positions?.map(p=>`${POSITION_LABEL[p.position as Position]}: ${p.contentType==='TEXT'?'chữ':'ảnh'}`).join(' · '));setMessage('Đã thêm mẫu in vào giỏ');toast.success('Đã thêm mẫu in vào giỏ');
    }catch(e){const message=(e as Error).message;setError(message);toast.error(message);}finally{setBusy(false);}}
  if(!snapshot||!product)return <div className="p-10" role="status">{error||'Đang mở studio…'}</div>;
  const item=snapshot.layers[side].find(l=>l.id===selected),variant=product.variants.find(v=>v.id===snapshot.variantId);
  const textError=item?.type==='text'&&snapshot.settings.workflowMode==='srs'&&[...(item.text||'').normalize('NFC')].length>(snapshot.settings.positions?.[item.position||position].maxChars||0)?`Nội dung vượt giới hạn ${snapshot.settings.positions?.[item.position||position].maxChars} ký tự của vị trí này.`:'';
  return <main className="mx-auto max-w-7xl space-y-6 px-5 py-10">
    <div className="flex flex-wrap justify-between gap-3"><div><p className="text-xs uppercase tracking-widest">VELATHIER / Custom studio</p><h1 className="mt-2 text-3xl font-bold">Thiết kế chiếc áo của bạn</h1><p>{product.title} · {snapshot.color} / {snapshot.size}</p></div><Link to="/designs" className="underline">Thiết kế của tôi</Link></div>
    {!user&&<p>Bạn đang thiết kế với tư cách khách. Xác minh email khi đặt hàng COD; phiên thiết kế được giữ trong 7 ngày trên trình duyệt này.</p>}
    {recovery&&<div className="rounded border p-3">Có bản chỉnh sửa chưa lưu trong tab này. <Button variant="outline" onClick={()=>{change(recovery.snapshot);setTitle(recovery.title);setRecovery(undefined);}}>Khôi phục nội dung</Button></div>}
    <p className="text-sm text-muted-foreground">1. Chọn màu/size và thêm ảnh hoặc chữ. 2. Chỉnh từng mặt trong vùng in; có thể nhập vị trí bằng bàn phím. 3. Lưu để kiểm tra chất lượng và giá trước khi thêm giỏ.</p>
    <div className="grid grid-cols-1 items-start gap-7 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="min-w-0 space-y-3"><div className="flex flex-wrap gap-2">{(snapshot.settings.workflowMode==='srs'?POSITIONS:['FRONT','BACK'] as Position[]).map(p=><Button key={p} variant={position===p?'default':'outline'} onClick={()=>{setPosition(p);setSide(positionSide(p));setSelected(snapshot.layers[positionSide(p)].find(l=>(l.position||positionSide(p).toUpperCase())===p)?.id||'');}}>{POSITION_LABEL[p]}</Button>)}<Button variant="outline" onClick={()=>setPreview(!preview)}>{preview?'Chỉnh sửa':'Xem trước'}</Button><label>Zoom <select value={zoom} onChange={e=>setZoom(Number(e.target.value))}><option value={1}>100%</option><option value={1.5}>150%</option></select></label></div>
        <DesignCanvas snapshot={snapshot} side={side} editable={!preview&&!busy} guides={!preview} selected={selected} onSelect={setSelected} onChange={update} zoom={zoom}/>
        <p className="text-xs text-muted-foreground">Mockup minh họa. Màu mực và chất vải thực tế có thể khác nhẹ. Giữ toàn bộ thiết kế trong đường viền vàng.</p>
      </section>
      <aside className="space-y-4 rounded-xl border p-5">
        <label className="block">Tên bản nháp<input className="mt-1 w-full rounded border p-2" value={title} maxLength={80} onChange={e=>{setTitle(e.target.value);setDirty(true);generation.current++;}}/></label>
        <label className="block">Màu / size<select className="mt-1 w-full rounded border p-2" value={snapshot.variantId} onChange={e=>{const v=product.variants.find(v=>v.id===e.target.value)!;change({...snapshot,variantId:v.id,color:v.color,size:v.size});}}>{product.variants.map(v=><option key={v.id} value={v.id}>{v.color} / {v.size}{v.stock?'':' — hết hàng'}</option>)}</select></label>
        <Button variant="outline" onClick={addText} disabled={busy||!(snapshot.settings.positions?.[position]||snapshot.settings.areas[side]).enabled}>{snapshot.settings.workflowMode==='srs'?'Thêm / thay bằng chữ':'Thêm chữ'}</Button>
        {snapshot.settings.workflowMode==='srs'&&<p className="text-sm">Mỗi vị trí một nội dung. {POSITION_LABEL[position]}: tối đa {snapshot.settings.positions?.[position].maxChars} ký tự. Chọn ảnh để thay nội dung hiện tại.</p>}
        {textError&&<p role="alert" className="text-red-700">{textError}</p>}
        {item?.type==='text'&&snapshot.settings.workflowMode==='srs'&&<label className="block">Cỡ chữ (8–72)<input aria-label="Cỡ chữ" className="ml-2 w-20 border p-2" type="number" min={8} max={72} value={item.fontSize||32} onChange={e=>update({...item,fontSize:Number(e.target.value)})}/></label>}
        <div className="space-y-3 border-t border-border/70 pt-4">
          <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">Ảnh thiết kế</h2><span className="rounded-full bg-secondary px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{POSITION_LABEL[position]}</span></div>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-secondary/60 p-3 text-xs leading-relaxed"><input className="mt-0.5 size-4 shrink-0 accent-foreground" type="checkbox" checked={rights} onChange={e=>setRights(e.target.checked)}/>Tôi có quyền hoặc được cho phép sử dụng ảnh tải lên.</label>
          <FileUpload key={position} accept={snapshot.settings.workflowMode==='srs'?'image/png,image/jpeg':'image/png,image/jpeg,image/webp'} maxBytes={snapshot.settings.maxBytes} disabled={!rights} uploading={uploading} hint={snapshot.settings.workflowMode==='srs'?'Cạnh ngắn từ 500 px · Nên dùng ảnh từ 1000 px':undefined} onChange={upload}/>
        </div>
        {item&&<div className="space-y-2 border-t pt-3"><b>Lớp đang chọn</b>{item.type==='text'&&<><input aria-label="Nội dung chữ" className="w-full border p-2" value={item.text} onChange={e=>update({...item,text:e.target.value})}/><select aria-label="Font" value={item.font} onChange={e=>update({...item,font:e.target.value})}>{(snapshot.settings.supportedFonts||['Arial','Georgia','Courier New']).map(f=><option key={f}>{f}</option>)}</select><select aria-label="Màu chữ" value={item.color} onChange={e=>update({...item,color:e.target.value})}>{['#111111','#ffffff','#b91c1c','#1d4ed8','#15803d','#eab308'].map((c,i)=><option key={c} value={c}>{['Đen','Trắng','Đỏ','Xanh dương','Xanh lá','Vàng'][i]}</option>)}</select></>}
          {(['x','y','width','height','rotation'] as const).map(key=><label key={key} className="flex items-center justify-between text-sm">{{x:'Vị trí ngang',y:'Vị trí dọc',width:'Rộng',height:'Cao',rotation:'Góc xoay'}[key]}<input className="w-24 border p-1" type="number" step={key==='rotation'?1:.01} value={Math.round(item[key]*100)/100} onChange={e=>update({...item,[key]:Number(e.target.value)})}/></label>)}
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={()=>update({...item,x:.5,y:.5})}>Căn giữa</Button><Button size="sm" variant="outline" onClick={()=>update({...item,x:.5,y:.5,width:.5,height:.2,rotation:0})}>Đặt lại</Button><Button size="sm" variant="outline" onClick={()=>{change({...snapshot,layers:{...snapshot.layers,[side]:snapshot.layers[side].filter(l=>l.id!==item.id)}});setSelected('');}}>Xóa lớp</Button></div>
        </div>}
        {snapshot.settings.workflowMode==='srs'?<p className="text-xs">Ảnh 500–999 px được chấp nhận kèm cảnh báo. DPI vật lý là khuyến nghị để nhân viên kiểm tra, không tự tăng ngưỡng từ chối của SRS.</p>:<label className="flex gap-2 text-sm"><input type="checkbox" checked={quality} onChange={e=>setQuality(e.target.checked)}/>Tôi chấp nhận cảnh báo ảnh dưới DPI khuyến nghị; ảnh dưới mức tối thiểu vẫn bị chặn.</label>}
        <Link className="block text-sm underline" to={`/product/${product.id}`}>Hủy tùy chỉnh — quay lại mua áo không in</Link>
        <label className="block">Số lượng<input className="ml-2 w-20 rounded border p-2" type="number" min={1} max={Math.min(20,variant?.stock||1)} value={qty} onChange={e=>setQty(Math.max(1,Math.min(20,variant?.stock||1,Number(e.target.value)||1)))}/></label>
        <div aria-live="polite" className="rounded bg-secondary p-3 text-sm">{quote?<><p>Giá áo: {money(product.price)}</p><p>Phí in: {money(quote.items[0].price-product.price)}</p><b>Tạm tính {qty} áo: {money(quote.items[0].price*qty)}</b></>:<><p>Ước tính: {money((product.price+(snapshot.settings.workflowMode==='srs'?Object.values(snapshot.layers).flat().reduce((sum,l)=>sum+(l.type==='text'?snapshot.settings.positions![l.position!].textRate:snapshot.settings.positions![l.position!].imageRate),0):(snapshot.layers.front.length?snapshot.settings.areas.front.fee:0)+(snapshot.layers.back.length?snapshot.settings.areas.back.fee:0)))*qty)}</p><p>Lưu thiết kế để server kiểm tra DPI và báo giá.</p></>}</div>
        {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}<p role="status" className="text-sm">{dirty?'Có thay đổi chưa lưu':message}</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={()=>void save()}>{busy?'Đang lưu…':'Lưu bản nháp'}</Button><Button disabled={busy||!variant?.stock||!quote||dirty} onClick={()=>void toCart()}>Thêm vào giỏ</Button></div>
        {query.get('job')&&design&&<Button variant="outline" disabled={dirty||busy} onClick={async()=>{try{await api.post(`/print-jobs/${query.get('job')}/revision`.replace('/print-jobs','/api/print-jobs'),{designRevisionId:design.revisionId,reason:'Khách gửi phiên bản đã chỉnh sửa'});toast.success('Đã gửi lại thiết kế cho nhân viên duyệt');navigate('/orders');}catch(e){const message=(e as Error).message;setError(message);toast.error(message);}}}>Gửi lại cho nhân viên duyệt</Button>}
      </aside>
    </div>
  </main>;
}
