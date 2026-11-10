const {test,expect}=require('@playwright/test');
const mongoose=require('mongoose');
test('SRS Guest three positions → OTP checkout → review → DONE',async({page,browser},info)=>{
  page.on('pageerror',e=>{throw e;});
  const login=await page.request.post('/api/auth/login',{data:{email:'staff@velathier.vn',password:'staff123'}});expect(login.ok()).toBeTruthy();const auth=await login.json(),headers={Authorization:`Bearer ${auth.token}`};
  const cfg=await (await page.request.get('/api/products/blank-oversized/print-options')).json();
  if(cfg.workflowMode!=='srs'){
    const positions=Object.fromEntries(['FRONT','BACK','LEFT_CHEST'].map(p=>[p,{...(p==='LEFT_CHEST'?{enabled:true,x:.57,y:.28,width:.12,height:.096,widthMM:90,heightMM:90}:cfg.areas[p==='BACK'?'back':'front']),textRate:30000,imageRate:50000,maxChars:p==='BACK'?20:12}]));
    const saved=await page.request.put('/api/admin/print-settings/blank-oversized',{headers,data:{...cfg,workflowMode:'srs',positions}});expect(saved.ok(),await saved.text()).toBeTruthy();
  }
  await page.goto('/product/blank-oversized');await page.getByRole('link',{name:'Tự thiết kế áo',exact:true}).click();await expect(page).toHaveURL(/designs\/new/);
  await page.getByRole('button',{name:'Thêm / thay bằng chữ',exact:true}).click();
  const start=await page.evaluate(()=>performance.now());await page.getByLabel('Nội dung chữ').fill('Việt Nam');const elapsed=await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(performance.now())))));console.log(`MEASURE preview input+2frames ${info.project.name}: ${(elapsed-start).toFixed(1)} ms`);
  await page.getByRole('button',{name:'Ngực trái',exact:true}).click();await page.getByRole('button',{name:'Thêm / thay bằng chữ',exact:true}).click();await page.getByLabel('Nội dung chữ').fill('Xin chào');
  await page.getByRole('button',{name:'Mặt sau',exact:true}).click();await page.getByRole('checkbox').first().check();await page.locator('input[type=file]').setInputFiles('assets/img/demo/artwork-1800.png');await expect(page.getByRole('button',{name:'Lưu bản nháp',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Lưu bản nháp',exact:true}).click();await expect(page.getByRole('button',{name:'Thêm vào giỏ',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`server/private/browser-results/${info.project.name}-srs-studio.png`,fullPage:true});
  await page.getByRole('button',{name:'Thêm vào giỏ',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Đã thêm mẫu in vào giỏ'}).first()).toBeVisible();
  const item=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('vela_cart:guest'))[0]);expect(item.img).toContain('/preview');
  await page.goto('/checkout');await expect(page.getByText('Đặt hàng không cần tài khoản',{exact:true})).toBeVisible();
  const email=`srs-${info.project.name}-${Date.now()}@example.test`;
  await page.getByLabel('Họ tên',{exact:true}).fill('Khách Kiểm Thử');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Số điện thoại').fill('0901234567');await page.getByLabel('Địa chỉ chi tiết').fill('123 Demo Street');await page.getByLabel('Tỉnh/thành').selectOption({index:1});await expect(page.getByLabel('Phường/xã').locator('option')).not.toHaveCount(1);await page.getByLabel('Phường/xã').selectOption({index:1});
  await page.getByRole('button',{name:'Gửi mã xác minh email',exact:true}).click();await expect(page.getByText(/Vui lòng kiểm tra hộp thư/)).toBeVisible();
  await mongoose.connect(process.env.MONGO_URI);let code;try{const emailRecord=await mongoose.connection.db.collection('emails').findOne({to:email,template:'guestCheckout'});code=emailRecord.html.match(/>\s*(\d{6})\s*</)[1];}finally{await mongoose.disconnect();}
  await page.getByLabel('Mã OTP',{exact:true}).fill(code);await page.getByRole('button',{name:'Xác minh mã',exact:true}).click();await expect(page.getByText('Email đã xác minh cho lần đặt hàng này.')).toBeVisible();
  const created=page.waitForResponse(r=>r.url().endsWith('/api/orders')&&r.request().method()==='POST');await page.getByRole('button',{name:'Đặt hàng COD',exact:true}).click();const response=await created;expect(response.status(),await response.text()).toBe(201);const order=await response.json();
  expect(order.items[0].priceBreakdown.printFee).toBe(110000);
  const confirmed=await page.request.put(`/api/admin/orders/${order.id}/status`,{headers,data:{status:'confirmed'}});expect(confirmed.ok()).toBeTruthy();
  const ctx=await browser.newContext({baseURL:process.env.TEST_BASE_URL,viewport:info.project.use.viewport});const staff=await ctx.newPage();await staff.goto('/login');await staff.getByLabel('Email',{exact:true}).fill('staff@velathier.vn');await staff.getByLabel('Mật khẩu',{exact:true}).fill('staff123');await staff.getByRole('button',{name:'Đăng nhập',exact:true}).click();await expect(staff).not.toHaveURL(/\/login/);await staff.goto('/admin');await staff.getByRole('button',{name:'Xưởng in',exact:true}).click();const card=staff.locator('article').filter({hasText:order.id});
  await card.getByRole('button',{name:'Duyệt thiết kế',exact:true}).click();await expect(card.getByRole('button',{name:'Đang in',exact:true})).toBeVisible();await card.getByRole('button',{name:'Đang in',exact:true}).click();await card.getByRole('button',{name:'Kiểm tra chất lượng',exact:true}).click();await card.getByRole('button',{name:'Hoàn tất in',exact:true}).click();await expect(card.getByText('Hoàn tất in',{exact:true}).first()).toBeVisible();
  const final=await (await page.request.get(`/api/orders/guest/${order.id}`)).json();expect(final.status).toBe('ready_to_ship');await page.reload();await expect(page.getByText('Hoàn tất in',{exact:true}).first()).toBeVisible();await page.screenshot({path:`server/private/browser-results/${info.project.name}-srs-order.png`,fullPage:true});await ctx.close();
});
