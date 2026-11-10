const {test,expect}=require('@playwright/test');
test.beforeEach(async({page})=>{page.setDefaultTimeout(15000);page.on('pageerror',error=>{throw error;});});
const trigger=page=>page.getByRole('button',{name:'Tỉnh/Thành phố, Phường/Xã *',exact:true});
async function selectProvince(page,query,name){
  await page.getByRole('combobox',{name:'Tìm tỉnh/thành phố'}).fill(query);
  await page.getByRole('option',{name,exact:true}).click();
}
async function selectHanoi(page){
  await trigger(page).click();
  await selectProvince(page,'hanoi','Thành phố Hà Nội');
  await page.getByRole('combobox',{name:'Tìm phường/xã'}).fill('ba dinh');
  await page.getByRole('option',{name:'Phường Ba Đình',exact:true}).click();
}
async function login(page){
  await page.goto('/login');await page.getByLabel('Email',{exact:true}).fill('khach@velathier.vn');
  await page.getByLabel('Mật khẩu',{exact:true}).fill('khach123');await page.getByRole('button',{name:'Đăng nhập',exact:true}).click();
  await expect(page).not.toHaveURL(/\/login/);
}
test('TC01–06,15,16 searchable two-level selection and keyboard',async({page},info)=>{
  await page.goto('/checkout');await trigger(page).click();
  await expect(page.getByRole('option')).toHaveCount(34);
  const search=page.getByRole('combobox',{name:'Tìm tỉnh/thành phố'});
  await search.fill('da nang');await expect(page.getByRole('option',{name:'Thành phố Đà Nẵng',exact:true})).toBeVisible();
  for(const text of ['ha noi','hanoi',' HÀ   NỘI ']){await search.fill(text);await expect(page.getByRole('option',{name:'Thành phố Hà Nội',exact:true})).toBeVisible();}
  await expect(page.locator('input[name=provinceCode]')).toHaveValue('');
  await search.press('ArrowDown');await search.press('Enter');
  await expect(page.getByRole('tab',{name:'Phường / Xã'})).toHaveAttribute('aria-selected','true');
  const wardSearch=page.getByRole('combobox',{name:'Tìm phường/xã'});
  await wardSearch.fill('hoan kiem');await expect(page.getByRole('option',{name:'Phường Hoàn Kiếm',exact:true})).toBeVisible();
  await wardSearch.fill('zzzznotexisting');await expect(page.getByText('Không có kết quả phù hợp.')).toBeVisible();
  await wardSearch.fill('ba dinh');await wardSearch.press('ArrowUp');await wardSearch.press('Enter');
  await expect(trigger(page)).toBeFocused();await expect(trigger(page)).toContainText('Phường Ba Đình, Thành phố Hà Nội');
  await expect(page.locator('input[name=provinceCode]')).toHaveValue('01');await expect(page.locator('input[name=wardCode]')).toHaveValue('00004');
  await trigger(page).click();await page.getByRole('tab',{name:'Tỉnh / TP'}).click();
  await selectProvince(page,'ho chi minh','Thành phố Hồ Chí Minh');
  await expect(page.locator('input[name=wardCode]')).toHaveValue('');await expect(page.locator('input[name=provinceCode]')).toHaveValue('79');
  await expect(page.getByRole('option').first()).toBeVisible();
  const box=await page.getByRole('dialog',{name:'Chọn địa chỉ Việt Nam'}).boundingBox();
  const viewport=page.viewportSize();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);expect(box.y+box.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({path:`server/private/browser-results/${info.project.name}-address-selector.png`});
  await page.getByRole('combobox').press('Escape');await expect(trigger(page)).toBeFocused();
  await trigger(page).click();await page.getByRole('heading',{name:'Đặt hàng không cần tài khoản'}).click();await expect(page.getByRole('dialog',{name:'Chọn địa chỉ Việt Nam'})).toHaveCount(0);
});

test('TC13–14 failed request retries and late response cannot overwrite new province',async({page})=>{
  let failed=false;
  await page.route('**/api/orders/locations',route=>{if(!failed){failed=true;return route.fulfill({status:503,json:{error:'Temporary test outage'}});}return route.continue();});
  await page.goto('/checkout');await page.getByLabel('Họ tên',{exact:true}).fill('Tên được giữ');await trigger(page).click();
  await expect(page.getByText('Không tải được danh mục địa chỉ. Vui lòng thử lại.')).toBeVisible();await page.getByRole('button',{name:'Thử lại',exact:true}).click();
  await expect(page.getByRole('option')).toHaveCount(34);
  let release;const held=new Promise(resolve=>release=resolve);let started;const began=new Promise(resolve=>started=resolve);
  await page.route('**/api/orders/locations/01/wards',async route=>{started();await held;await route.continue();});
  await selectProvince(page,'ha noi','Thành phố Hà Nội');await began;
  await expect(page.getByText('Đang tải danh mục…')).toBeVisible();
  await page.getByRole('tab',{name:'Tỉnh / TP'}).click();await selectProvince(page,'ho chi minh','Thành phố Hồ Chí Minh');
  await expect(page.getByRole('option',{name:'Phường Sài Gòn',exact:true})).toBeVisible();
  const late=page.waitForResponse(r=>r.url().endsWith('/locations/01/wards'));release();await late;
  await expect(page.getByRole('option',{name:'Phường Ba Đình',exact:true})).toHaveCount(0);
  await expect(page.getByRole('option',{name:'Phường Sài Gòn',exact:true})).toBeVisible();
  await page.getByRole('option',{name:'Phường Sài Gòn',exact:true}).click();
  await expect(page.getByLabel('Họ tên',{exact:true})).toHaveValue('Tên được giữ');
});

