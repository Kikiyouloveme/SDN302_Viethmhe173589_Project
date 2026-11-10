const {test,expect}=require('@playwright/test');
test.beforeEach(async({page})=>{page.on('pageerror',error=>{throw error;});page.setDefaultTimeout(15000);});
async function login(page,email,password){await page.goto('/login');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Mật khẩu',{exact:true}).fill(password);const response=page.waitForResponse(r=>r.url().endsWith('/api/auth/login')&&r.request().method()==='POST');await page.getByRole('button',{name:'Đăng nhập',exact:true}).click();expect((await response).status()).toBe(200);await expect(page).not.toHaveURL(/\/login/);}
async function api(page,method,url,data){const token=await page.evaluate(()=>localStorage.getItem('vela_token'));const r=await page.request.fetch(url,{method,data,headers:{Authorization:`Bearer ${token}`}});expect(r.ok(),await r.text()).toBeTruthy();return r.json();}
test('Customer studio → Staff SRS review → production → delivery → review',async({page,browser},testInfo)=>{
  await login(page,'khach@velathier.vn','khach123');
  await page.goto('/product/blank-regular');await page.getByRole('link',{name:'Tự thiết kế áo',exact:true}).click();
  await page.getByRole('button',{name:'Thêm / thay bằng chữ',exact:true}).click();
  await page.getByLabel('Nội dung chữ').fill(`E2E ${testInfo.project.name}`);
  await page.getByRole('button',{name:'Lưu bản nháp',exact:true}).click();
  await expect(page.getByRole('button',{name:'Thêm vào giỏ',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
  await page.screenshot({path:`server/private/browser-results/${testInfo.project.name}-studio.png`,fullPage:true});
  await page.getByRole('button',{name:'Thêm vào giỏ',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Đã thêm mẫu in vào giỏ'}).first()).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('vela_cart:user:'+JSON.parse(localStorage.getItem('vela_user')).id)||'[]').length)).toBeGreaterThan(0);
  await page.goto('/checkout');
  const created=page.waitForResponse(r=>r.url().endsWith('/api/orders')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Đặt hàng',exact:true}).click();const response=await created;expect(response.status()).toBe(201);const order=await response.json();
  const context=await browser.newContext({baseURL:process.env.TEST_BASE_URL,viewport:testInfo.project.use.viewport});const staff=await context.newPage();
  await login(staff,'staff@velathier.vn','staff123');
  // Confirmation/shipping use the same public Staff APIs; review and production controls are exercised in UI.
  await api(staff,'PUT',`/api/admin/orders/${order.id}/status`,{status:'confirmed'});
  await staff.goto('/admin');await staff.getByRole('button',{name:'Xưởng in',exact:true}).click();
  const card=staff.locator('article').filter({hasText:order.id});
  await card.getByRole('button',{name:'Duyệt thiết kế',exact:true}).click();
  await expect(card.getByText('Đã duyệt thiết kế',{exact:true}).first()).toBeVisible();
  await page.goto(`/orders/${order.id}`);
  // Bản xuất nằm trong khối thu gọn — mở ra trước khi kiểm tra
  await page.locator('details').first().evaluate(d=>{d.open=true;});
  await expect(page.getByAltText('Bản xuất in đúng phiên bản')).toBeVisible();
  await staff.getByRole('button',{name:'Làm mới',exact:true}).click();
  for(const name of ['Đang in','Kiểm tra chất lượng','Hoàn tất in'])await card.getByRole('button',{name,exact:true}).click();
  // Job DONE makes the order ready automatically; regular items in a mixed order are confirmed first.
  await expect.poll(async()=>{const o=await api(staff,'GET',`/api/orders/${order.id}`);return o.status;}).toBe('ready_to_ship');
  await api(staff,'PUT',`/api/admin/orders/${order.id}/shipping`,{carrier:'Demo E2E manual',trackingNumber:`TEST-${order.id}`});
  await api(staff,'PUT',`/api/admin/orders/${order.id}/status`,{status:'shipped'});
  await page.reload();await expect(page.getByText('TEST-'+order.id,{exact:false}).first()).toBeVisible();
  await api(staff,'PUT',`/api/admin/orders/${order.id}/status`,{status:'delivered'});
await page.goto('/product/blank-regular');await page.getByLabel('Lần mua').selectOption({label:`${order.id} · ${order.items[0].color}/${order.items[0].size}`});
  await page.getByLabel('Trải nghiệm của bạn').fill(`Kiểm thử trình duyệt ${testInfo.project.name}: mẫu đã nhận.`);await page.getByRole('button',{name:'Lưu đánh giá',exact:true}).click();
  await expect(page.getByText(`Kiểm thử trình duyệt ${testInfo.project.name}: mẫu đã nhận.`,{exact:true})).toBeVisible();
  await page.screenshot({path:`server/private/browser-results/${testInfo.project.name}-review.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
  await context.close();
});
test('VNPay link failure survives refresh without duplicate order or lost cart',async({page})=>{
  await login(page,'khach@velathier.vn','khach123');
  const products=await api(page,'GET','/api/products'),product=products.find(p=>p.variants.some(v=>v.stock>0)),variant=product.variants.find(v=>v.stock>0);
  await page.evaluate(({p,v})=>localStorage.setItem('vela_cart:user:'+JSON.parse(localStorage.getItem('vela_user')).id,JSON.stringify([{key:v.id,productId:p.id,variantId:v.id,title:p.title,color:v.color,size:v.size,img:p.img,price:p.price,qty:1,maxStock:v.stock}])),{p:product,v:variant});
  await page.goto('/checkout');await page.getByRole('radio',{name:/VNPay/}).check();
  let creates=0;page.on('request',r=>{if(r.url().endsWith('/api/orders')&&r.method()==='POST')creates++;});
  await page.route('**/api/payment/vnpay/create',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Lỗi liên kết thanh toán kiểm thử'})}));
  await page.getByRole('button',{name:/Thanh toán VNPay/}).click();
  await expect(page.getByRole('link',{name:'Tiếp tục / thử lại thanh toán'})).toBeVisible();
  const href=await page.getByRole('link',{name:'Tiếp tục / thử lại thanh toán'}).getAttribute('href');
  await page.reload();await expect(page.getByRole('link',{name:'Tiếp tục / thử lại thanh toán'})).toHaveAttribute('href',href);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('vela_cart:user:'+JSON.parse(localStorage.getItem('vela_user')).id)).length)).toBe(1);expect(creates).toBe(1);
  await page.getByRole('link',{name:'Tiếp tục / thử lại thanh toán'}).click();
  await page.getByRole('button',{name:'Thanh toán qua VNPay',exact:true}).click();
  await expect(page.getByText('Lỗi liên kết thanh toán kiểm thử',{exact:true}).first()).toBeVisible();expect(creates).toBe(1);
  await page.getByRole('button',{name:'Thử lại thanh toán trên đơn này'}).click();await expect(page.getByText('Lỗi liên kết thanh toán kiểm thử',{exact:true}).first()).toBeVisible();expect(creates).toBe(1);
  await page.unroute('**/api/payment/vnpay/create');
  await page.getByRole('button',{name:'Thử lại thanh toán trên đơn này'}).click();
  await page.getByRole('link',{name:'Thanh toán thành công',exact:true}).click();
  await expect(page.getByText('Thanh toán thành công qua VNPay',{exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('vela_cart:user:'+JSON.parse(localStorage.getItem('vela_user')).id)||'[]').length)).toBe(0);
  expect(creates).toBe(1);
});
test('Studio upload to another position keeps pending text edit',async({page})=>{
  await login(page,'khach@velathier.vn','khach123');await page.goto('/product/blank-regular');await page.getByRole('link',{name:'Tự thiết kế áo',exact:true}).click();
  await page.getByRole('button',{name:'Thêm / thay bằng chữ',exact:true}).click();
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/designs')&&r.request().method()==='POST');await page.getByRole('button',{name:'Lưu bản nháp',exact:true}).click();const design=await (await saved).json();
  let release;const held=new Promise(r=>release=r);let started;const began=new Promise(r=>started=r);
  await page.route('**/api/designs/'+design.id,async route=>{if(route.request().method()==='PATCH'){started();await held;}await route.continue();});
  // Sửa chữ ở MẶT TRƯỚC rồi để autosave bị giữ lại
  await page.getByLabel('Nội dung chữ').fill('Giữ chữ mới');await began;
  // Trong lúc autosave còn đang chờ, tải ảnh cho NGỰC TRÁI (vị trí khác)
  await page.getByRole('button',{name:'Ngực trái',exact:true}).click();
  await page.getByRole('checkbox').filter({visible:true}).first().check();
  await page.locator('input[type=file]').setInputFiles('assets/img/demo/artwork-1800.png');release();
  // SRS: một nội dung mỗi vị trí — MẶT TRƯỚC (chữ) và NGỰC TRÁI (ảnh) cùng tồn tại
  await expect.poll(async()=>{const d=await api(page,'GET','/api/designs/'+design.id);return d.revision.snapshot.layers.front.length;}).toBe(2);
  const final=await api(page,'GET','/api/designs/'+design.id);
  const front=final.revision.snapshot.layers.front;
  expect(front.find(l=>l.position==='FRONT').text).toBe('Giữ chữ mới');
  expect(front.find(l=>l.position==='LEFT_CHEST').type).toBe('image');
});

test('Cart isolation across accounts, logout and reload',async({page})=>{
  await login(page,'khach@velathier.vn','khach123');
  const products=await api(page,'GET','/api/products'),p=products.find(p=>p.variants.some(v=>v.stock>0)),v=p.variants.find(v=>v.stock>0);
  await page.evaluate(({p,v})=>{
    const key='vela_cart:user:'+JSON.parse(localStorage.getItem('vela_user')).id;
    localStorage.setItem(key,JSON.stringify([{key:v.id,productId:p.id,variantId:v.id,title:'PRIVATE_CART_A',color:v.color,size:v.size,img:p.img,price:p.price,qty:1,maxStock:v.stock}]));
  },{p,v});
  await page.goto('/checkout');await expect(page.getByText('PRIVATE_CART_A',{exact:true}).first()).toBeVisible();
  const loginB=await page.request.post('/api/auth/login',{data:{email:'staff@velathier.vn',password:'staff123'}});expect(loginB.ok()).toBeTruthy();
  const b=await loginB.json();
  await page.evaluate(b=>{localStorage.setItem('vela_token',b.token);localStorage.setItem('vela_user',JSON.stringify(b.user));window.dispatchEvent(new StorageEvent('storage',{key:'vela_token'}));},b);
  await expect(page.getByText('PRIVATE_CART_A',{exact:true})).toHaveCount(0);
  await expect(page.locator('h1')).toContainText('Giỏ hàng trống');
  await page.evaluate(()=>{localStorage.removeItem('vela_token');localStorage.removeItem('vela_user');window.dispatchEvent(new StorageEvent('storage',{key:'vela_token'}));});
  await expect(page.getByRole('heading',{name:'Đặt hàng không cần tài khoản'})).toBeVisible();
  await expect(page.getByText('PRIVATE_CART_A',{exact:true})).toHaveCount(0);
  await page.reload();await expect(page.getByText('PRIVATE_CART_A',{exact:true})).toHaveCount(0);
  await login(page,'khach@velathier.vn','khach123');await page.goto('/checkout');await expect(page.getByText('PRIVATE_CART_A',{exact:true}).first()).toBeVisible();
});
