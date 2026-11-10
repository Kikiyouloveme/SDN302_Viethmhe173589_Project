const mongoose = require('mongoose');
// Index/collection initialization is explicitly awaited after connect().
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);
const { Schema } = mongoose;

// Giữ business id hiện có (u_admin, DH1001, tee-boxy-01) để không phá URL/đơn cũ.
// MongoDB vẫn cấp _id ObjectId; virtual populate liên kết qua trường id có unique index.
const nonnegative = { type: Number, min: 0, validate: (v) => v == null || Number.isFinite(v) };
const integer = { type: Number, min: 0, validate: (v) => v == null || Number.isSafeInteger(v) };
const options = { strict: false, versionKey: false, id: false, minimize: false };
const embedded = (fields) => new Schema(fields, { ...options, _id: false });
function schema(fields) {
  return new Schema({ id: { type: String, required: true, unique: true }, ...fields }, options);
}
const variant = embedded({
  id: { type: String, required: true }, sku: String,
  color: { type: String, required: true }, size: { type: String, required: true },
  stock: { ...integer, required: true }, active: Boolean,
});
const user = schema({
  name: { type: String, required: true },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },
  pass: { type: String, required: true },
  role: { type: String, enum: ['customer', 'staff', 'admin'], required: true },
  emailVerified: Boolean, tokensValidFrom: Number, phone: String,
  addresses: [embedded({ id: String, fullName: String, phone: String, provinceCode: String, province: String, wardCode: String, ward: String, district: String, line1: String, note: String, isDefault: Boolean, createdAt: String, updatedAt: String })],
});
const product = schema({
  title: { type: String, required: true, maxlength: 200 },
  price: { ...nonnegative, required: true }, compareAtPrice: nonnegative,
  cat: { type: String, enum: ['tops', 'bottoms', 'outerwear', 'accessories'], required: true },
  active: Boolean, tags: [String], colors: [String], sizes: [String],
  variants: { type: [variant], validate: (v) => v.length > 0 },
});
product.index({ active: 1, cat: 1 });
const order = schema({
  userId: { type: String, default: null, index: true }, customerEmail: String,
  items: [embedded({ productId: String, variantId: String, qty: { ...integer, min: 1, required: true }, price: nonnegative })],
  total: { ...nonnegative, required: true }, subtotal: nonnegative,
  discount: nonnegative, shippingFee: nonnegative,
  payMethod: { type: String, enum: ['cod', 'vnpay', 'vietqr'] },
  status: { type: String, required: true },
});
order.virtual('customer', { ref: 'User', localField: 'userId', foreignField: 'id', justOne: true });
order.index({userId:1,requestKey:1},{unique:true,partialFilterExpression:{requestKey:{$type:'string'}}});
order.virtual('productDetails', { ref: 'Product', localField: 'items.productId', foreignField: 'id' });
const voucher = schema({
  code: { type: String, required: true, unique: true, uppercase: true },
  percentage: { type: Number, min: 0, max: 100, required: true },
  usedCount: integer, active: Boolean,
});
const returns = schema({
  orderId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  type: { type: String, enum: ['return', 'exchange'] }, refundAmount: nonnegative,
});
returns.virtual('order', { ref: 'Order', localField: 'orderId', foreignField: 'id', justOne: true });
const otp = new Schema({
  email: { type: String, required: true }, purpose: { type: String, required: true },
  codeHash: String, salt: String, expiresAt: Number, attempts: integer,
  ticket: String, ticketExpiresAt: Number, lastSentAt: Number,
}, options);
otp.index({ email: 1, purpose: 1 }, { unique: true });
const review = schema({ userId: { type: String, required: true }, productId: { type: String, required: true, index: true }, variantId: String, orderId: { type: String, required: true }, orderLineId: { type: String, required: true }, rating: { type: Number, min: 1, max: 5, validate: Number.isInteger, required: true }, title: String, comment: { type: String, required: true, maxlength: 2000 }, moderationStatus: { type: String, enum: ['published', 'hidden'], required: true } });
review.index({ orderId: 1, orderLineId: 1 }, { unique: true });
const definitions = { reviews: ['ProductReview', review],
  mailOutbox: ['MailOutbox', schema({eventKey:{type:String,required:true,unique:true},status:String,attempts:integer,nextAttemptAt:Number,payload:Schema.Types.Mixed,emailId:String})],
  designs: ['CustomDesign', schema({ userId: { type: String, required: true, index: true }, productId: String, variantId: String, currentVersion: integer })],
  designRevisions: ['DesignRevision', schema({ designId: { type: String, required: true, index: true }, version: integer, snapshot: Schema.Types.Mixed, hash: String })],
  designAssets: ['DesignAsset', schema({ ownerId: { type: String, required: true, index: true }, storageKey: String, width: integer, height: integer, sha256: String })],
  printSettings: ['PrintSettings', schema({ productId: { type: String, required: true, index: true }, version: integer, enabled: Boolean })],
  printJobs: ['PrintJob', schema({ orderId: { type: String, required: true, index: true }, orderLineId: { type: String, required: true, unique: true }, status: String, history: [Schema.Types.Mixed] })],
  sizeCharts: ['SizeChart', schema({ productId: { type: String, required: true, unique: true }, version: integer })],
  notifications: ['Notification', schema({ eventKey: { type: String, required: true, unique: true }, orderId: String, status: String, attempts: integer })],
  users: ['User', user], products: ['Product', product], orders: ['Order', order],
  vouchers: ['Voucher', voucher], returns: ['Return', returns], otps: ['Otp', otp],
  emails: ['Email', schema({ to: String, subject: String, html: String })],
  messages: ['Message', schema({ email: String, message: String })],
};
const models = Object.fromEntries(Object.entries(definitions).map(([collection, [name, definition]]) =>
  [collection, mongoose.model(name, definition, collection)]));
models.designRevisions.schema.index({designId:1,version:1},{unique:true});
models.printSettings.schema.index({productId:1,version:1},{unique:true});
models.metadata = mongoose.model('Metadata', new Schema({
  _id: String, schemaVersion: Number, counters: { order: Number, return: Number },
}, { versionKey: false }), 'metadata');
module.exports = models;