test('TC09–12 account add/edit, legacy display and checkout address dialog',async({page},info)=>{
  await login(page);await page.goto('/account');await page.getByRole('tab',{name:'Địa chỉ',exact:true}).click();
  // Legacy address remains readable, but editing it cannot silently guess a ward.
  await page.getByRole('button',{name:'Sửa',exact:true}).first().click();
  await expect(page.getByText(/Địa chỉ cũ chưa xác định/)).toBeVisible();
  await expect(page.locator('input[name=wardCode]')).toHaveValue('');
  await page.getByRole('button',{name:'Hủy',exact:true}).click();
  await page.getByRole('button',{name:'Thêm địa chỉ',exact:true}).click();
  const line=`12 Address ${info.project.name}`;
  await page.getByLabel('Địa chỉ chi tiết *',{exact:true}).fill(line);await selectHanoi(page);
  await page.getByRole('checkbox',{name:'Đặt làm địa chỉ mặc định'}).check();
  const created=page.waitForResponse(r=>r.url().endsWith('/api/auth/addresses')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Lưu địa chỉ',exact:true}).click();const address=await (await created).json();
  expect(address).toMatchObject({provinceCode:'01',wardCode:'00004',isDefault:true});
  const card=page.locator('div.rounded-lg.border').filter({has:page.getByText(`${line}, Phường Ba Đình, Thành phố Hà Nội`,{exact:true})});
  await card.getByRole('button',{name:'Sửa',exact:true}).click();await expect(trigger(page)).toContainText('Phường Ba Đình, Thành phố Hà Nội');
  await trigger(page).click();await page.getByRole('combobox',{name:'Tìm phường/xã'}).fill('ngoc ha');await page.getByRole('option',{name:'Phường Ngọc Hà',exact:true}).click();
  await page.getByRole('button',{name:'Lưu địa chỉ',exact:true}).click();await expect(page.getByText(`${line}, Phường Ngọc Hà, Thành phố Hà Nội`,{exact:true})).toBeVisible();
  const products=await (await page.request.get('/api/products')).json(),p=products.find(p=>p.variants.some(v=>v.stock>0)),v=p.variants.find(v=>v.stock>0);
  await page.evaluate(({p,v})=>localStorage.setItem('vela_cart:user:'+JSON.parse(localStorage.getItem('vela_user')).id,JSON.stringify([{key:v.id,productId:p.id,variantId:v.id,title:p.title,color:v.color,size:v.size,img:p.img,price:p.price,qty:1,maxStock:v.stock}])),{p,v});
  await page.goto('/checkout');await expect(page.locator('input[name=address]:checked')).toHaveCount(1);
  await expect(page.locator('label').filter({has:page.locator('input[name=address]:checked')})).toContainText(line);
  await page.getByRole('radio',{name:/VNPay/}).check();
  await page.getByRole('textbox',{name:'Mã giảm giá',exact:true}).fill('WELCOME10');
  await page.getByRole('button',{name:'Áp dụng',exact:true}).click();
  await expect(page.getByRole('button',{name:'Bỏ mã giảm giá',exact:true})).toBeVisible();
  const cartBefore=await page.evaluate(()=>localStorage.getItem('vela_cart:user:'+JSON.parse(localStorage.getItem('vela_user')).id));
  await page.getByRole('button',{name:'Thêm địa chỉ',exact:true}).click();
  await page.getByLabel('Địa chỉ chi tiết *',{exact:true}).fill('99 Checkout Street');await selectHanoi(page);
  await trigger(page).click();await page.getByRole('combobox').press('Escape');
  await expect(page.getByRole('dialog',{name:'Thêm địa chỉ giao hàng',exact:true})).toBeVisible();
  await expect(trigger(page)).toBeFocused();
  await page.getByRole('button',{name:'Lưu địa chỉ',exact:true}).click();
  await expect(page.locator('label').filter({has:page.locator('input[name=address]:checked')})).toContainText('99 Checkout Street');
  await expect(page.getByRole('radio',{name:/VNPay/})).toBeChecked();
  await expect(page.getByRole('button',{name:'Bỏ mã giảm giá',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>localStorage.getItem('vela_cart:user:'+JSON.parse(localStorage.getItem('vela_user')).id))).toBe(cartBefore);
});
