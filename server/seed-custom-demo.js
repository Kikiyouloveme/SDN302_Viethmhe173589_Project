require('./config');
const db=require('./db');
const cp=require('./custom-print');
const {migrate}=require('./migrate-custom-print');
const orders=require('./controllers/orders');
const admin=require('./controllers/admin');
const config=require('./config');
const response=()=>({value:null,status(){return this;},json(value){this.value=value;return this;}});
async function seedDemo(){
  if(config.isProd||require('./vnpay').isLive()||require('./mailer').isLive())throw Error('Demo chỉ chạy development, VNPay sandbox và email outbox. Không tạo sự kiện demo trong hệ thống live.');
  await migrate();
  const buyer=db.users.byId('u_demo'),staff=db.users.byId('u_staff');
  if(!buyer||!staff)throw Error('Thiếu tài khoản demo gốc. Dùng seed trên database demo trống; không reset DB hiện tại.');
  const p=db.products.byId('blank-regular'),variant=p.variants[0];
  const draftBody={productId:p.id,variantId:variant.id,title:'Demo — mẫu chữ VELATHIER',layers:{front:[{id:'demo-title',type:'text',text:'VELATHIER',font:'Arial',color:'#111111',x:.5,y:.5,width:.7,height:.15,rotation:0}],back:[]}};
  let design=cp.all('designs').find(d=>d.demoKey==='custom-print-v1');
  if(!design){const created=cp.saveDesign(buyer,draftBody);design=cp.owned(created.id,buyer);design.demoKey='custom-print-v1';}
  for(const target of ['WAITING_PAYMENT','WAITING_STAFF_REVIEW','WAITING_CUSTOMER_APPROVAL','QUEUED','QUALITY_CHECK','SHIPPED','DELIVERED']){
    const requestKey=`demo-custom-v1-${target}`;if(db.orders.all().some(o=>o.requestKey===requestKey))continue;
    const items=[{productId:p.id,variantId:variant.id,itemType:'custom',designRevisionId:design.revisionId,qty:1,qualityAcknowledged:true}];
    const quote=response();await orders.postQuote({user:buyer,body:{items}},quote);
    const res=response();await orders.post({user:buyer,body:{items,acceptedTotal:quote.value.total,requestKey,payMethod:'cod',address:{fullName:'Khách demo — không giao thật',phone:'0901234567',provinceCode:'01',wardCode:'00004',line1:'Địa chỉ minh họa lớp học'}}},res);
    const order=db.orders.byId(res.value.id);order.demo=true;
    const change=async status=>admin.putOrdersIdStatus({user:staff,params:{id:order.id},body:{status,note:'Mốc minh họa lớp học — không có giao dịch/vận chuyển thật'}},response());
    const job=cp.jobs(order)[0];
    if(target==='WAITING_PAYMENT')continue;
    await change('confirmed');if(target==='WAITING_STAFF_REVIEW')continue;
    cp.review(job,staff,{decision:'approve'});await require('./print-export').generate(job);if(target==='WAITING_CUSTOMER_APPROVAL')continue;
    cp.approve(job,buyer,{proofId:job.proof.id,hash:job.proof.hash,acknowledged:true});if(target==='QUEUED')continue;
    cp.transition(job,staff,{status:'PRINTING'});cp.transition(job,staff,{status:'QUALITY_CHECK'});if(target==='QUALITY_CHECK')continue;
    cp.transition(job,staff,{status:'PACKED'});await change('ready_to_ship');
    await admin.putOrdersIdShipping({user:staff,params:{id:order.id},body:{carrier:'Mô phỏng lớp học — không vận chuyển thật',trackingNumber:`DEMO-NOT-LIVE-${target}`}},response());
    await change('shipped');if(target==='SHIPPED')continue;
    await change('delivered');
    order.payment.demo=true;
    cp.all('reviews').push({id:'review-custom-demo-v1',userId:buyer.id,productId:p.id,variantId:variant.id,orderId:order.id,orderLineId:order.items[0].lineId,rating:5,title:'Đánh giá minh họa',comment:'Dữ liệu demo lớp học — mẫu in đúng thiết kế.',moderationStatus:'published',verifiedPurchase:true,history:[],createdAt:cp.now()});
  }
  await cp.flushNotifications();
  console.log('Demo đã sẵn sàng: draft, 7 trạng thái đơn/xưởng, review và outbox. Chạy lại không tạo trùng.');
}
if(require.main===module)db.connect().then(()=>db.run(seedDemo)).catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.close());
module.exports={seedDemo};
